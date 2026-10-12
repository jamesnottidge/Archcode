// An ExecutionEnv is WHERE the agent's tools act: your own machine, your machine inside an OS
// sandbox, or a Docker container. Tools never touch the disk or spawn processes directly. They go
// through ctx.env, so swapping the environment moves every tool at once ("swap the set", as Pi
// calls it). You can even swap it in the middle of a session (/sandbox, /docker-sandbox).
//
// Two surfaces, because tools need two things:
//   exec(): run a shell command          (bash)
//   fs:     read, write, stat, list      (read, write, edit, glob, grep)

export type EnvKind = "host" | "os" | "docker";

export interface ExecOptions {
  timeoutS: number;
  signal: AbortSignal; // Esc
}

export interface ExecResult {
  output: string; // stdout and stderr, interleaved as they arrived (start and end kept if huge)
  exitCode: number | null; // null: it didn't exit by itself (killed)
  signal?: string; // the signal that killed it, when known (SIGTERM...)
  stopped: string | null; // why WE stopped it ("timed out after 120s"), or null
}

export interface FileInfo {
  kind: "file" | "dir" | "other"; // "other": a device, pipe or socket
  size: number;
  mtimeMs: number;
  mode: number; // permission bits, so a rewrite keeps a script executable
}

// Every path is an absolute path as the MODEL sees it: your real path on your machine (host and
// OS sandbox), "/workspace/..." in Docker. Each implementation maps it to wherever the bytes live, and
// refuses (with a ToolError) any path that would leave the workspace.
export interface WorkspaceFs {
  stat(p: string): Promise<FileInfo | null>; // null: doesn't exist
  readFile(p: string, signal?: AbortSignal): Promise<Uint8Array>;
  // Write all-or-nothing (temp file + rename) and return the new mtime. A symlink is followed:
  // its target is replaced, not the link.
  writeFileAtomic(p: string, data: string, options?: { mode?: number; signal?: AbortSignal }): Promise<number>;
  mkdirp(p: string): Promise<void>;
  // Files under `dir` matching a glob, relative to `dir`, sorted. `note` says what was skipped.
  listFiles(dir: string, pattern: string, signal?: AbortSignal): Promise<{ files: string[]; note: string | null }>;
}

export interface ExecutionEnv {
  readonly kind: EnvKind;
  readonly cwd: string; // the working directory the model sees
  readonly fs: WorkspaceFs;
  // Extra lines for the bash tool's description, so the model knows where its commands run.
  readonly bashNotes: string;
  // One line for the banner, e.g. "docker sandbox (arch-code-a1b2c3d4)".
  describe(): string;
  start(): Promise<void>;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  // Ship the workspace's changes back as a git branch. Host and OS sandbox: nothing to do, the
  // agent worked on your real files.
  handBack(): Promise<string | null>;
  close(): Promise<void>;
}

// Folders that are huge and almost never what the model is looking for.
export const IGNORED_DIRS = ["node_modules", ".git", "dist", ".arch-code"];