import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { PermissionGate } from "../agent/permissions.ts";
import type { ToolCall } from "../model.ts";
import { askUserTool } from "./ask-user.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import { todoTool } from "./todo.ts";
import type { Tool, ToolContext } from "./helpers/types.ts";
import { ToolError } from "./helpers/types.ts";
import { truncateMiddle } from "./helpers/utils.ts";
import { webFetchTool } from "./web-fetch.ts";
import { writeTool } from "./write.ts";

export const ALL_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  todoTool,
  webFetchTool,
  askUserTool,
];

const MAX_OUTPUT_CHARS = 30_000; // ~7-8k tokens: the most one tool call may add to the context

export interface ToolResult {
  output: string;
  isError: boolean;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private gate: PermissionGate;

  constructor(tools: Tool[], gate: PermissionGate) {
    for (const tool of tools) this.tools.set(tool.name, tool);
    this.gate = gate;
  }

  // The tool list we send to the model with every request.
  definitions(): ChatCompletionTool[] {
    return [...this.tools.values()].map((tool) => {
      // zod -> JSON Schema. "input" mode describes what the model may SEND
      // (optional fields really are optional).
      const { $schema, ...parameters } = z.toJSONSchema(tool.schema, { io: "input" });
      return {
        type: "function",
        function: { name: tool.name, description: tool.description, parameters },
      };
    });
  }

  // Run one tool call. This NEVER throws: every failure becomes a message the
  // model can read and recover from. That's how agents self-correct.
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const fail = (output: string): ToolResult => ({ output: `Error: ${output}`, isError: true });
    const { name, arguments: rawArgs } = call.function;

    const tool = this.tools.get(name);
    if (!tool) return fail(`Unknown tool "${name}". Available tools: ${[...this.tools.keys()].join(", ")}`);

    // 1. Parse the JSON the model wrote. Small models get this wrong surprisingly often.
    let json: unknown;
    try {
      json = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch {
      return fail(`The arguments for ${name} were not valid JSON: ${rawArgs.slice(0, 200)}`);
    }

    // 2. Validate against the schema.
    const parsed = tool.schema.safeParse(json);
    if (!parsed.success) {
      return fail(`Invalid arguments for ${name}:\n${z.prettifyError(parsed.error)}`);
    }

    // 3. Ask permission for risky actions. describeAction may look at the disk (to show a diff,
    //    or to notice the call can't work: "you haven't read that file"), so it can fail too.
    //    If it does, the call is refused before the user is bothered with a prompt.
    if (ctx.signal.aborted) return fail("Skipped: the user interrupted the turn.");
    if (tool.describeAction) {
      let summary: string;
      try {
        summary = await tool.describeAction(parsed.data, ctx);
      } catch (err) {
        return fail(ctx.signal.aborted ? "Interrupted by the user." : errorText(err));
      }
      const allowed = await this.gate.allow(name, summary, parsed.data);
      if (!allowed) {
        return fail("The user denied this action. Don't retry it; ask the user how they want to proceed.");
      }
    }

    // 4. Run it, and cap whatever comes back.
    try {
      const output = await tool.execute(parsed.data, ctx);
      return { output: truncateMiddle(output, MAX_OUTPUT_CHARS), isError: false };
    } catch (err) {
      return fail(ctx.signal.aborted ? "Interrupted by the user." : errorText(err));
    }
  }
}

// A ToolError was written for the model: pass it on as-is. Anything else is unexpected
// (EACCES, a bug in a tool...), so keep its name, e.g. "Error: EACCES: permission denied".
function errorText(err: unknown): string {
  const message = err instanceof ToolError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return truncateMiddle(message, MAX_OUTPUT_CHARS);
}