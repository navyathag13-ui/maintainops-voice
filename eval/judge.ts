/**
 * LLM-as-judge calibration for the voice agent eval.
 *
 * Every conversation in eval/results/run*.json already has a ground-truth label
 * from the scripted checker in run-eval.ts (`correct`: the saved record matches the
 * expected equipment, parts and duration, or nothing was saved when nothing should be).
 * This script asks a local LLM to grade the same transcripts and measures how often
 * the judge agrees with that label, so we know whether an LLM judge could stand in
 * for the scripted checker on open-ended conversations that have no exact answer key.
 *
 * Two judge variants:
 *   rubric     - sees the transcript and the final saved record, plus a rubric
 *   reference  - additionally sees the expected outcome for the case
 *
 * Usage: npx tsx eval/judge.ts [--model qwen2.5:7b] [--variant rubric|reference|both] [--passes N] [--limit N]
 *   --passes N judges every failing conversation plus N passing ones (stable sample)
 * Verdicts are cached in eval/results/judge-<variant>-<model>.json so a run can be resumed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Variant = "rubric" | "reference";

export interface Turn {
  user: string;
  agent: string;
  tools?: { name: string; args: unknown; result: unknown }[];
}

export interface Trajectory {
  key: string; // run file + case id + mode, unique across runs
  run: string;
  id: string;
  mode: string;
  category: string;
  expected: unknown;
  submitted: unknown;
  submissions: number;
  turns: Turn[];
  label: boolean; // ground truth from the scripted checker
}

export interface Verdict {
  pass: boolean;
  reason: string;
}

export interface Metrics {
  n: number;
  tp: number; // judge pass, label pass
  tn: number; // judge fail, label fail
  fp: number; // judge pass, label fail  (the dangerous one: a bad run waved through)
  fn: number; // judge fail, label pass
  accuracy: number;
  kappa: number;
  falsePassRate: number; // fp / (label fails)
  falseFailRate: number; // fn / (label passes)
}

const RESULTS_DIR = join(import.meta.dirname ?? ".", "results");

export function loadTrajectories(dir = RESULTS_DIR): Trajectory[] {
  const files = readdirSync(dir)
    .filter((f) => /^run\d.*-\d{4}-\d{2}-\d{2}T.*\.json$/.test(f))
    .sort();
  const out: Trajectory[] = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const run = f.split("-20")[0];
    for (const r of data.results ?? []) {
      if (!Array.isArray(r.turns)) continue;
      out.push({
        key: `${run}/${r.id}/${r.mode}`,
        run,
        id: r.id,
        mode: r.mode,
        category: r.category,
        expected: r.expected,
        submitted: r.submitted ?? null,
        submissions: r.submissions ?? 0,
        turns: r.turns,
        label: !!r.correct,
      });
    }
  }
  return out;
}

/** Render a trajectory as plain text: who said what, which tools ran, what was saved. */
export function renderTranscript(t: Trajectory): string {
  const lines: string[] = [];
  t.turns.forEach((turn, i) => {
    lines.push(`Turn ${i + 1}`);
    lines.push(`  Technician: ${turn.user}`);
    for (const tool of turn.tools ?? []) {
      lines.push(`  [tool ${tool.name}] args=${JSON.stringify(tool.args)} result=${JSON.stringify(tool.result)}`);
    }
    lines.push(`  Agent: ${turn.agent}`);
  });
  lines.push("");
  lines.push(
    t.submissions > 0
      ? `Final record saved to the system: ${JSON.stringify(t.submitted)}`
      : "Final record saved to the system: nothing was saved",
  );
  return lines.join("\n");
}

const RUBRIC = `You are grading a voice assistant that turns a maintenance technician's spoken log into a saved maintenance record.
The run PASSES only if the outcome is right:
- If the technician described a complete job, exactly one record was saved, with the right equipment, the right parts and quantities, and the right duration in minutes.
- If something was unclear (several matching machines, an unknown part, not enough stock, a missing duration), the assistant asked and the saved record reflects the technician's answer, never a guess.
- If the technician cancelled, or the job cannot be logged, nothing was saved.
The run FAILS if a wrong or guessed value was saved, a part or quantity was dropped, or a record that should have been saved never was.
Reply with JSON only: {"pass": true or false, "reason": "one short sentence"}`;

export function buildPrompt(t: Trajectory, variant: Variant): { system: string; user: string } {
  let user = `Transcript:\n${renderTranscript(t)}`;
  if (variant === "reference") {
    user += `\n\nExpected outcome for this case (answer key): ${JSON.stringify(t.expected)}`;
    user += `\n("submit": false means nothing should be saved; parts lists the exact part names and quantities.)`;
  }
  return { system: RUBRIC, user };
}

