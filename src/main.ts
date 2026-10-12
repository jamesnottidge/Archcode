#!/usr/bin/env node
import { parseArgs, styleText } from "node:util";
import { PermissionGate } from "./agent/permissions.ts";
import { Runner } from "./agent/runner.ts";
import { SessionLog } from "./agent/session.ts";
import { Tracer, traceStats } from "./agent/trace.ts";
import { loadConfig, loadDotEnv } from "./config.ts";
import type { AgentEvent } from "./event.ts";
import { type Message, Model } from "./model.ts";
import { ALL_TOOLS, ToolRegistry } from "./tools/registry.ts";
import { TerminalUI } from "./ui/terminal.ts";
import { HostEnv } from "./env/host.ts";

const USAGE = `arch-code: a coding agent built from scratch

  arch-code                     start an interactive session in the current directory
  arch-code -p "prompt"         run one prompt headless and print the answer
  arch-code -c                  continue the most recent session
  arch-code -r <id>             resume a session by id (prefix is enough)
  arch-code --sessions          list sessions for this directory
  arch-code --stats <id>        summarize a session's trace
options:
  -m, --model <name>            override the model
  --yolo                        never ask before write/edit/bash/web_fetch (careful!)`;

const { values: args } = parseArgs({
  options: {
    print: { type: "string", short: "p" },
    continue: { type: "boolean", short: "c" },
    resume: { type: "string", short: "r" },
    sessions: { type: "boolean" },
    stats: { type: "string" },
    model: { type: "string", short: "m" },
    yolo: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

async function main(): Promise<number> {
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  loadDotEnv();
  const config = loadConfig({ model: args.model });

  if (args.sessions) {
    console.log(SessionLog.list(config.dataDir).join("\n") || "No sessions yet.");
    return 0;
  }
  if (args.stats) {
    const { log } = SessionLog.open(config.dataDir, args.stats);
    console.log(traceStats(config.dataDir, log.id));
    return 0;
  }

  // New session, or reload an old one's history.
  let session: SessionLog;
  let history: Message[] = [];
  if (args.continue || args.resume) {
    ({ log: session, history } = SessionLog.open(config.dataDir, args.resume));
  } else {
    session = SessionLog.create(config.dataDir, config.cwd, config.model);
  }

  const model = new Model(config);
  const tracer = new Tracer(config.dataDir, session.id);
  const headless = args.print !== undefined;

  // ── headless: one prompt in, answer out. Handy for scripts (and for testing). ──
  if (headless) {
    const gate = new PermissionGate({
      yolo: args.yolo ?? false,
      ask: async (_tool, summary) => {
        console.error(styleText("yellow", `denied (headless, no --yolo): ${summary}`));
        return "no";
      },
    });
    let failed = false;
    const runner = new Runner(
      {
        model,
        tools: new ToolRegistry(ALL_TOOLS, gate),
        session,
        tracer,
        env: new HostEnv(config.cwd),
        emit: (e) => (failed = printHeadless(e) || failed),
        askUser: async () => null, // nobody to ask
      },
      history,
    );
    await runner.run(args.print!);
    return failed ? 1 : 0;
  }

  // ── interactive ──
  const ui = new TerminalUI();
  const gate = new PermissionGate({ yolo: args.yolo ?? false, ask: ui.askApproval });
  const runner = new Runner(
    {
      model,
      tools: new ToolRegistry(ALL_TOOLS, gate),
      session,
      tracer,
      env: new HostEnv(config.cwd),
      emit: ui.handle,
      askUser: ui.askUser,
    },
    history,
  );
  ui.attach(runner);
  const resumed = history.length > 0 ? ` · resumed ${history.length} messages` : "";
  await ui.start(
    `${styleText("bold", "arch-code")} · ${config.provider}/${config.model} · session ${session.id.slice(0, 8)}${resumed}`,
  );
  return 0;
}

// Returns true if the turn failed.
function printHeadless(event: AgentEvent): boolean {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "message_done":
      process.stdout.write("\n");
      break;
    case "tool_started":
      console.error(styleText("dim", `● ${event.name} ${JSON.stringify(event.args)}`));
      break;
    case "tool_finished":
      if (event.isError) console.error(styleText("red", `  ${event.output.split("\n")[0]}`));
      break;
    case "turn_finished":
      if (event.reason === "error") console.error(styleText("red", `✖ ${event.error}`));
      return event.reason !== "done";
  }
  return false;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(styleText("red", `✖ ${err.message}`));
    process.exit(1);
  },
);