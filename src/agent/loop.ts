import type { Message, Model } from "../model.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/helpers/types.ts";
import type { Tracer } from "./trace.ts";

// The two moments in a turn where it is SAFE to let new user input in.
//  - "model_request": we're about to call the model. Nothing is half-done.
//  - "would_stop":    the model answered without calling tools; the turn is about to end.
export type Boundary = "model_request" | "would_stop";

export interface TurnDeps {
  model: Model;
  tools: ToolRegistry;
  ctx: ToolContext;
  system: string;
  tracer: Tracer;
}

// One turn = everything the agent does in response to a user message.
//
// It's an async *generator*: it runs until a boundary, `yield`s it, and pauses.
// Whoever drives it (the Runner) resumes it with `next(messages)`, handing in any
// queued user messages. That's how outside input gets in without ever landing
// in the middle of a tool call.
export async function* agentTurn(history: Message[], deps: TurnDeps): AsyncGenerator<Boundary, void, string[]> {
  const { model, tools, ctx, tracer } = deps;

  while (true) {
    // ── Boundary 1 ── inject "steering" messages typed while we were busy.
    const steering = yield "model_request";
    for (const text of steering) {
      history.push({ role: "user", content: text });
      ctx.emit({ type: "user_message_injected", text, kind: "steering" });
    }

    // ── REASON ── ask the model what to do next (streaming text to the UI as it comes).
    const started = Date.now();
    const reply = await model.complete(deps.system, history, tools.definitions(), {
      signal: ctx.signal,
      onText: (text) => ctx.emit({ type: "text_delta", text }),
      onReasoning: (text) => ctx.emit({ type: "reasoning_delta", text }),
    });
    ctx.emit({ type: "message_done" });
    tracer.record({
      kind: "model",
      name: model.name,
      durationMs: Date.now() - started,
      usage: reply.usage,
      toolCalls: reply.toolCalls.map((c) => c.function.name),
    });
    if (reply.usage) ctx.emit({ type: "usage", usage: reply.usage });
    history.push(reply.message);

    // ── ACT + OBSERVE ── run every requested tool and append each result.
    if (reply.toolCalls.length > 0) {
      for (const call of reply.toolCalls) {
        ctx.emit({ type: "tool_started", id: call.id, name: call.function.name, args: parseArgs(call.function.arguments) });
        const toolStarted = Date.now();
        const result = await tools.run(call, ctx); // never throws
        tracer.record({ kind: "tool", name: call.function.name, durationMs: Date.now() - toolStarted, isError: result.isError });
        ctx.emit({ type: "tool_finished", id: call.id, name: call.function.name, ...result });
        // Every tool call MUST get a matching result message, or the next request is rejected.
        history.push({ role: "tool", tool_call_id: call.id, content: result.output });
      }
      continue; // back to the top: let the model look at the results
    }

    // ── Boundary 2 ── no tool calls means the model thinks it's done.
    // Queued "follow-up" messages extend the turn; otherwise we stop.
    const followUps = yield "would_stop";
    if (followUps.length === 0) return;
    for (const text of followUps) {
      history.push({ role: "user", content: text });
      ctx.emit({ type: "user_message_injected", text, kind: "follow_up" });
    }
  }
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}