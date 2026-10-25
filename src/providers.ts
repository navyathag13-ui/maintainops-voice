import type { Config } from "./config.js";
import { OpenAiChat, synthesize, transcribe, type LlmClient } from "./openai.js";
import { synthesizeLocal, transcribeLocal } from "./local.js";
import type { Speech } from "./pipeline.js";

export interface Providers {
  llm: LlmClient;
  speech: Speech;
  label: { provider: string; stt: string; llm: string; tts: string };
}

export function buildProviders(cfg: Config): Providers {
  if (cfg.provider === "local") {
    return {
      // Ollama serves an OpenAI-compatible /v1/chat/completions with tool calling.
      llm: new OpenAiChat("ollama", cfg.localLlmModel, cfg.ollamaUrl),
      speech: {
        transcribe: (audio, filename) => transcribeLocal(cfg.whisperCmd, cfg.localWhisperModel, audio, filename),
        synthesize: (text) => synthesizeLocal(cfg.sayVoice, text),
        audioMime: "audio/mp4",
      },
      label: { provider: "local", stt: `faster-whisper ${cfg.localWhisperModel}`, llm: `ollama ${cfg.localLlmModel}`, tts: `macOS say (${cfg.sayVoice})` },
    };
  }
  if (!cfg.openaiKey) throw new Error("OPENAI_API_KEY is not set (or use PROVIDER=local; see .env.example)");
  return {
    llm: new OpenAiChat(cfg.openaiKey, cfg.llmModel),
    speech: {
      transcribe: (audio, filename, mime) => transcribe(cfg.openaiKey, cfg.sttModel, audio, filename, mime),
      synthesize: (text) => synthesize(cfg.openaiKey, cfg.ttsModel, cfg.ttsVoice, text),
      audioMime: "audio/mpeg",
    },
    label: { provider: "openai", stt: cfg.sttModel, llm: cfg.llmModel, tts: cfg.ttsModel },
  };
}
