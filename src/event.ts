// Everything the agent does is announced as an event. 
// The loop never prints anything itself: a UI subscribes to these events
// and decides how to show them. Swap the UI and the agent does not change. 

export type TodoStatus = "pending" | "in_progress" | "completed"; 

export interface Todo {
    content: string;
    status: TodoStatus;
}

export interface Usage {
    promptTokens: number;
    completionTokens: number;
}

export type AgentEvent =
  | { type: "turn_started" }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "message_done" } // the model finished one message (flush any buffered text)
  | { type: "tool_started"; id: string; name: string; args: unknown }
  | { type: "tool_finished"; id: string; name: string; output: string; isError: boolean }
  | { type: "todos_updated"; todos: Todo[] }
  | { type: "user_message_injected"; text: string; kind: "steering" | "follow_up" }
  | { type: "usage"; usage: Usage }
  | { type: "turn_finished"; reason: "done" | "aborted" | "error"; error?: string , todos: Todo[]};

export type Emit = (event: AgentEvent) => void;