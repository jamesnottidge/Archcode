import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

process.loadEnvFile();

const client = new OpenAI({
    baseURL: process.env.ARCH_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

const model = process.env.ARCH_MODEL ?? "openrouter/free";

const history: ChatCompletionMessageParam[] = [
    { role: "system", content: "You are a concise assistant." },
];


async function say(text: string): Promise<void> {
    history.push({ role: "user", content: text });
    const response = await client.chat.completions.create({
        model,
        messages: history,
    });
    const reply = response.choices[0].message.content;
    history.push({ role: "assistant", content: reply });
    console.log(`you: ${text}\n${model}: ${reply}`);
}




await say("My name is James. Remember it.");
await say("What is my name?");

console.log(`We sent ${history.length} messages to the model. That array IS the memory.`);