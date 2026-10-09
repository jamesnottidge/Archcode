import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Usage } from "../event.ts";

// A span = one timed operation: a model call or a tool call.
export type Span =
  | { kind: "model"; name: string; durationMs: number; usage?: Usage; toolCalls: string[] }
  | { kind: "tool"; name: string; durationMs: number; isError: boolean };

// Local tracing: one JSON line per span in .arch-code/traces/<session>.jsonl.
// Same idea as an Opik setup, but cheaper. 
export class Tracer {
  private file: string;

  constructor(dataDir: string, sessionId: string) {
    const dir = path.join(dataDir, "traces");
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${sessionId}.jsonl`);
  }

  record(span: Span): void {
    appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...span })}\n`);
  }
}

// `arch-code --stats <session-id>` prints a summary of a trace file.
export function traceStats(dataDir: string, sessionId: string): string {
  const file = path.join(dataDir, "traces", `${sessionId}.jsonl`);
  const spans = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Span);

  const models = spans.filter((s) => s.kind === "model");
  const tools = spans.filter((s) => s.kind === "tool");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const promptTokens = sum(models.map((s) => s.usage?.promptTokens ?? 0));
  const completionTokens = sum(models.map((s) => s.usage?.completionTokens ?? 0));

  const byTool = new Map<string, number>();
  for (const t of tools) byTool.set(t.name, (byTool.get(t.name) ?? 0) + 1);

  return [
    `model calls:  ${models.length} (${(sum(models.map((s) => s.durationMs)) / 1000).toFixed(1)}s total)`,
    `tool calls:   ${tools.length} (${tools.filter((t) => t.isError).length} errors)`,
    `tokens:       ${promptTokens} in, ${completionTokens} out`,
    `largest prompt: ${Math.max(0, ...models.map((s) => s.usage?.promptTokens ?? 0))} tokens`,
    `by tool:      ${[...byTool].map(([name, n]) => `${name}×${n}`).join(", ") || "none"}`,
  ].join("\n");
}