import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./process.ts";
import type { ExecutionEnv } from "./types.ts";

// In Docker the agent works on a COPY of your project: your files as they are right now (your
// uncommitted changes included, gitignored files like .env not). When you leave the sandbox, its
// work comes back as a branch, `arch/<session>`, which you review and apply like a colleague's
// pull request. Your working tree is never touched.
//
// Three places, each with one owner:
//   your repo (the source)            yours. arch-code only ever adds an arch/<id> branch to it.
//   .arch-code/sandbox/<id>.git       a bare "staging" clone. Host-only: the agent can't reach it.
//   the workspace (/workspace)        the agent's. Anything in it, .git included, is untrusted.

export interface WorkspaceMeta {
  source: string; // a local repo path or a git URL
  base: string; // the commit the workspace started from
  snapshot: boolean; // base is a snapshot of your uncommitted changes, not a commit of yours
  branch: string; // arch/<first 8 chars of the session id>
  staging: string; // the host-only bare clone
  shipped: string | null; // the last commit handed back, so we don't ship the same thing twice
}

// Which repo does the sandbox get? --repo if given, else the git repo you launched from.
// Not a git repo and no --repo: an empty workspace (and nothing to hand back).
export async function resolveSource(cwd: string, repo: string | undefined): Promise<string | null> {
  if (repo) {
    if (isUrl(repo)) return repo;
    const abs = path.resolve(cwd, repo);
    return (await run("git", ["-C", abs, "rev-parse", "--show-toplevel"]).catch(() => {
      throw new Error(`--repo ${repo} is not a git repository.`);
    })).trim();
  }
  return (await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => null))?.trim() ?? null;
}

export function loadMeta(file: string): WorkspaceMeta | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as WorkspaceMeta) : null;
}

export function saveMeta(file: string, meta: WorkspaceMeta): void {
  writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
}

// Host side, with YOUR git credentials (so private repos work): a bare clone to stage from.
export async function createStaging(source: string, staging: string, sessionId: string): Promise<WorkspaceMeta> {
  await run("git", ["clone", "--quiet", "--bare", source, staging]);
  const head = (await run("git", ["-C", staging, "rev-parse", "HEAD"])).trim();
  const base = isUrl(source) ? head : await snapshotWorkingTree(source, staging, head);
  return { source, base, snapshot: base !== head, branch: `arch/${sessionId.slice(0, 8)}`, staging, shipped: null };
}

