// A fake "LLM" that speaks the OpenAI chat API (streaming and non-streaming).
// Zero cost, zero rate limits, 100% predictable: perfect for testing the harness
// without burning your 50 free requests a day.
//
//   npm run fake-model                       (terminal 1)
//   ARCH_PROVIDER=fake npm start             (terminal 2)
//
// How it "thinks":
//   - A user message with lines like   !bash {"command":"ls"}   → it calls those tools.
//   - Right after tool results          → it reports what the tools returned.
//   - Anything else                     → it echoes your message back, word by word.
import { createServer, type ServerResponse } from "node:http";

const PORT = Number(process.env.FAKE_PORT ?? 4141);
const WORD_DELAY_MS = Number(process.env.FAKE_DELAY_MS ?? 40);

interface Msg {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string } }[];
}

interface Plan {
  text: string;
  toolCalls: { id: string; name: string; args: string }[];
}

// ── the "brain" ──
function think(messages: Msg[]): Plan {
  const last = messages.at(-1)!;

  if (last.role === "tool") {
    const results: string[] = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role === "tool"; i--) {
      const m = messages[i];
      const call = messages.flatMap((x) => x.tool_calls ?? []).find((c) => c.id === m.tool_call_id);
      const preview = (m.content ?? "").split("\n").slice(0, 4).join("\n");
      results.unshift(`${call?.function.name ?? "tool"} returned:\n${preview}`);
    }
    return { text: `Done.\n${results.join("\n\n")}`, toolCalls: [] };
  }

  const text = typeof last.content === "string" ? last.content : "";
  const toolCalls = text
    .split("\n")
    .map((line) => line.trim().match(/^!(\w+)\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, name, args], i) => ({ id: `call_${Date.now()}_${i}`, name, args: args || "{}" }));

  if (toolCalls.length > 0) return { text: `Calling ${toolCalls.length} tool(s).`, toolCalls };
  return { text: `You said: ${text}`, toolCalls: [] };
}

// ── speaking the protocol ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usageFor = (messages: Msg[]) => {
  const prompt = Math.round(JSON.stringify(messages).length / 4); // ~4 characters per token
  return { prompt_tokens: prompt, completion_tokens: 20, total_tokens: prompt + 20 };
};

function chunk(res: ServerResponse, delta: object, finish: string | null = null, extra: object = {}): void {
  const body = { id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function stream(res: ServerResponse, plan: Plan, messages: Msg[]): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  chunk(res, { role: "assistant", reasoning: `Looking at the last ${messages.at(-1)!.role} message...` });
  for (const word of plan.text.split(/(?<=\s)/)) {
    if (res.destroyed) return; // the client hung up (the user pressed Esc)
    chunk(res, { content: word });
    await sleep(WORD_DELAY_MS);
  }
  plan.toolCalls.forEach((call, index) => {
    // Like real providers: id + name first, then the JSON arguments in fragments.
    chunk(res, { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] });
    const size = Math.ceil(call.args.length / 3);
    for (let i = 0; i < call.args.length; i += size) {
      chunk(res, { tool_calls: [{ index, function: { arguments: call.args.slice(i, i + size) } }] });
    }
  });
  chunk(res, {}, plan.toolCalls.length > 0 ? "tool_calls" : "stop");
  res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage: usageFor(messages) })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function respondWhole(res: ServerResponse, plan: Plan, messages: Msg[]): void {
  const message = {
    role: "assistant",
    content: plan.text,
    ...(plan.toolCalls.length > 0 && {
      tool_calls: plan.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
    }),
  };
  const finish_reason = plan.toolCalls.length > 0 ? "tool_calls" : "stop";
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ id: "fake", object: "chat.completion", created: 0, model: "fake-model", choices: [{ index: 0, message, finish_reason }], usage: usageFor(messages) }));
}

createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const part of req) body += part;
  const { messages, stream: wantsStream } = JSON.parse(body) as { messages: Msg[]; stream?: boolean };
  const plan = think(messages);
  if (wantsStream) await stream(res, plan, messages);
  else respondWhole(res, plan, messages);
}).listen(PORT, () => console.log(`fake model listening on http://localhost:${PORT}/v1`));