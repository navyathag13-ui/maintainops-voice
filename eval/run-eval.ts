// Runs the scripted cases through the real pipeline (STT for audio cases, LLM
// tool calling, TTS) against a live MaintainOps. PROVIDER=local runs it free on
// this machine (faster-whisper, Ollama, macOS say); the default is the OpenAI API.
// A simulated technician answers the agent from each case's `answers`.
//
//   npm run eval                  all 20 text cases + the audio variants
//   npm run eval -- --only c08    cases whose id starts with c08
//   npm run eval -- --no-audio    text cases only
//
// Successful cases write real maintenance logs and consume real stock in MaintainOps.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent.js";
import { getConfig } from "../src/config.js";
import { MaintainOpsClient, type MaintenanceLogCreate } from "../src/maintainops.js";
import { runTurn } from "../src/pipeline.js";
import { buildBackend, buildProviders } from "../src/providers.js";
import { tokens } from "../src/matching.js";
import { isConfirmation } from "../src/confirm.js";
import { spokenSummary, type ResolvedDraft } from "../src/schema.js";

interface Case {
  id: string;
  category: string;
  mistake?: boolean;
  utterance: string;
  answers: { confirm?: string[]; missing?: string } & Record<string, string | string[] | undefined>;
  expected: { submit: boolean; equipment?: string; parts?: Record<string, number>; duration_minutes?: number };
  precondition?: { part: string; below: number };
  heldout?: boolean;
}

type Expected = Case["expected"];

// How the simulated technician says things it knows: what it actually did.
const spokenEq = (name = "") => name.replace(/\s*#0*(\d+)/, " $1");
const partsPhrase = (p: Record<string, number> = {}) =>
  Object.keys(p).length ? Object.entries(p).map(([n, q]) => `${q} ${n}`).join(" and ") : "no parts";
const fullLog = (e: Expected) => `${spokenEq(e.equipment)}, ${partsPhrase(e.parts)}, ${e.duration_minutes} minutes`;

function matchesExpected(d: ResolvedDraft, e: Expected): boolean {
  const got = Object.fromEntries(d.parts.map((p) => [p.name, p.quantity]));
  return (
    d.equipment.name === e.equipment &&
    d.duration_minutes === e.duration_minutes &&
    JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(e.parts ?? {}).sort())
  );
}

// Answer for a clarifying question the case didn't script, from what the technician meant.
function oracleAnswer(code: string, e: Expected): string {
  if (!e.submit) return "Never mind, cancel it.";
  if (code === "ambiguous_equipment" || code === "unknown_equipment") return `${spokenEq(e.equipment)}.`;
  if (code === "missing_duration") return `${e.duration_minutes} minutes.`;
  if (code === "invalid_fields") return `It was ${fullLog(e)}.`;
  return Object.keys(e.parts ?? {}).length ? `The parts were ${partsPhrase(e.parts)}.` : "No parts from the storeroom.";
}

