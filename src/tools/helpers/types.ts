import type { z } from "zod";
import type { ExecutionEnv } from "../../env/types.ts";
import type { Emit, Todo } from "../../event.ts";

// What every tool gets handed whrn it runs: the harness state. 
// Tools never import the UI. THey talk to the outside world only through this. 

export interface ToolContext {
    cwd: string;
    env: ExecutionEnv; // WHERE tools act: your machine or a sandbox. Every file read and command goes through it. 
    signal: AbortSignal; //fires when the user presses Esc to interrupt
    emit: Emit; 
    askUser: (question: string) => Promise<string | null>;  //null =  nobody to ask 
    todos: Todo[];
    // Files the model has read this session: absolute path -> modification time when read. 
    // `write` uses it to refuse overwriting files the model has never seen (or that changes since). 
    readFiles: Map<string, number>;
}

// Toolkind is how we want the permission gate to decide what a tool can do to its hosted env
//   read:    looks, changes nothing (read, glob, grep, and harness-only tools like todo_write)
 //   edit:    changes files (write, edit)
//   exec:    runs arbitrary commands (bash)
//   network: talks to the internet from YOUR machine (web_fetch)
export type ToolKind = "read" | "edit" | "exec" | "network";


export interface Tool<Schema extends z.ZodType = z.ZodType> {
    name: string;
    kind: ToolKind;

    // the model reads this to decide when to use the tool. It's a function when it depends on where
    // the tool runs.
    description: string | ((env: ExecutionEnv) => string); 

    // the one argument that permission rules match against: the command, the path or the URL. 
    subject?(args: z.infer<Schema>): string; 

    schema:  Schema; // validates the arguments and becomes the JSON schema the model sees

    // What the approval prompt shows, IF the permission gate decides to ask: a first line
    // ("edit src/app.ts") plus optional preview lines (a diff). It may look at the disk, so it's
    // async and gets ctx. Throwing a ToolError here refuses the call before anyone is asked.
    describeAction?(args: z.infer<Schema>, ctx: ToolContext): string | Promise<string>;

    execute(args: z.infer<Schema>, ctx: ToolContext): Promise<string>;
}

// A tiny helper so that the typescript linter infers `args` from the schema for us. 
export function defineTool<Schema extends z.ZodType>(tool: Tool<Schema>): Tool<Schema>{
    return tool;
}

// Throw this for problems the model should read and react to
// ("file not found", "old_string is ambiguous"...).
export class ToolError extends Error {}
