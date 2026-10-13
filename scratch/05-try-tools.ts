import { PermissionGate } from "../src/agent/permissions.ts";
import { ALL_TOOLS, ToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/helpers/types.ts";
import { HostEnv } from "../src/env/host.ts";

const registry = new ToolRegistry(ALL_TOOLS, new PermissionGate({ yolo: true, sandboxed: false, ask: async () => "yes" }));

const env = new HostEnv(process.cwd()); 

const ctx: ToolContext = {
  cwd: env.cwd,
  env, 
  signal: new AbortController().signal,
  emit: (event) => console.log("  event:", event.type),
  askUser: async () => null,
  todos: [],
  readFiles: new Map(),
};

// Each entry is exactly what a model would send: a tool name and a JSON string.
const calls: [string, string][] = [
  ["glob", '{"pattern":"src/**/*.ts"}'],
  ["grep", '{"pattern":"export class","include":"src/**/*.ts"}'],
  ["read", '{"path":"package.json","limit":5}'],
  ["bash", '{"command":"node --version"}'],
  ["read", '{"path":42}'], // wrong type: watch the validation error
  ["teleport", "{}"], // a tool that doesn't exist
  ["edit", '{"path":"package.json","old_string":"arch_code","new_string":"x"}']
];

for (const [name, args] of calls) {
  const result = await registry.run({ id: "manual", type: "function", function: { name, arguments: args } }, ctx);
  console.log(`\n▶ ${name} ${args}${result.isError ? "  (error)" : ""}\n${result.output}`);
}
console.log("\nThe schemas the model will see:\n", JSON.stringify(registry.definitions(env)[0], null, 2));