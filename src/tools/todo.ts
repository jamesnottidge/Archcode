import { z } from "zod";
import type { Todo } from "../event.ts";
import { defineTool } from "./helpers/types.ts";

const MARKS: Record<Todo["status"], string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };

export function renderTodos(todos: Todo[]): string {
  return todos.map((t) => `${MARKS[t.status]} ${t.content}`).join("\n");
}

export const todoTool = defineTool({
  name: "todo_write",
  description:
    "Create or update your task list for the current job. Always send the FULL list (it replaces the old one). Keep exactly one task in_progress while working, and mark tasks completed as soon as they are done.",
  schema: z.object({
    todos: z.array(
      z.object({
        content: z.string().describe("What needs doing, in a few words"),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    ),
  }),

  async execute({ todos }, ctx) {
    // Replace the contents in place: the UI and the harness hold a reference to this same array.
    ctx.todos.splice(0, ctx.todos.length, ...todos);
    ctx.emit({ type: "todos_updated", todos: [...todos] });
    return `Updated task list (${todos.length} tasks):\n${renderTodos(todos)}`;
  },
});