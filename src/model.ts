import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Config } from "./config.ts";
import type { Usage } from "./event.ts";

// The conversation history is just an array of these.
export type Message = ChatCompletionMessageParam;
export type ToolCall = ChatCompletionMessageFunctionToolCall;

export interface ModelReply {
  message: ChatCompletionAssistantMessageParam; // goes straight into the history
  toolCalls: ToolCall[]; // empty array = the model wants to stop
  usage?: Usage;
}

export interface StreamCallbacks {
  signal: AbortSignal;
  onText: (text: string) => void;
  onReasoning: (text: string) => void;
}

// Some providers (OpenRouter, Ollama) stream "thinking" tokens in a
// non-standard `reasoning` field, others in `reasoning_content`.
interface DeltaWithReasoning {
  reasoning?: string | null;
  reasoning_content?: string | null;
}

export class Model {
  readonly name: string;
  private client: OpenAI;

  constructor(config: Config) {
    this.name = config.model;
    this.client = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      // The SDK handles retries 408/409/429/5xx with exponential backoff.
      // Free tiers rate-limit often, so we would be generous.
      maxRetries: 5,
      defaultHeaders: { "X-Title": "arch-code" }, // shows up in OpenRouter activity
    });
  }

  // One model call: send the whole history, stream the answer back.
  async complete(
    system: string,
    history: Message[],
    tools: ChatCompletionTool[],
    cb: StreamCallbacks,
  ): Promise<ModelReply> {
    const stream = await this.client.chat.completions.create(
    // notice that the system prompt is prepended at call time and not stored in history
    // so that old sessions can benefit from a new system prompt. 
      {
        model: this.name,
        messages: [{ role: "system", content: system }, ...history],
        tools,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: cb.signal },
    );

    let text = "";
    let usage: Usage | undefined;
    // Tool calls arrive in fragments: first the id and name, then the
    // JSON arguments a few characters at a time. We glue them back together.
    const calls: { id: string; name: string; args: string }[] = [];

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      const extra = delta as DeltaWithReasoning;
      const reasoning = extra.reasoning ?? extra.reasoning_content;
      if (reasoning) cb.onReasoning(reasoning);

      if (delta.content) {
        text += delta.content;
        cb.onText(delta.content);
      }

      for (const part of delta.tool_calls ?? []) {
        // `index` says which call this fragment belongs to. A few providers
        // omit it and send each call whole, so fall back to "a new call".
        const i = part.index ?? calls.length;
        calls[i] ??= { id: "", name: "", args: "" };
        if (part.id) calls[i].id = part.id;
        if (part.function?.name) calls[i].name += part.function.name;
        if (part.function?.arguments) calls[i].args += part.function.arguments;
      }
    }

    const toolCalls: ToolCall[] = calls
      .filter((c) => c !== undefined && c.name !== "")
      .map((c, n) => ({
        id: c.id || `call_${Date.now()}_${n}`, // some free models forget the id
        type: "function",
        function: { name: c.name, arguments: c.args || "{}" },
      }));

    // With tool calls, content may be empty (null). Without them, some providers
    // reject an empty assistant message later on, so store a placeholder.
    const message: ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: text !== "" ? text : toolCalls.length > 0 ? null : "(empty response)",
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return { message, toolCalls, usage };
  }
}