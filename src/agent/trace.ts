import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// A span = one timed operation: a model call or a tool call.
// The schema validates trace files when we read them back; the type comes from it.
const SpanSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("model"),
    name: z.string(),
    durationMs: z.number(),
    usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).optional(),
    toolCalls: z.array(z.string()),
  }),
  z.object({ kind: z.literal("tool"), name: z.string(), durationMs: z.number(), isError: z.boolean() }),
]);

export type Span = z.infer<typeof SpanSchema>;

// Local tracing: one JSON line per span in .arch-code/traces/<session>.jsonl.
// Same idea as the article's Opik setup, minus the account and the dashboard.
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
  const spans: Span[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    // Stats are best-effort: skip a bad line rather than refuse to report anything.
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const parsed = SpanSchema.safeParse(json);
    if (parsed.success) spans.push(parsed.data);
    else skipped++;
  }

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
    ...(skipped > 0 ? [`skipped:      ${skipped} malformed line(s)`] : []),
  ].join("\n");
}