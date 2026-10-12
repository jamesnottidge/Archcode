import { type ChildProcess, spawn } from "node:child_process";
import type { ExecOptions, ExecResult } from "./types.ts";

const MAX_CAPTURE = 1_000_000; // characters kept in memory (first half + last half); the registry trims further

// Keep the START and the END of the output. If a test run prints 5 MB, the summary you need is
// at the end, so we can't just stop collecting once we have "enough".
export class OutputCapture {
  private head = "";
  private tail = "";
  private dropped = 0;

  add(chunk: string): void {
    if (this.head.length < MAX_CAPTURE / 2) {
      this.head += chunk;
      return;
    }
    this.tail += chunk;
    if (this.tail.length > MAX_CAPTURE / 2) {
      this.dropped += this.tail.length - MAX_CAPTURE / 2;
      this.tail = this.tail.slice(-MAX_CAPTURE / 2);
    }
  }

  text(): string {
    return this.dropped > 0 ? `${this.head}\n\n[... ${this.dropped} characters omitted ...]\n\n${this.tail}` : this.head + this.tail;
  }
}

// How a sandbox runs one command: a bash that writes its own pid to a file, then BECOMES the
// command (exec keeps the pid). The command is its own process group in there, so a timeout or
// Esc can kill the whole group: kill -KILL -- -<pid>. The command travels as a separate argument
// ($1), never pasted into a string, so there are no quoting bugs.
//   bash -c PID_WRAPPER <pidfile> <command>
export const PID_WRAPPER = 'echo $$ > "$0"; exec bash -lc "$1"';

// Run a child process to completion with a timeout and Esc support, never throwing.
// `kill` is how to stop it, and it differs per environment: on your machine we kill the
// process group; for `docker exec` we must kill the command INSIDE the container, because
// killing the docker client alone leaves the real process running in there.
export function runProcess(
  child: ChildProcess,
  options: ExecOptions,
  kill: (child: ChildProcess) => void | Promise<void>,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const capture = new OutputCapture();
    // setEncoding decodes each stream as UTF-8 for us, holding back a character whose bytes
    // are split across two chunks. (chunk.toString() on each chunk would garble it into "��".)
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => capture.add(c));
    child.stderr?.on("data", (c: string) => capture.add(c));

    let stopped: string | null = null;
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      Promise.resolve(kill(child)).catch(() => {});
    };
    const timer = setTimeout(() => stop(`timed out after ${options.timeoutS}s and was killed`), options.timeoutS * 1000);
    const onAbort = () => stop("interrupted by the user");
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();

    const finish = (result: ExecResult) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.on("error", (err) => finish({ output: `Failed to start: ${err.message}`, exitCode: null, stopped }));
    child.on("close", (code, signal) => finish({ output: capture.text(), exitCode: code, signal: signal ?? undefined, stopped }));
  });
}

// Spawn with stdin closed (a command waiting for input gets EOF instead of hanging forever).
export function spawnQuiet(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {}): ChildProcess {
  return spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
}

// Run a helper command (docker, git) and get its output; throws with stderr if it fails.
// For the harness's own plumbing, not for the model's commands.
export function run(file: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${file} ${args.slice(0, 2).join(" ")} failed (exit ${code}): ${(err || out).trim().slice(0, 500)}`));
    });
    child.stdin.on("error", () => {}); // it may exit without reading its input: that's fine
    child.stdin.end(options.input ?? "");
  });
}