// Your uncommitted changes come along. We record your working tree as a commit, inside STAGING:
// your repo, your index and your stash are never touched. A throwaway index file, `git add -A`
// against your folder (which respects .gitignore, so .env stays out), write-tree, commit-tree.
async function snapshotWorkingTree(source: string, staging: string, head: string): Promise<string> {
  const index = path.join(tmpdir(), `arch-code-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, ...IDENTITY };
  const git = (...args: string[]) => run("git", ["--git-dir", staging, "--work-tree", source, ...args], { env });
  // Staging's ignore rules, since git reads them from the --git-dir: yours (.git/info/exclude),
  // plus .arch-code/, which holds your traces and this very staging repo.
  const yours = (await run("git", ["-C", source, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).trim();
  await mkdir(path.join(staging, "info"), { recursive: true });
  await writeFile(path.join(staging, "info", "exclude"), `${existsSync(yours) ? readFileSync(yours, "utf8") : ""}\n.arch-code/\n`);
  try {
    await git("read-tree", head);
    await git("add", "--all");
    const tree = (await git("write-tree")).trim();
    if (tree === (await git("rev-parse", `${head}^{tree}`)).trim()) return head; // nothing uncommitted
    return (await git("commit-tree", tree, "-p", head, "-m", "arch-code: your uncommitted changes, as the session started")).trim();
  } finally {
    await rm(index, { force: true });
  }
}

const IDENTITY = { GIT_AUTHOR_NAME: "arch-code", GIT_AUTHOR_EMAIL: "arch-code@localhost", GIT_COMMITTER_NAME: "arch-code", GIT_COMMITTER_EMAIL: "arch-code@localhost" };
const isUrl = (source: string) => /^[a-z]+:\/\/|^git@/.test(source);

// Fill the workspace from staging. --no-hardlinks matters: a local clone normally SHARES its
// object files with the source (hard links: two names, one file on disk). The agent runs as you
// inside the container, so it could chmod one of those "read-only" objects and rewrite it, and
// that would corrupt your real repo's history. Copies can't do that.
export async function cloneWorkspace(meta: WorkspaceMeta, dir: string): Promise<void> {
  await run("git", ["clone", "--quiet", "--no-hardlinks", meta.staging, dir]);
  if (meta.snapshot) await run("git", ["-C", dir, "reset", "--quiet", "--hard", meta.base]); // start from the snapshot
  // Inside the sandbox "origin" would point at a host path that doesn't exist there. Pushing is
  // the harness's job (hand-back), not the agent's.
  await run("git", ["-C", dir, "remote", "remove", "origin"]);
}

const BUNDLE = ".git/arch-handback.bundle";

// Ship the workspace back as a branch. The careful part is what we DON'T do: run git on the host
// inside the workspace. The agent controls everything in there, .git/config and .git/hooks
// included, and settings like core.fsmonitor or a hook run commands. Host-side git in that folder
// would run the agent's commands on your machine, outside the sandbox: an escape hatch.
// So:
//   1. INSIDE the sandbox: commit any loose changes and pack the new commits into a bundle,
//      a single file holding commits (it's how git moves history around offline).
//   2. Copy the bundle's bytes out through the file layer (which refuses symlink tricks).
//   3. On the host: fetch from the bundle into staging (fetching treats the data as untrusted
//      and runs nothing from it), then push the branch to your repo from staging.
export async function handBack(env: ExecutionEnv, meta: WorkspaceMeta, sessionId: string): Promise<string> {
  const commit = [
    "cd /workspace",
    "git rev-parse --git-dir >/dev/null 2>&1 || { echo NOT_A_REPO; exit 0; }",
    // --no-verify and an empty hooksPath: nothing the agent planted runs, even in its own sandbox.
    'if [ -n "$(git status --porcelain)" ]; then git add -A && git -c core.hooksPath=/dev/null -c user.name=arch-code -c user.email=arch-code@localhost commit --quiet --no-verify -m "arch-code: uncommitted work from session ' +
      sessionId.slice(0, 8) +
      '" >/dev/null; fi',
    "git rev-parse HEAD",
  ].join("\n");
  const head = await sandboxed(env, commit);
  if (head === "NOT_A_REPO") return "Nothing to ship: /workspace is no longer a git repository.";
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`Couldn't read the workspace's commit: ${head.slice(0, 200)}`);
  if (head === meta.base) return "Nothing to ship: no changes since the session started.";
  if (head === meta.shipped) return `Nothing new to ship: ${meta.branch} is already up to date.`;

  // Only the commits staging doesn't have (^base). If the agent rewrote history so that base is
  // gone, fall back to a full bundle.
  await sandboxed(env, `cd /workspace && rm -f ${BUNDLE} && (git bundle create --quiet ${BUNDLE} HEAD ^${meta.base} 2>/dev/null || git bundle create --quiet ${BUNDLE} HEAD) && echo ok`);
  const bytes = await env.fs.readFile(`/workspace/${BUNDLE}`);
  await sandboxed(env, `rm -f /workspace/${BUNDLE}; echo ok`);

  const local = path.join(tmpdir(), `arch-code-${sessionId}-${Date.now()}.bundle`);
  try {
    await writeFile(local, bytes);
    await run("git", ["-C", meta.staging, "-c", "transfer.fsckObjects=true", "fetch", "--quiet", local, `+HEAD:refs/heads/${meta.branch}`]);
  } finally {
    await rm(local, { force: true });
  }
  const shipped = (await run("git", ["-C", meta.staging, "rev-parse", meta.branch])).trim();
  if (shipped !== head) throw new Error(`Hand-back mismatch: workspace is at ${head} but the bundle gave ${shipped}.`);

  const count = (await run("git", ["-C", meta.staging, "rev-list", "--count", `${meta.base}..${meta.branch}`])).trim();
  const stat = (await run("git", ["-C", meta.staging, "diff", "--shortstat", meta.base, meta.branch])).trim() || "no file changes";
  try {
    await run("git", ["-C", meta.staging, "push", "--quiet", "--force", meta.source, `refs/heads/${meta.branch}:refs/heads/${meta.branch}`]);
  } catch (err) {
    return [
      `Saved ${count} commit(s) as ${meta.branch} (${stat}), but couldn't push it to ${meta.source}:`,
      `  ${(err as Error).message.split("\n")[0]}`,
      `Push it yourself: git -C ${meta.staging} push ${meta.source} ${meta.branch}`,
    ].join("\n");
  }
  meta.shipped = head;
  const base = meta.base.slice(0, 8);
  if (isUrl(meta.source)) return `Shipped ${count} commit(s) to branch ${meta.branch} in ${meta.source} (${stat}).\nReview it: git fetch && git diff ${base} origin/${meta.branch}`;
  // From a snapshot, the branch starts with YOUR uncommitted changes as a commit, so merging it
  // would trip over the same changes in your working tree. Applying only Arch's diff doesn't.
  const apply = meta.snapshot ? `git diff --binary ${base} ${meta.branch} | git apply` : `git merge ${meta.branch}`;
  return `Shipped ${count} commit(s) to branch ${meta.branch} in ${meta.source} (${stat}).\nReview it: git diff ${base} ${meta.branch}\nTake it:   ${apply}`;
}

// Run a harness command in the sandbox and return its trimmed output; fail loudly.
async function sandboxed(env: ExecutionEnv, script: string): Promise<string> {
  const result = await env.exec(script, { timeoutS: 120, signal: new AbortController().signal });
  if (result.exitCode !== 0) throw new Error(`Sandbox command failed (exit ${result.exitCode}): ${result.output.trim().slice(0, 300)}`);
  return result.output.trim();
}