// Where do we send model requests, ans with which key?
// Every provider below speaks the same "OpenAI-compatible" chat API, 
// so switching providers is just a different base URL, key and model name. 

export type ProviderName = "openrouter" | "gemini" | "ollama" | "fake";

interface ProviderPreset {
    baseURL: string;
    apiKeyEnv?: string; //which env var holds the key (local providers need none)
    defaultModel: string; 
}

const PRESETS: Record<ProviderName, ProviderPreset> = {
    openrouter: {
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      defaultModel: "qwen/qwen3-coder:free",
    },
    gemini: {
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKeyEnv: "GEMINI_API_KEY",
      defaultModel: "gemini-flash-latest",
    },
    ollama: {
      baseURL: "http://localhost:11434/v1",
      defaultModel: "qwen3.6:27b",
    },
    fake: {
      baseURL: "http://localhost:4141/v1",
      defaultModel: "fake-model",
    },
  };
  
export interface Config {
    provider: ProviderName;
    baseURL: string;
    apiKey: string;
    model: string;
    cwd: string; // the project the agent works on
    dataDir: string; // where sessions and traces are stored
}

// Load arch-code's own .env file (next to package.json), no matter which
// directory you launch the agent from. Variables already set in your shell win.
export function loadDotEnv(): void {
    try {
      process.loadEnvFile(new URL("../.env", import.meta.url));
    } catch {
      // No .env file: fine, the variables may come from the shell.
    }
  }
  

// load the config 
export function loadConfig(overrides: {model?: string} = {}): Config {
    const provider = (process.env.ARCH_PROVIDER ?? "openrouter") as ProviderName;
    const preset = PRESETS[provider];

    if (!preset) {
        throw new Error(
          `Unknown ARCH_PROVIDER "${provider}". Use one of: ${Object.keys(PRESETS).join(", ")}`,
        );
      }
    
    let apiKey = "not-needed"; // the client library insists on a non-empty string

    if (preset.apiKeyEnv) {
        const key =  process.env[preset.apiKeyEnv]
        if (!key) {
            throw new Error(`Missing ${preset.apiKeyEnv}. Add it to arch-code/.env (see .env.example).`);
        }
        apiKey = key;
    }

    const cwd = process.cwd();

    return {
        provider, 
        baseURL: process.env.ARCH_BASE_URL ?? preset.baseURL, 
        apiKey,
        model: overrides.model ?? process.env.ARCH_MODEL ?? preset.defaultModel,
        cwd, 
        dataDir: `${cwd}/.arch-code`
    }
}