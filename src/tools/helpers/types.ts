import type { z } from "zod";
import type { Emit, Todo } from "../../event.ts";

// What every tool gets handed whrn it runs: the harness state. 
// Tools never import the UI. THey talk to the outside world only through this. 

export interface ToolContext {
    cwd: string;
    signal: AbortSignal; //fires when the user presses Esc to interrupt
    emit: Emit; 
    askUser: (question: string) => Promise<string | null>;  //null =  nobody to ask 
    todos: Todo[];
    // Files the model has read this session: absolute path -> modification time when read. 
    // `write` uses it to refuse overwriting files the model has never seen (or that changes since). 
    readFiles: Map<string, number>;
}

export interface Tool<Schema extends z.ZodType = z.ZodType> {
    name: string; 
    description: string; // the model reads this to decide when to use the tool 
    schema:  Schema; // validates the arguments and becomes the JSON schema the model sees
    // If present, the action needs the user's OK. Returns a one-line summary
    // of what is about to happen, shown in the approval prompt. 
    // it may look at the disk, so it's async and gets ctx (the tool context). throwing 
    // a ToolError here refuses the call before the user is ever asked. 
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
