import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { ToolError } from "../tools/helpers/types.ts";
import { type FsPolicy, isUnder, SECRET_FILE } from "./policy.ts";
import { type FileInfo, IGNORED_DIRS, type WorkspaceFs } from "./types.ts";

const IGNORED_GLOBS = IGNORED_DIRS.map((d) => `**/${d}/**`);

// Where the model's paths point on this machine's disk.
//   host mode:   no mapping. The model's paths ARE your paths.
//   docker mode: "/workspace/src/app.ts" -> "<project>/.arch-code/sandbox/<id>/src/app.ts".
//                That folder is bind-mounted into the container at /workspace, so the file tools
//                (here, on the host) and bash (in the container) see the very same files.
export interface Mount {
  logical: string; // "/workspace"
  host: string; // the real folder
}

// Three ways to use it:
//   new HostFs()                 host mode: your paths, no limits (the permission gate decides)
//   new HostFs({ policy })       OS sandbox: your paths, but the sandbox's rules apply (policy.ts)
//   new HostFs({ mount })        Docker: the model's /workspace paths, mapped onto the shared folder
export class HostFs implements WorkspaceFs {
  private mount: Mount | null;
  private policy: FsPolicy | null;
  private realRoot: string | null = null; // the mount folder with its own symlinks resolved (macOS: /var -> /private/var)

  constructor(options: { mount?: Mount; policy?: FsPolicy } = {}) {
    this.mount = options.mount ?? null;
    this.policy = options.policy ?? null;
  }

  async stat(p: string): Promise<FileInfo | null> {
    const real = await this.toHost(p);
    try {
      const info = await stat(real);
      return { kind: info.isFile() ? "file" : info.isDirectory() ? "dir" : "other", size: info.size, mtimeMs: info.mtimeMs, mode: info.mode };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err; // EACCES and friends: the real reason, never disguised as "not found"
    }
  }

  async readFile(p: string, signal?: AbortSignal): Promise<Uint8Array> {
    return readFile(await this.toHost(p), { signal });
  }

  // Save atomically: write a temporary file next to the target, then rename it over the target.
  // A crash, a full disk or Esc halfway through leaves the original untouched; you never get half
  // a file. (The trade-off, shared with vim and most editors: the file gets a new inode, so a hard
  // link to it would keep pointing at the old content.)
  async writeFileAtomic(p: string, data: string, options: { mode?: number; signal?: AbortSignal } = {}): Promise<number> {
    const abs = await this.toHost(p, "write");
    const target = await realpath(abs).catch(() => abs); // follow a symlink: replace its target, not the link
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${Date.now()}.arch-code-tmp`);
    try {
      await writeFile(temp, data, { encoding: "utf8", flag: "wx", signal: options.signal });
      if (options.mode !== undefined) await chmod(temp, options.mode & 0o7777); // keep permissions (executable scripts!)
      options.signal?.throwIfAborted(); // last moment to back out cleanly
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => {});
      throw err;
    }
    return (await stat(target)).mtimeMs;
  }

  async mkdirp(p: string): Promise<void> {
    await mkdir(await this.toHost(p, "write"), { recursive: true });
  }

  async listFiles(dir: string, pattern: string): Promise<{ files: string[]; note: string | null }> {
    const cwd = await this.toHost(dir);
    const options = {
      cwd,
      ignore: IGNORED_GLOBS,
      dot: true,
      onlyFiles: true,
      // In a sandbox, never follow symlinks while listing: bash can plant "/workspace/x -> /",
      // and on the host side of the mount that link points at YOUR root folder.
      followSymbolicLinks: this.mount === null && this.policy === null,
    };
    // Whatever the pattern says, only report files inside `dir` (the glob tool already refuses
    // ".." and absolute patterns; this is the second lock on the same door). In the OS sandbox,
    // hidden files (.env, ~/.ssh...) aren't listed either: a name can be a secret too.
    const realDir = this.policy ? await realpath(cwd) : cwd;
    const inside = (f: string) =>
      !path.posix.isAbsolute(f) && !path.posix.normalize(f).startsWith("../") && (!this.policy || !this.isHidden(path.join(realDir, f)));
    try {
      return { files: (await fg(pattern, options)).filter(inside).sort(), note: null };
    } catch (err) {
      // By default fast-glob gives up on the WHOLE search when one folder can't be read.
      // Search the rest instead, and say what was missed.
      const { code, path: where } = err as NodeJS.ErrnoException;
      if (code !== "EACCES" && code !== "EPERM") throw err;
      const files = (await fg(pattern, { ...options, suppressErrors: true })).filter(inside).sort();
      return { files, note: `Some folders couldn't be read and were skipped (permission denied${where ? `, e.g. ${this.toLogical(where)}` : ""}).` };
    }
  }

  // ── containment ──
  // Two checks, because each one alone can be fooled:
  //  1. String math: "/workspace/../../etc/passwd" and "/etc/passwd" are outside. Refuse.
  //  2. The real disk: "/workspace/link" may be a symlink that bash planted, pointing at
  //     "/Users/you/.ssh". The string looks fine; only resolving it on disk shows where it goes.
  // The same real-path check enforces the OS sandbox's policy: no reading hidden files, no
  // writing outside the project or into its read-only parts.
  private async toHost(p: string, access: "read" | "write" = "read"): Promise<string> {
    let abs = p;
    if (this.mount) {
      const { logical, host } = this.mount;
      const rel = path.posix.relative(logical, path.posix.resolve(logical, p));
      if (rel.startsWith("..") || path.posix.isAbsolute(rel)) {
        throw new ToolError(`${p} is outside the workspace. In this sandbox only ${logical} exists; use paths under it.`);
      }
      abs = path.join(host, rel);
      const root = (this.realRoot ??= await realpath(host));
      if (!isUnder(await realTarget(abs), root)) {
        throw new ToolError(`${p} leads outside the workspace (through a symlink). Refusing to follow it.`);
      }
    }
    if (this.policy) {
      const target = await realTarget(abs);
      const { project, writable, readOnly } = this.policy;
      if (this.isHidden(target)) throw new ToolError(`${p} is hidden in the OS sandbox: it holds secrets (keys, tokens, .env). Ask the user if you really need it.`);
      if (access === "write") {
        if (!writable.some((dir) => isUnder(target, dir))) {
          throw new ToolError(`${p} is outside the project. In the OS sandbox Arch can only change files under ${project}.`);
        }
        if (readOnly.some((dir) => isUnder(target, dir))) {
          throw new ToolError(`${p} is read-only in the OS sandbox (git hooks, git config and .arch-code/ could run commands or change permissions outside it).`);
        }
      }
    }
    return abs;
  }

  private isHidden(realPath: string): boolean {
    return SECRET_FILE.test(path.basename(realPath)) || this.policy!.hidden.some((h) => isUnder(realPath, h));
  }

  // For messages: show a host path the way the model knows it.
  private toLogical(hostPath: string): string {
    if (!this.mount) return hostPath;
    const rel = path.relative(this.mount.host, hostPath);
    return rel.startsWith("..") ? hostPath : path.posix.join(this.mount.logical, ...rel.split(path.sep));
  }
}

// Where a path really leads: resolve the deepest part that exists (the rest may be a file we're
// about to create), then put the rest back on.
async function realTarget(abs: string): Promise<string> {
  let probe = abs;
  const rest: string[] = [];
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) return path.join(real, ...rest);
    const parent = path.dirname(probe);
    if (parent === probe) return abs;
    rest.unshift(path.basename(probe));
    probe = parent;
  }
}