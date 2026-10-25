import { existsSync, readFileSync } from "node:fs";

// Minimal .env loader so the service has no dotenv dependency. Values already
// in the environment win.
export function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function getConfig() {
  loadDotEnv();
  return {
    // "openai" (paid API) or "local" (Ollama + faster-whisper + macOS say, no cost)
    provider: (process.env.PROVIDER ?? "openai") as "openai" | "local",
    openaiKey: process.env.OPENAI_API_KEY ?? "",
    // Which maintenance system logs are written to: "maintainops" or "odoo".
    backend: (process.env.BACKEND ?? "maintainops") as "maintainops" | "odoo",
    maintainopsUrl: process.env.MAINTAINOPS_URL ?? "http://localhost:8000",
    odooUrl: process.env.ODOO_URL ?? "http://localhost:8069",
    odooDb: process.env.ODOO_DB ?? "voice",
    odooUser: process.env.ODOO_USER ?? "admin",
    odooPassword: process.env.ODOO_PASSWORD ?? "admin",
    port: Number(process.env.PORT ?? 3001),
    sttModel: process.env.STT_MODEL ?? "whisper-1",
    llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
    ttsModel: process.env.TTS_MODEL ?? "tts-1",
    ttsVoice: process.env.TTS_VOICE ?? "alloy",
    ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434/v1",
    localLlmModel: process.env.LOCAL_LLM_MODEL ?? "qwen2.5:7b",
    whisperCmd: process.env.WHISPER_CMD ?? ".venv/bin/python",
    localWhisperModel: process.env.LOCAL_WHISPER_MODEL ?? "base.en",
    sayVoice: process.env.SAY_VOICE ?? "Samantha",
    historyPath: process.env.HISTORY_PATH ?? "data/history.json",
    turnLogPath: process.env.TURN_LOG_PATH ?? "data/turns.jsonl",
  };
}

export type Config = ReturnType<typeof getConfig>;
