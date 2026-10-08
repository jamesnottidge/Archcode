import { readFileSync } from "node:fs";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

process.loadEnvFile();

const client = new OpenAI({
    baseURL: process.env.ARCH_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

const model = process.env.ARCH_MODEL ?? "openrouter/free";

// 1. Describe a tool that can be used by the model. The model never runs code, it only sees this description.

const tools: ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "read", 
            description: "Read a text file and return its contents.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "The path to the file to read." },
                },
                required: ["path"],
            },
        }
    }
];

const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "You are a helpful assistant that can read text files." },
    { role: "user", content: "What is the description of the project in package.json?" },
];


// 2. Call the model with the tools.

const first = await client.chat.completions.create({
    model,
    messages,
    tools,
});

const assistant = first.choices[0].message;

console.log (assistant);

//@ts-expect-error
console.log("1. model replied:", JSON.stringify(assistant.reasoning, null, 2));


messages.push(assistant);


// 3. We run the tool.
for (const toolCall of assistant.tool_calls ?? []) {
    if (toolCall.type !== "function") continue;
    const args = JSON.parse(toolCall.function.arguments) as {path: string};
    const content = readFileSync(args.path, "utf-8");
    console.log(`2. We ran ${toolCall.function.name}(${args.path})->  ${content.length} characters.`);
    messages.push({role: "tool", tool_call_id: toolCall.id, content})
}


const second = await client.chat.completions.create({
    model,
    messages, 
    tools
});


console.log("3 final answer:", second.choices[0].message.content);