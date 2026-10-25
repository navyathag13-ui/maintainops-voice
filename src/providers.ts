import type { Config } from "./config.js";
import { OpenAiChat, synthesize, transcribe, type LlmClient } from "./openai.js";
import { synthesizeLocal, warmOllama, WhisperWorker } from "./local.js";
import type { Speech } from "./pipeline.js";
import { MaintainOpsClient, type MaintenanceBackend } from "./maintainops.js";
import { OdooBackend, OdooRpc } from "./odoo.js";

export function buildBackend(cfg: Config): { backend: MaintenanceBackend; label: string } {
  if (cfg.backend === "odoo") {
    return { backend: new OdooBackend(new OdooRpc(cfg.odooUrl, cfg.odooDb, cfg.odooUser, cfg.odooPassword)), label: `odoo ${cfg.odooUrl}/${cfg.odooDb}` };
  }
  return { backend: new MaintainOpsClient(cfg.maintainopsUrl), label: `maintainops ${cfg.maintainopsUrl}` };
}

export interface Providers {
  llm: LlmClient;
  speech: Speech;
  label: { provider: string; stt: string; llm: string; tts: string };
  // Load models before the first turn (local mode). Resolves to the time it took.
  warm?: () => Promise<number>;
  close?: () => void;
}

export function buildProviders(cfg: Config): Providers {
  if (cfg.provider === "local") {
    const whisper = new WhisperWorker(cfg.whisperCmd, cfg.localWhisperModel);
    return {
      // Ollama serves an OpenAI-compatible /v1/chat/completions with tool calling.
      llm: new OpenAiChat("ollama", cfg.localLlmModel, cfg.ollamaUrl),
      speech: {
        transcribe: (audio, filename) => whisper.transcribe(audio, filename),
        synthesize: (text) => synthesizeLocal(cfg.sayVoice, text),
        audioMime: "audio/mp4",
      },
      label: { provider: "local", stt: `faster-whisper ${cfg.localWhisperModel}`, llm: `ollama ${cfg.localLlmModel}`, tts: `macOS say (${cfg.sayVoice})` },
      warm: async () => {
        const t0 = performance.now();
        await Promise.all([whisper.start(), warmOllama(cfg.ollamaUrl, cfg.localLlmModel)]);
        return performance.now() - t0;
      },
      close: () => whisper.stop(),
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
