// Free local speech: faster-whisper for STT and macOS `say` for TTS. No network calls.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mov-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// One-shot transcription: starts Python and loads the model on every call.
// Kept for the latency comparison in eval/bench-stt.ts; the server uses WhisperWorker.
export function transcribeLocal(python: string, model: string, audio: Buffer, filename: string): Promise<string> {
  return withTempDir(async (dir) => {
    const path = join(dir, `in${extname(filename) || ".webm"}`);
    await writeFile(path, audio);
    const script = join(import.meta.dirname, "..", "scripts", "transcribe.py");
    const { stdout } = await run(python, [script, path, model], { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  });
}

// A persistent faster-whisper process (scripts/whisper_worker.py): the model is
// loaded once, then each transcription is one JSON line in and one out.
export class WhisperWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();

  constructor(private python: string, private model: string) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const script = join(import.meta.dirname, "..", "scripts", "whisper_worker.py");
    const proc = spawn(this.python, [script, this.model]);
    this.proc = proc;
    this.ready = new Promise((resolve, reject) => {
      createInterface({ input: proc.stdout }).on("line", (line) => {
        const msg = JSON.parse(line) as { ready?: boolean; id?: number; text?: string; error?: string };
        if (msg.ready) return resolve();
        const w = this.waiting.get(msg.id!);
        if (!w) return;
        this.waiting.delete(msg.id!);
        if (msg.error) w.reject(new Error(`whisper: ${msg.error}`));
        else w.resolve((msg.text ?? "").trim());
      });
      proc.on("exit", (code) => {
        const err = new Error(`whisper worker exited (${code})`);
        reject(err);
        for (const w of this.waiting.values()) w.reject(err);
        this.waiting.clear();
        this.proc = null;
        this.ready = null;
      });
    });
    return this.ready;
  }

  async transcribe(audio: Buffer, filename: string): Promise<string> {
    await this.start();
    return withTempDir(async (dir) => {
      const path = join(dir, `in${extname(filename) || ".webm"}`);
      await writeFile(path, audio);
      const id = this.nextId++;
      const text = new Promise<string>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
      this.proc!.stdin.write(JSON.stringify({ id, path }) + "\n");
      return text;
    });
  }

  stop() {
    this.proc?.kill();
  }
}

export function synthesizeLocal(voice: string, text: string): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const m4a = join(dir, "out.m4a");
    // say can write AAC directly; this replaced a say -> AIFF -> afconvert step.
    await run("say", ["-v", voice, "--file-format=m4af", "--data-format=aac", "-o", m4a, text]);
    return readFile(m4a);
  });
}

// Loads the Ollama model and asks it to stay in memory, so the first real turn
// (and turns after an idle gap) don't pay for loading the weights.
export async function warmOllama(openAiBaseUrl: string, model: string, keepAlive = "60m"): Promise<number> {
  const t0 = performance.now();
  const base = openAiBaseUrl.replace(/\/v1\/?$/, "");
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model, prompt: "", keep_alive: keepAlive }),
  });
  if (!res.ok) throw new Error(`Ollama warm-up failed: ${res.status}`);
  await res.text();
  return performance.now() - t0;
}
