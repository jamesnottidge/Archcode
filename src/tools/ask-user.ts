import { z } from "zod";
import { defineTool, ToolError } from "./helpers/types.ts";

export const askUserTool = defineTool({
  name: "ask_user",
  kind: "read",
  description:
    "Ask the user a question and wait for the answer. Use it only when you are blocked on a decision or information that only the user has.",
  schema: z.object({
    question: z.string().describe("A short, specific question"),
  }),

  async execute({ question }, ctx) {
    // The harness decides how to ask: the terminal UI prompts, headless mode can't.
    // so in headless mode, the the interface would return an empty string, which we handle below. 
    const answer = await ctx.askUser(question);
    if (answer === null || answer.trim() === "") {
      throw new ToolError(
        "The user did not answer (they may not be at the keyboard). Make a reasonable assumption, say what you assumed, and continue.",
      );
    }
    return `The user answered: ${answer}`;
  },
});