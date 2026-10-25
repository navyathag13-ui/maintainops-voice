// Compares one-shot local transcription (new Python process + model load per
// call) with the persistent WhisperWorker, on the eval's audio clips.
//   npx tsx eval/bench-stt.ts
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../src/config.js";
import { transcribeLocal, WhisperWorker } from "../src/local.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = getConfig();
const clips = (await readdir(join(here, "audio"))).filter((f) => f.endsWith(".wav")).sort();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const oneShot: number[] = [];
for (const f of clips) {
  const audio = await readFile(join(here, "audio", f));
  const t0 = performance.now();
  await transcribeLocal(cfg.whisperCmd, cfg.localWhisperModel, audio, f);
  oneShot.push(Math.round(performance.now() - t0));
}

const worker = new WhisperWorker(cfg.whisperCmd, cfg.localWhisperModel);
const s0 = performance.now();
await worker.start();
const workerStartMs = Math.round(performance.now() - s0);
const persistent: number[] = [];
for (const f of clips) {
  const audio = await readFile(join(here, "audio", f));
  const t0 = performance.now();
  await worker.transcribe(audio, f);
  persistent.push(Math.round(performance.now() - t0));
}
worker.stop();

const result = {
  ran_at: new Date().toISOString(),
  model: cfg.localWhisperModel,
  clips,
  one_shot_ms: oneShot,
  persistent_ms: persistent,
  worker_start_ms: workerStartMs,
  median_one_shot_ms: median(oneShot),
  median_persistent_ms: median(persistent),
};
await writeFile(join(here, "results", "bench-stt.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