function oracleForQuestion(question: string, e: Expected): string {
  if (!e.submit) return "Never mind, cancel it.";
  if (/how long|duration|minutes|time/i.test(question)) return `${e.duration_minutes} minutes.`;
  if (/which|what equipment|machine|asset/i.test(question)) return `${spokenEq(e.equipment)}.`;
  return `It was ${fullLog(e)}.`;
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const withAudio = !args.includes("--no-audio");
const withReal = args.includes("--real");
const MAX_TURNS = 7;

const cfg = getConfig();
const providers = buildProviders(cfg);
const { backend: client, label: backendLabel } = buildBackend(cfg);
const speech = providers.speech;

function wer(ref: string, hyp: string): number {
  const r = tokens(ref);
  const h = tokens(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? d[r.length][h.length] / r.length : 0;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};

type Mode = "text" | "audio" | "real";

async function runCase(c: Case, mode: Mode, audioPath?: string, speaker?: string) {
  const equipment = await client.listEquipment();
  const parts = await client.listParts();
  if (c.precondition) {
    const p = parts.find((x) => x.name === c.precondition!.part);
    if (!p || p.quantity_on_hand >= c.precondition.below) {
      return { id: c.id, mode, skipped: `precondition failed: ${c.precondition.part} stock is ${p?.quantity_on_hand}` };
    }
  }

  const created: MaintenanceLogCreate[] = [];
  const api = {
    listEquipment: () => client.listEquipment(),
    listParts: () => client.listParts(),
    listEmployees: () => client.listEmployees(),
    createMaintenanceLog: async (b: MaintenanceLogCreate) => {
      const r = await client.createMaintenanceLog(b);
      if (r.ok) created.push(b);
      return r;
    },
  };
  const agent = new Agent(providers.llm, api, undefined, cfg.backend === "odoo" ? "Odoo" : "MaintainOps");
  const confirmQueue = [...(c.answers.confirm ?? [])];
  const used = new Set<string>();

  const turns: Record<string, unknown>[] = [];
  const issueCodesSeen = new Set<string>();
  let clarifyingQuestions = 0;
  let oracleAnswers = 0;
  const readbackCorrections: { heard: string }[] = [];
  const e = c.expected;
  let next: { text?: string; audioPath?: string } =
    audioPath ? { audioPath } : { text: c.utterance };

  for (let t = 0; t < MAX_TURNS; t++) {
    const out = await runTurn(agent, speech, {
      text: next.text,
      audio: next.audioPath ? { data: await readFile(next.audioPath), filename: basename(next.audioPath), mimeType: "audio/*" } : undefined,
    });
    const turnIssues = out.toolCalls.flatMap((tc) => ((tc.result as { issues?: { code: string }[] })?.issues ?? []));
    turnIssues.forEach((i) => issueCodesSeen.add(i.code));
    turns.push({
      user: out.transcript,
      ...(next.audioPath ? { wer: Number(wer(c.utterance, out.transcript).toFixed(3)) } : {}),
      agent: out.reply,
      tools: out.toolCalls,
      timings: Object.fromEntries(Object.entries(out.timings).map(([k, v]) => [k, Math.round(v)])),
      llmCalls: out.llmCalls,
      awaitingConfirmation: out.state.pending !== null,
    });

    if (out.state.submitted) break;
    let answer: string | undefined;
    if (out.state.pending) {
      // The technician listens to the read-back. Scripted replies (a cancel, a
      // deliberate correction) come first; otherwise they say yes only if the
      // read-back is what they meant, and correct it if not.
      if (confirmQueue.length && !isConfirmation(confirmQueue[0])) {
        answer = confirmQueue.shift();
      } else {
        confirmQueue.shift();
        const d = out.state.pending.draft;
        if (!e.submit || matchesExpected(d, e)) {
          answer = "Yes.";
        } else {
          readbackCorrections.push({ heard: spokenSummary(d) });
          answer = `No. It was ${fullLog(e)}.`;
        }
      }
    } else if (turnIssues.length) {
      clarifyingQuestions++;
      const code = turnIssues[0].code;
      const a = c.answers[code];
      answer = typeof a === "string" && !used.has(code) ? a : oracleAnswer(code, e);
      if (!(typeof a === "string") || used.has(code)) oracleAnswers++;
      used.add(code);
    } else if (out.reply.includes("?")) {
      clarifyingQuestions++;
      if (c.answers.missing && !used.has("missing")) {
        answer = c.answers.missing;
        used.add("missing");
      } else {
        oracleAnswers++;
        answer = oracleForQuestion(out.reply, e);
      }
    } else {
      break; // agent made a statement and isn't waiting on anything
    }
    next = { text: answer };
  }

  const eqName = (id: number) => equipment.find((e) => e.id === id)?.name;
  const partName = (id: number) => parts.find((p) => p.id === id)?.name ?? `#${id}`;
  const submitted = created[0]
    ? {
        equipment: eqName(created[0].equipment_id),
        parts: Object.fromEntries(created[0].parts_used.map((p) => [partName(p.part_id), p.quantity])),
        duration_minutes: Number(created[0].description.match(/Duration: (\d+) min/)?.[1]),
        description: created[0].description,
      }
    : null;

  const fields = submitted && e.submit
    ? {
        equipment: submitted.equipment === e.equipment,
        parts: JSON.stringify(Object.entries(submitted.parts).sort()) === JSON.stringify(Object.entries(e.parts ?? {}).sort()),
        duration_minutes: submitted.duration_minutes === e.duration_minutes,
      }
    : null;
  const correct = e.submit ? !!fields && Object.values(fields).every(Boolean) : created.length === 0;
  return {
    id: c.id,
    mode,
    speaker: speaker ?? null,
    category: c.category,
    mistake: !!c.mistake,
    expected: e,
    submitted,
    submissions: created.length,
    fields,
    correct,
    wrongSubmission: created.length > 0 && !correct,
    clarifyingQuestions,
    issueCodesSeen: [...issueCodesSeen],
    oracleAnswers,
    readbackCorrections,
    heldout: !!c.heldout,
    turns,
  };
}

async function main() {
  const cases = (JSON.parse(await readFile(join(here, "cases.json"), "utf8")) as Case[]).filter(
    (c) => !only || c.id.startsWith(only),
  );
  const runs: { c: Case; mode: Mode; audioPath?: string; speaker?: string }[] = withReal ? [] : cases.map((c) => ({ c, mode: "text" as const }));
  if (withAudio && !withReal) {
    for (const c of cases) {
      const p = join(here, "audio", `${c.id}.wav`);
      if (existsSync(p)) runs.push({ c, mode: "audio", audioPath: p });
    }
  }
  if (withReal) {
    // eval/real/audio/<speaker>__<case id>.<ext>: recordings of real people.
    const dir = join(here, "real", "audio");
    for (const f of existsSync(dir) ? (await readdir(dir)).sort() : []) {
      const m = f.match(/^(.+?)__(.+)\.(m4a|wav|mp3|webm|ogg)$/i);
      const c = m && cases.find((x) => x.id === m[2]);
      if (c) runs.push({ c, mode: "real", audioPath: join(dir, f), speaker: m![1] });
      else if (f !== ".gitkeep") console.log(`skipping ${f}: expected <speaker>__<case id>.<ext> with a known case id`);
    }
    if (!runs.length) {
      console.log("No recordings in eval/real/audio/ (see eval/real/README.md).");
      providers.close?.();
      return;
    }
  }

  // Load models once before timing anything (Whisper worker + Ollama weights
  // in local mode). Reported, not averaged into per-turn latency.
  const w0 = performance.now();
  if (providers.warm) await providers.warm();
  else await providers.llm.complete([{ role: "user", content: "Say ok." }], []);
  const warmupMs = Math.round(performance.now() - w0);
  console.log(`Warm-up: ${warmupMs} ms`);

  const results: Awaited<ReturnType<typeof runCase>>[] = [];
  for (const { c, mode, audioPath, speaker } of runs) {
    process.stdout.write(`${c.id} [${mode}] ... `);
    try {
      const r = await runCase(c, mode, audioPath, speaker);
      results.push(r);
      console.log("skipped" in r ? r.skipped : r.correct ? "ok" : "WRONG");
    } catch (err) {
      results.push({ id: c.id, mode, skipped: `error: ${(err as Error).message}` } as never);
      console.log(`error: ${(err as Error).message}`);
    }
  }

  const done = results.filter((r) => !("skipped" in r)) as Exclude<(typeof results)[number], { skipped: string }>[];
  const fieldRows = done.filter((r) => r.fields);
  const fieldAcc = (k: "equipment" | "parts" | "duration_minutes") =>
    fieldRows.length ? fieldRows.filter((r) => r.fields![k]).length / fieldRows.length : null;
  const mistakes = done.filter((r) => r.mistake);
  const allTurns = done.flatMap((r) => r.turns as { timings: Record<string, number>; wer?: number }[]);
  const audioTurns = allTurns.filter((t) => t.wer !== undefined);
  const lat = (key: string, ts = allTurns) => ({
    median: pct(ts.map((t) => t.timings[key]), 50),
    p95: pct(ts.map((t) => t.timings[key]), 95),
  });

  const summary = {
    ran_at: new Date().toISOString(),
    backend: backendLabel,
    models: providers.label,
    warmup_ms: warmupMs,
    runs: results.length,
    completed: done.length,
    skipped: results.filter((r) => "skipped" in r).map((r) => ({ id: r.id, mode: r.mode, why: (r as { skipped: string }).skipped })),
    correct_outcomes: done.filter((r) => r.correct).length,
    wrong_submissions: done.filter((r) => r.wrongSubmission).map((r) => `${r.id} [${r.mode}]`),
    field_accuracy: {
      cases_scored: fieldRows.length,
      equipment: fieldAcc("equipment"),
      parts: fieldAcc("parts"),
      duration_minutes: fieldAcc("duration_minutes"),
    },
    mistakes: {
      cases_with_mistake: mistakes.length,
      caught: mistakes.filter((r) => r.correct).length,
      caught_ids: mistakes.filter((r) => r.correct).map((r) => `${r.id} [${r.mode}]`),
      missed_ids: mistakes.filter((r) => !r.correct).map((r) => `${r.id} [${r.mode}]`),
    },
    oracle_answers: done.reduce((n, r) => n + r.oracleAnswers, 0),
    readback_corrections: {
      total: done.reduce((n, r) => n + r.readbackCorrections.length, 0),
      runs: done.filter((r) => r.readbackCorrections.length).map((r) => `${r.id} [${r.mode}]`),
    },
    heldout: {
      runs: done.filter((r) => r.heldout).length,
      correct: done.filter((r) => r.heldout && r.correct).length,
      wrong_submissions: done.filter((r) => r.heldout && r.wrongSubmission).map((r) => r.id),
    },
    turns: allTurns.length,
    latency_ms: {
      total_per_turn: lat("totalMs"),
      llm_per_turn: lat("llmMs"),
      tts_per_turn: lat("ttsMs"),
      stt_audio_turns: lat("sttMs", audioTurns),
      total_audio_turns: lat("totalMs", audioTurns),
    },
    real_voice: withReal
      ? Object.fromEntries(
          [...new Set(done.map((r) => r.speaker))].map((sp) => {
            const mine = done.filter((r) => r.speaker === sp);
            const w = mine.map((r) => (r.turns[0] as { wer?: number }).wer ?? 0);
            return [sp, { runs: mine.length, correct: mine.filter((r) => r.correct).length, wrong_submissions: mine.filter((r) => r.wrongSubmission).length, first_turn_wer_mean: Number((w.reduce((a, b) => a + b, 0) / w.length).toFixed(3)) }];
          }),
        )
      : undefined,
    audio_wer_mean: audioTurns.length ? Number((audioTurns.reduce((s, t) => s + t.wer!, 0) / audioTurns.length).toFixed(3)) : null,
  };

  await mkdir(join(here, "results"), { recursive: true });
  const stamp = summary.ran_at.replace(/[:.]/g, "-");
  await writeFile(join(here, "results", `run-${stamp}.json`), JSON.stringify({ summary, results }, null, 2));
  await writeFile(join(here, "results", "latest-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  providers.close?.();
}

main();