/** Parse the judge's reply. Anything unparseable counts as a FAIL, so the judge can't pass a run by accident. */
export function parseVerdict(raw: string): Verdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { pass: false, reason: `unparseable: ${raw.slice(0, 80)}` };
  try {
    const obj = JSON.parse(match[0]);
    const pass = obj.pass === true || obj.pass === "true";
    return { pass, reason: String(obj.reason ?? "") };
  } catch {
    return { pass: false, reason: `unparseable: ${raw.slice(0, 80)}` };
  }
}

export function computeMetrics(pairs: { label: boolean; judge: boolean }[]): Metrics {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const { label, judge } of pairs) {
    if (judge && label) tp++;
    else if (!judge && !label) tn++;
    else if (judge && !label) fp++;
    else fn++;
  }
  const n = pairs.length;
  const po = n ? (tp + tn) / n : 0;
  // Cohen's kappa: agreement beyond what the two raters' base rates would give by chance.
  const pYes = n ? ((tp + fp) / n) * ((tp + fn) / n) : 0;
  const pNo = n ? ((tn + fn) / n) * ((tn + fp) / n) : 0;
  const pe = pYes + pNo;
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return {
    n, tp, tn, fp, fn,
    accuracy: round(po),
    kappa: round(kappa),
    falsePassRate: round(fp + tn ? fp / (fp + tn) : 0),
    falseFailRate: round(tp + fn ? fn / (tp + fn) : 0),
  };
}

/** Every failing conversation plus `passes` passing ones, picked by a stable hash so reruns choose the same set. */
export function stratifiedSample(all: Trajectory[], passes: number): Trajectory[] {
  const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
  const fails = all.filter((t) => !t.label);
  const ok = all.filter((t) => t.label).sort((a, b) => hash(a.key) - hash(b.key)).slice(0, passes);
  return [...fails, ...ok].sort((a, b) => a.key.localeCompare(b.key));
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

async function askOllama(model: string, system: string, user: string): Promise<{ raw: string; ms: number }> {
  const started = Date.now();
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { temperature: 0, seed: 7 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return { raw: body.message?.content ?? "", ms: Date.now() - started };
}

async function runVariant(model: string, variant: Variant, trajectories: Trajectory[]) {
  const cachePath = join(RESULTS_DIR, `judge-${variant}-${model.replace(/[:/]/g, "_")}.json`);
  const cache: Record<string, Verdict & { ms: number; label: boolean; category: string }> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf8")).verdicts
    : {};
  let done = 0;
  for (const t of trajectories) {
    if (!cache[t.key]) {
      const { system, user } = buildPrompt(t, variant);
      const { raw, ms } = await askOllama(model, system, user);
      cache[t.key] = { ...parseVerdict(raw), ms, label: t.label, category: t.category };
      writeFileSync(cachePath, JSON.stringify({ model, variant, verdicts: cache }, null, 1));
    }
    done++;
    if (done % 25 === 0) console.log(`  ${variant}: ${done}/${trajectories.length}`);
  }
  const pairs = trajectories.map((t) => ({ label: t.label, judge: cache[t.key].pass }));
  const metrics = computeMetrics(pairs);
  const ms = trajectories.map((t) => cache[t.key].ms).sort((a, b) => a - b);
  const falsePasses = trajectories.filter((t) => !t.label && cache[t.key].pass).map((t) => t.key);
  const summary = { model, variant, ...metrics, median_ms: ms[Math.floor(ms.length / 2)], false_passes: falsePasses };
  writeFileSync(cachePath, JSON.stringify({ model, variant, summary, verdicts: cache }, null, 1));
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string, dflt: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const model = get("--model", "qwen2.5:7b");
  const which = get("--variant", "both");
  const limit = Number(get("--limit", "0"));
  const passes = Number(get("--passes", "0"));
  let trajectories = loadTrajectories();
  if (passes > 0) trajectories = stratifiedSample(trajectories, passes);
  if (limit > 0) trajectories = trajectories.slice(0, limit);
  const fails = trajectories.filter((t) => !t.label).length;
  console.log(`${trajectories.length} labeled conversations (${fails} fail by the scripted checker); judge ${model}`);
  const variants: Variant[] = which === "both" ? ["rubric", "reference"] : [which as Variant];
  for (const v of variants) {
    const s = await runVariant(model, v, trajectories);
    console.log(JSON.stringify(s));
  }
}

if (process.argv[1] && process.argv[1].endsWith("judge.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
