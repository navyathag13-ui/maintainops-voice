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
    maintainopsUrl: process.env.MAINTAINOPS_URL ?? "http://localhost:8000",
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
  };
}

export type Config = ReturnType<typeof getConfig>;
