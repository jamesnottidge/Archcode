//the whole idea of a coding agent is: 
//call the model;m if it asks for tools, run them and loop; if not, we're done. 

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import type {ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

process.loadEnvFile();

const client = new OpenAI({
    baseURL: process.env.ARCH_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY  
});

const model = process.env.ARCH_MODEL ?? "openrouter/free";

const tools: ChatCompletionTool[] = [
    {
        type: "function", 
        function: {
            name: "read", 
            description: "Read a text file", 
            parameters: {
                type: "object", 
                properties: {
                    path: {type: "string", description: "The path to the file to read."}
                }, 
                required: ["path"]
            }
        }
    }, 
    {
        type: "function", 
        function: {
            name: "bash", 
            description: "Run a shell command and read its output", 
            parameters: {
                type: "object", 
                parameters: {
                    type: "object", 
                    properties: {
                        path: {
                            type: "string", 
                            description: "The command that is to be run in the shell."
                        }, 
                        required: ["command"]
                    },
                },
            },
        },
    },
];

function runTool(name: string, args: Record<string, string>): string {
    try {
        if (name === "read") return readFileSync(args.path, "utf8");
        if (name === "bash") return execSync(args.command, {encoding: "utf8", timeout: 30_000});
        return `Unkown tool ${name}`;   
    } catch (err) {
        return `Error: ${(err as Error).message}`; //errors go back to the model, not up the stack. 
    }
}

const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "You are a coding agent. Use your tools to inspect the project before answering." },
    { role: "user", content: process.argv[2] ?? "How many TypeScript files are in this project, and what does the biggest one do?" },
  ];

  for (let step = 1; step <= 20; step++) { // a saefety cap while experimenting
    const response = await client.chat.completions.create({ model, messages, tools}); 
    const reply = response.choices[0].message;

    messages.push(reply);

    //@ts-expect-error
    console.log(reply.reasoning ?? ""); 
    const calls = (reply.tool_calls ?? []).filter((c) => c.type == "function");
    if (calls.length === 0) {
        console.log(` A RANDOM RESPONSE \n${reply.content}`); // no tool calls =  the model is done. 
    }
    for (const call of calls) {
        const args = JSON.parse(call.function.arguments)
        console.log(`step ${step}: ${call.function.name} ${JSON.stringify(args)}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: runTool(call.function.name, args) });
    }
  }
