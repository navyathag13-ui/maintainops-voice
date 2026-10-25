import type { Agent, TurnResult } from "./agent.js";

export interface Speech {
  transcribe(audio: Buffer, filename: string, mimeType: string): Promise<string>;
  synthesize(text: string): Promise<Buffer>;
  // MIME type of what synthesize() returns (mp3 from OpenAI, m4a from macOS say)
  audioMime: string;
}

export interface TurnInput {
  text?: string;
  audio?: { data: Buffer; filename: string; mimeType: string };
  speak?: boolean;
}

export interface TurnOutput extends TurnResult {
  transcript: string;
  audio: Buffer | null;
  timings: { sttMs: number; llmMs: number; ttsMs: number; totalMs: number };
}

// One technician turn: (audio -> text) -> agent -> (text -> audio).
// Shared by the HTTP server and the eval script so both measure the same path.
export async function runTurn(agent: Agent, speech: Speech, input: TurnInput): Promise<TurnOutput> {
  const start = performance.now();
  let transcript = input.text?.trim() ?? "";
  let sttMs = 0;
  if (input.audio) {
    const t0 = performance.now();
    transcript = await speech.transcribe(input.audio.data, input.audio.filename, input.audio.mimeType);
    sttMs = performance.now() - t0;
  }
  if (!transcript) throw new Error("Empty turn: no text and no speech recognized");

  const result = await agent.turn(transcript);

  let audio: Buffer | null = null;
  let ttsMs = 0;
  if (input.speak !== false) {
    const t0 = performance.now();
    audio = await speech.synthesize(result.reply);
    ttsMs = performance.now() - t0;
  }
  return {
    ...result,
    transcript,
    audio,
    timings: { sttMs, llmMs: result.llmMs, ttsMs, totalMs: performance.now() - start },
  };
}
