import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IGNORED_DIRS } from "./types.ts";

// The OS sandbox's rules, as data. The same policy is enforced twice: by the operating system on
// bash (Seatbelt or bubblewrap), and by HostFs on the file tools, which run inside arch-code and
// so outside the OS sandbox. Every path is a REAL path (symlinks resolved): on macOS /tmp is
// really /private/tmp, and the OS checks real paths.
export interface FsPolicy {
  project: string; // your project folder: the agent works here, live
  writable: string[]; // writes are allowed only under these
  readOnly: string[]; // ...except under these, which nothing in the sandbox may change
  hidden: string[]; // nothing in the sandbox may read or write these
}

// Keys to other places: if the agent can read these, it can act as you elsewhere.
export const HOME_SECRETS = [
  ".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".azure", ".kube", ".docker",
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".config/git/credentials", "Library/Keychains",
];

// .env, .env.local, .env.production... but not .env.example and friends (templates, meant to be read).
export const SECRET_FILE = /^\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$/;

// arch-code's own .env, next to package.json: your model provider's API key.
const ARCH_DOTENV = fileURLToPath(new URL("../../.env", import.meta.url));

function real(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function buildPolicy(projectDir: string, options: { cacheDir: string; home?: string }): FsPolicy {
  const project = realpathSync(projectDir);
  const home = options.home ?? homedir();
  const hidden = [...HOME_SECRETS.map((s) => path.join(home, s)), ARCH_DOTENV].map(real).filter((p): p is string => p !== null);
  hidden.push(...findSecretFiles(project));
  // A git hook runs on YOUR machine, outside any sandbox, the next time you commit; git config
  // can run commands too (core.fsmonitor, core.hooksPath). And .arch-code/ holds your permission
  // rules. Changing any of these would be a way out, so they stay read-only.
  const readOnly = [path.join(project, ".git", "hooks"), path.join(project, ".git", "config"), path.join(project, ".arch-code")];
  // A ".git" FILE (a worktree or submodule) points git somewhere else; it must not be repointed.
  if (existsSync(path.join(project, ".git")) && lstatSync(path.join(project, ".git")).isFile()) readOnly.push(path.join(project, ".git"));
  return { project, writable: [project, realpathSync(options.cacheDir)], readOnly, hidden: [...new Set(hidden)] };
}

// .env files anywhere in the project (skipping node_modules and friends), found once at start.
export function findSecretFiles(root: string, maxEntries = 20_000): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || seen > maxEntries) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen++;
      if (e.isDirectory() && !IGNORED_DIRS.includes(e.name)) walk(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && SECRET_FILE.test(e.name)) found.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return found;
}

export const isUnder = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);