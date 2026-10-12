import { HostFs } from "./host-fs.ts";
import { runProcess, spawnQuiet } from "./process.ts";
import type { ExecOptions, ExecResult, ExecutionEnv } from "./types.ts";

// Environment variables that look like credentials. arch-code loaded your API key into its own
// process.env from .env, and a child process inherits everything by default, so without this
// `bash -c env` would print your OpenRouter key straight into the model's context.
// A name matches when one of its _-separated words is KEY, TOKEN... anywhere in it, so
// OPENROUTER_API_KEY, GITHUB_TOKEN and AWS_ACCESS_KEY_ID all go.
// This is a seatbelt: it can only catch secrets by their NAME. A password inside DATABASE_URL
// still gets through. The sandbox does better: its environment starts empty.
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PAT)(_|$)|_AUTH$/i;
// git's own config-by-environment (GIT_CONFIG_COUNT, _KEY_0, _VALUE_0) must stay complete,
// or every git command fails.
const GIT_CONFIG = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => GIT_CONFIG.test(name) || !SECRET_NAME.test(name)));
}

// No sandbox: commands run on your machine, as you, in your project folder.
// This is Lesson 2's behavior, kept as the default for trusted work.
export class HostEnv implements ExecutionEnv {
  readonly kind = "host";
  readonly cwd: string;
  readonly fs = new HostFs();
  readonly bashNotes = "";

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  describe(): string {
    return "no sandbox";
  }

  async start(): Promise<void> {}

  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const child = spawnQuiet("/bin/bash", ["-c", command], {
      cwd: this.cwd,
      env: scrubbedEnv(),
      // Own process group, so on timeout/abort we can kill the command AND its children
      // (e.g. `npm test` spawns node, which may spawn more).
      detached: true,
    });
    return runProcess(child, options, (c) => {
      try {
        process.kill(-c.pid!, "SIGKILL"); // negative pid = the whole group
      } catch {
        // already gone
      }
    });
  }

  async handBack(): Promise<string | null> {
    return null; // the agent worked on your real files: there's nothing to bring back
  }

  async close(): Promise<void> {}
}