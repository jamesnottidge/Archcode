import { z } from "zod";
import { defineTool } from "./helpers/types.ts";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

const BASE_DESCRIPTION =
  "Run a shell command with bash in the working directory and return its combined stdout/stderr and exit code. Use it to run tests, builds, git, package managers, etc. Commands cannot read from stdin, so avoid interactive programs. Don't start servers or watchers (even with &): the call waits until their output closes, so it would hang until the timeout.";

export const bashTool = defineTool({
  name: "bash",
  kind: "exec",
  // The model must know WHERE its commands run: in a sandbox, cd doesn't persist, the project
  // is a clone, there's no sudo... Without this it would be confused by its own results.
  description: (env) => (env.bashNotes ? `${BASE_DESCRIPTION} ${env.bashNotes}` : BASE_DESCRIPTION),
  subject: (args) => args.command,
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

  // Where the command runs (your machine, a container, a remote sandbox) is ctx.env's business.
  // This tool only turns the result into text for the model.
  async execute({ command, timeout = DEFAULT_TIMEOUT_S }, ctx) {
    const { output, exitCode, signal, stopped } = await ctx.env.exec(command, { timeoutS: timeout, signal: ctx.signal });
    const body = output.trimEnd() || "(no output)";
    // A non-zero exit code is not a tool failure: it's information the model needs.
    const status = stopped ? `Command ${stopped}.` : exitCode === null ? `Killed by signal ${signal ?? "(unknown)"}.` : `Exit code: ${exitCode}`;
    return `${body}\n\n${status}`;
  },
});