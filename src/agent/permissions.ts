// Before a risky tool runs (write, edit, bash, web_fetch), the gate asks the user.
// "always" remembers the answer for that tool until arch-code exits.
// --yolo skips every question. Live vicariously! and remember, Viena waits for you. 

export type ApprovalAnswer = "yes" | "no" | "always";
export type AskApproval = (toolName: string, summary: string) => Promise<ApprovalAnswer>;
import { bashTool } from "../tools/bash.ts";
import { isSafeCommand } from "../tools/helpers/utils.ts";

export class PermissionGate {
  private alwaysAllowed = new Set<string>();
  private yolo: boolean;
  private ask: AskApproval;

  constructor(options: { yolo: boolean; ask: AskApproval }) {
    this.yolo = options.yolo;
    this.ask = options.ask;
  }


  async allow(toolName: string, summary: string, args: unknown): Promise<boolean> {
    if (this.yolo || this.alwaysAllowed.has(toolName)) return true;
    if (toolName === bashTool.name && isSafeCommand((args as { command: string }).command)) return true;
    const answer = await this.ask(toolName, summary);
    if (answer === "always") this.alwaysAllowed.add(toolName);
    return answer !== "no";
  }
}