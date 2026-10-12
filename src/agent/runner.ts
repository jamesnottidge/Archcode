import type { Emit, Todo } from "../event.ts";
import type { Message, Model } from "../model.ts";
import { systemPrompt } from "../prompt.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { agentTurn } from "./loop.ts";
import type { SessionLog } from "./session.ts";
import type { Tracer } from "./trace.ts";
import type { ExecutionEnv } from "../env/types.ts";

export interface RunnerDeps {
  model: Model;
  tools: ToolRegistry;
  session: SessionLog;
  tracer: Tracer;
  env: ExecutionEnv; // where the tools act
  emit: Emit;
  askUser: (question: string) => Promise<string | null>;
}

// The Runner sits between the UI and the agent loop. It:
//  - runs at most ONE turn at a time ("single flight"),
//  - holds the two input queues and feeds them to the loop at its boundaries,
//  - handles abort (Esc),
//  - saves every turn to the session log, even when it fails.
export class Runner {
  readonly history: Message[];
  readonly todos: Todo[] = [];
  readonly readFiles = new Map<string, number>(); // files the model has read: path -> mtime (see write)
  private deps: RunnerDeps;
  private steering: string[] = []; // injected before the next model call
  private followUps: string[] = []; // injected when the turn would otherwise end
  private notes: string[] = []; // things the model must know at the start of the next turn. 
  private controller: AbortController | null = null;

  constructor(deps: RunnerDeps, history: Message[] = []) {
    this.deps = deps;
    this.history = history;
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  steer(text: string): void {
    this.steering.push(text);
  }

  followUp(text: string): void {
    this.followUps.push(text);
  }

  // The ground moved under the model (/sandbox, /docker-sandbox): tell it with the next message,
  // and forget which files it has read (they may be different files now, or at new paths).
   environmentChanged(note: string): void {
     this.notes.push(note);
     this.readFiles.clear();
   }
 

  // Cooperative abort: signal everything in flight, drop queued input.
  abort(): void {
    if (!this.controller) return;
    this.controller.abort();
    this.steering = [];
    this.followUps = [];
  }

  async run(prompt: string): Promise<void> {
    if (this.busy) throw new Error("A turn is already running. Use steer() or followUp().");
    const { emit } = this.deps;
    const controller = new AbortController();
    this.controller = controller;
    const firstNewMessage = this.history.length;
    const notes = this.notes.splice(0).map((n) => `[arch-code: ${n}]\n`).join("");
    this.history.push({ role: "user", content: notes ? `${notes}\n${prompt}` : prompt });
    emit({ type: "turn_started" });

    let reason: "done" | "aborted" | "error" = "done";
    let error: string | undefined;
    try {
      const turn = agentTurn(this.history, {
        model: this.deps.model,
        tools: this.deps.tools,
        tracer: this.deps.tracer,
        system: systemPrompt(this.deps.env),
        ctx: {
          cwd: this.deps.env.cwd,
          env: this.deps.env, 
          signal: controller.signal,
          emit,
          askUser: this.deps.askUser,
          todos: this.todos,
          readFiles: this.readFiles,
        },
      });

      // Drive the generator from boundary to boundary.
      let step = await turn.next([]); // runs until the first boundary (the argument is ignored)
      while (!step.done) {
        if (controller.signal.aborted) {
          await turn.return(); // stop the generator cleanly
          reason = "aborted";
          break;
        }
        // At "would_stop", leftover steering counts as a follow-up: the user typed it
        // while the model was writing its final answer, and it must not get lost.
        const input = step.value === "model_request" ? this.drain("steering") : [...this.drain("steering"), ...this.drain("followUps")];
        step = await turn.next(input);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        reason = "aborted";
      } else {
        reason = "error";
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      // Save whatever this turn produced, finished or not.
      this.deps.session.append(this.history.slice(firstNewMessage));
      this.controller = null;
      emit({ type: "turn_finished", reason, error, todos: this.todos });
    }
  }

  private drain(queue: "steering" | "followUps"): string[] {
    const items = this[queue];
    this[queue] = [];
    return items;
  }
}