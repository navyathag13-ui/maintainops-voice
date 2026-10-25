// Free local speech: faster-whisper (via scripts/transcribe.py) for STT and
// macOS `say` + `afconvert` for TTS. No network calls.
import { execFile } from "node:child_process";
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

export function transcribeLocal(python: string, model: string, audio: Buffer, filename: string): Promise<string> {
  return withTempDir(async (dir) => {
    const path = join(dir, `in${extname(filename) || ".webm"}`);
    await writeFile(path, audio);
    const script = join(import.meta.dirname, "..", "scripts", "transcribe.py");
    const { stdout } = await run(python, [script, path, model], { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  });
}

export function synthesizeLocal(voice: string, text: string): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const aiff = join(dir, "out.aiff");
    const m4a = join(dir, "out.m4a");
    await run("say", ["-v", voice, "-o", aiff, text]);
    await run("afconvert", ["-f", "m4af", "-d", "aac", aiff, m4a]);
    return readFile(m4a);
  });
}
