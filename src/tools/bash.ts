import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./helpers/types.ts";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const MAX_CAPTURE = 1_000_000; // characters kept in memory (first half + last half); the registry trims further

export const bashTool = defineTool({
  name: "bash",
  description:
    "Run a shell command with bash in the working directory and return its combined stdout/stderr and exit code. Use it to run tests, builds, git, package managers, etc. Commands cannot read from stdin, so avoid interactive programs. Don't start servers or watchers (even with &): the call waits until their output closes, so it would hang until the timeout.",
  schema: z.object({
    command: z.string().describe("The command to run"),
    timeout: z
      .number()
      .min(1)
      .max(MAX_TIMEOUT_S)
      .optional()
      .describe(`Timeout in seconds (default ${DEFAULT_TIMEOUT_S})`),
  }),

  describeAction: ({ command }) => `run: ${command}`,

  execute({ command, timeout = DEFAULT_TIMEOUT_S }, ctx) {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", command], {
        cwd: ctx.cwd,
        // stdin is closed: a command waiting for input gets EOF instead of hanging forever.
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so on timeout/abort we can kill the command AND its children
        // (e.g. `npm test` spawns node, which may spawn more).
        detached: true,
      });

      // Keep the START and the END of the output. If a test run prints 5 MB, the summary
      // you need is at the end, so we can't just stop collecting once we have "enough".
      let head = "";
      let tail = "";
      let dropped = 0;
      const collect = (chunk: string) => {
        if (head.length < MAX_CAPTURE / 2) {
          head += chunk;
          return;
        }
        tail += chunk;
        if (tail.length > MAX_CAPTURE / 2) {
          dropped += tail.length - MAX_CAPTURE / 2;
          tail = tail.slice(-MAX_CAPTURE / 2);
        }
      };
      // setEncoding decodes each stream as UTF-8 for us, holding back a character whose bytes
      // are split across two chunks. (chunk.toString() on each chunk would garble it into "��".)
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      let stopReason: string | null = null;
      const kill = (reason: string) => {
        stopReason ??= reason;
        try {
          process.kill(-child.pid!, "SIGKILL"); // negative pid = the whole group
        } catch {
          // already gone
        }
      };
      const timer = setTimeout(() => kill(`Command timed out after ${timeout}s and was killed.`), timeout * 1000);
      const onAbort = () => kill("Command was interrupted by the user.");
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (text: string) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(text);
      };

      child.on("error", (err) => finish(`Failed to start command: ${err.message}`));
      child.on("close", (code, signal) => {
        const output = dropped > 0 ? `${head}\n\n[... ${dropped} characters omitted ...]\n\n${tail}` : head + tail;
        const body = output.trimEnd() || "(no output)";
        // A non-zero exit code is not a tool failure: it's information the model needs.
        const status = stopReason ?? (code === null ? `Killed by signal ${signal}.` : `Exit code: ${code}`);
        finish(`${body}\n\n${status}`);
      });
    });
  },
});