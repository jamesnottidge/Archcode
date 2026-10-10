import readline from "node:readline";
import { styleText } from "node:util";
import type { ApprovalAnswer } from "../agent/permissions.ts";
import type { Runner } from "../agent/runner.ts";
import type { AgentEvent } from "../event.ts";
import { renderTodos } from "../tools/todo.ts";

const dim = (s: string) => styleText("dim", s);
const PROMPT_IDLE = styleText("cyan", "› ");
const PROMPT_BUSY = dim("… ");

const HELP = `Enter       send a message (while Arch works: steer it before its next step)
Alt+Enter   queue a follow-up for when the current turn would end (or: /later msg)
Esc         interrupt the current turn
/todos      show the task list     /exit  quit (or Ctrl+D)`;

type Pending = { kind: "approval" | "question"; resolve: (answer: string | null) => void };

// An "append to scrollback" terminal UI: output scrolls up like a normal
// terminal program, and the input line always stays at the bottom.
export class TerminalUI {
  private rl: readline.Interface;
  private runner: Runner | null = null;
  private pending: Pending | null = null; // a question waiting for the user's next line
  private streamBuffer = ""; // streamed text not printed yet (we print whole lines)
  private streamStyle: "text" | "reasoning" = "text";
  private contextTokens = 0;

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT_IDLE });
    this.rl.on("line", (line) => this.onLine(line));
    this.rl.on("SIGINT", () => (this.runner?.busy ? this.interrupt() : this.rl.close())); // Ctrl+C
    // readline turns raw bytes into "keypress" events. Plain readline ignores
    // Alt+Enter and has no use for Esc, so we handle those two keys ourselves.
    process.stdin.on("keypress", (_str, key: readline.Key | undefined) => {
      if (key?.name === "escape") this.interrupt();
      if (key?.name === "return" && key.meta) this.submitFollowUp();
    });
  }

  attach(runner: Runner): void {
    this.runner = runner;
  }

  // Resolves when the user quits.
  start(banner: string): Promise<void> {
    this.print(banner);
    this.print(dim(HELP));
    this.rl.prompt();
    return new Promise((resolve) => this.rl.on("close", resolve));
  }

  // ───────────── input ─────────────

  private onLine(line: string): void {
    const text = line.trim();
    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = null;
      this.rl.setPrompt(this.runner?.busy ? PROMPT_BUSY : PROMPT_IDLE);
      resolve(text);
      return;
    }
    if (text === "") return this.rl.prompt();
    if (text.startsWith("/")) return this.command(text);
    this.send(text, "steer");
  }

  private command(text: string): void {
    const [name, ...rest] = text.split(" ");
    const arg = rest.join(" ").trim();
    if (name === "/exit" || name === "/quit") return this.rl.close();
    if (name === "/help") this.print(dim(HELP));
    else if (name === "/todos") this.print(this.runner?.todos.length ? renderTodos(this.runner.todos) : dim("(no tasks)"));
    else if (name === "/later" && arg) return this.send(arg, "follow_up");
    else this.print(styleText("yellow", `Unknown command ${name}. Try /help.`));
    this.rl.prompt();
  }

  private send(text: string, mode: "steer" | "follow_up"): void {
    const runner = this.runner!;
    if (!runner.busy) {
      this.rl.setPrompt(PROMPT_BUSY);
      this.rl.prompt();
      void runner.run(text); // not awaited: the UI keeps accepting input while it runs
      return;
    }
    if (mode === "steer") {
      runner.steer(text);
      this.print(dim("  ↳ queued; Arch will read it before its next step"));
    } else {
      runner.followUp(text);
      this.print(dim("  ↳ queued as a follow-up for when this turn would end"));
    }
  }

  // Alt+Enter: take whatever is typed, clear the input line, queue it as a follow-up.
  private submitFollowUp(): void {
    if (this.pending) return;
    const text = this.rl.line.trim();
    this.rl.write(null, { ctrl: true, name: "e" }); // cursor to end of line
    this.rl.write(null, { ctrl: true, name: "u" }); // delete everything before the cursor
    if (!text) return;
    this.print(`${this.runner?.busy ? PROMPT_BUSY : PROMPT_IDLE}${text}`); // echo it, like Enter would
    this.send(text, "follow_up");
  }

  private interrupt(): void {
    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve(null); // a pending approval/question counts as "no"
    }
    this.runner?.abort();
  }

  // ───────────── questions from the harness ─────────────

  private ask(kind: Pending["kind"], header: string, prompt: string): Promise<string | null> {
    this.flush();
    this.print(header);
    return new Promise((resolve) => {
      this.pending = { kind, resolve };
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    });
  }

  // The summary's first line says what will happen ("edit src/app.ts (1 replacement)");
  // any lines after it are a preview, like a diff.
  askApproval = async (toolName: string, summary: string): Promise<ApprovalAnswer> => {
    const [action, ...preview] = visible(summary).split("\n");
    const header = [styleText("yellow", `  ⚠ Arch wants to ${action}`), ...preview.map((line) => `    ${colorDiffLine(line)}`)];
    const answer = await this.ask(
      "approval",
      header.join("\n"),
      styleText("yellow", `  allow? [y]es / [n]o / [a]lways allow ${toolName} › `),
    );
    const a = (answer ?? "n").toLowerCase();
    return a.startsWith("a") ? "always" : a.startsWith("y") ? "yes" : "no";
  };

  askUser = (question: string): Promise<string | null> =>
    this.ask("question", styleText("magenta", `  ? ${visible(question)}`), styleText("magenta", "  your answer › "));

  // ───────────── output ─────────────

  // Print above the input line without destroying what the user is typing.
  private print(text: string): void {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${text}\n`);
    this.rl.prompt(true); // redraw the prompt and the half-typed line
  }

  // Streamed tokens are buffered and printed line by line, so they never
  // collide with the input line at the bottom.
  private stream(text: string, style: "text" | "reasoning"): void {
    if (style !== this.streamStyle) this.flush();
    this.streamStyle = style;
    this.streamBuffer += text;
    const lines = this.streamBuffer.split("\n");
    this.streamBuffer = lines.pop() ?? "";
    for (const line of lines) this.printStreamLine(line);
  }

  private flush(): void {
    if (this.streamBuffer) this.printStreamLine(this.streamBuffer);
    this.streamBuffer = "";
  }

  private printStreamLine(line: string): void {
    const safe = visible(line);
    this.print(this.streamStyle === "reasoning" ? dim(styleText("italic", `  ┊ ${safe}`)) : safe);
  }

  handle = (event: AgentEvent): void => {
    switch (event.type) {
      case "text_delta":
        return this.stream(event.text, "text");
      case "reasoning_delta":
        return this.stream(event.text, "reasoning");
      case "message_done":
        return this.flush();
      case "tool_started":
        if (event.name !== "todo_write") this.print(`${styleText("green", "●")} ${styleText("bold", event.name)} ${dim(summarizeArgs(event.args))}`);
        return;
      case "tool_finished":
        if (event.name !== "todo_write" || event.isError) this.print(formatResult(event.output, event.isError));
        return;
      case "todos_updated":
        return this.print(renderTodos(event.todos).replace(/^/gm, "  "));
      case "user_message_injected":
        return this.print(dim(`  ↳ ${event.kind === "steering" ? "steering" : "follow-up"}: ${event.text}`));
      case "usage":
        this.contextTokens = event.usage.promptTokens + event.usage.completionTokens;
        return;
      case "turn_started":
        return;
      case "turn_finished":
        this.print(renderTodos(event.todos).replace(/^/gm, "  "));
        this.flush();
        if (event.reason === "aborted") this.print(styleText("yellow", "⏹ interrupted"));
        if (event.reason === "error") this.print(styleText("red", `✖ ${event.error}`));
        if (this.contextTokens > 0) this.print(dim(`  ${this.contextTokens.toLocaleString()} tokens in context`));
        this.rl.setPrompt(PROMPT_IDLE);
        this.rl.prompt();
        return;
    }
  };
}

// The one argument a human cares about, e.g. the path for read or the command for bash.
function summarizeArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return String(args).slice(0, 80);
  const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  const oneLine = visible((first ?? JSON.stringify(args)).replace(/\s+/g, " "));
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

function formatResult(output: string, isError: boolean): string {
  const lines = visible(output).split("\n").filter((l) => l.trim() !== "");
  const preview = lines.slice(0, 3).map((l) => (l.length > 100 ? `${l.slice(0, 99)}…` : l));
  const more = lines.length > 3 ? dim(` … (+${lines.length - 3} lines)`) : "";
  const body = preview.join("\n    ");
  return `  ${dim("⎿")} ${isError ? styleText("red", body) : dim(body)}${more}`;
}

function colorDiffLine(line: string): string {
  if (line.startsWith("+")) return styleText("green", line);
  if (line.startsWith("-")) return styleText("red", line);
  if (line.startsWith("@@")) return styleText("cyan", line);
  return line;
}

// Text from the model, from files or from commands must never get to DRIVE the terminal.
// Escape sequences can recolor text, move the cursor, erase lines, retitle the window, even
// write to the clipboard. A bare "\r" jumps back to the start of the line, so whatever follows
// is printed OVER what came before: an approval prompt could show a harmless-looking command
// whose dangerous first half has been painted over. Invisible Unicode direction overrides
// ("Trojan Source") can reorder what you see in the same way.
// So we show all of those as visible codes like \x1b. Newlines and tabs stay.
export function visible(text: string): string {
  return text.replaceAll("\r\n", "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}