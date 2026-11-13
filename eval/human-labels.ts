/**
 * Human labels for the LLM judge calibration.
 *
 * judge.ts measures the LLM judge against the scripted checker. That shows whether the judge
 * matches an answer key, not whether it matches a person. This script closes that gap:
 *
 *   sheet  picks 20 of the 80 judged conversations (8 the checker failed, 12 it passed, by a
 *          stable hash), shuffles them and writes eval/human/labeling-sheet.md plus a blank
 *          eval/human/labels.json. The sheet shows only the transcript and what was saved:
 *          no checker label, no judge verdict, no answer key, so the person labels blind.
 *   score  reads the filled-in labels.json ("pass" or "fail" per conversation) and writes
 *          eval/results/human-agreement.json: the human vs the checker, and each judge variant
 *          vs the human (agreement, Cohen's kappa, bad runs the judge passed).
 *
 *   page   writes the same conversations to eval/human/labeling.html: chat bubbles, tool steps in
 *          plain English, the saved record as a table and pass/fail buttons. Copy its labels into
 *          labels.json (the page has a button for that).
 *
 * Usage: npx tsx eval/human-labels.ts sheet | page | score
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeMetrics, loadTrajectories, renderTranscript, type Metrics, type Trajectory } from "./judge.js";

const EVAL_DIR = import.meta.dirname ?? ".";
const RESULTS_DIR = join(EVAL_DIR, "results");
const HUMAN_DIR = join(EVAL_DIR, "human");
const LABELS_PATH = join(HUMAN_DIR, "labels.json");
const SHEET_PATH = join(HUMAN_DIR, "labeling-sheet.md");
const JUDGE_FILES = {
  rubric: "judge-rubric-qwen2.5_7b.json",
  reference: "judge-reference-qwen2.5_7b.json",
} as const;

export type HumanLabel = "pass" | "fail";

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** `fails` checker-failed and `passes` checker-passed conversations from those the judge graded, in a stable shuffled order. */
export function pickForLabeling(judged: Trajectory[], fails = 8, passes = 12): Trajectory[] {
  const byHash = (a: Trajectory, b: Trajectory) => hash(a.key) - hash(b.key);
  const bad = judged.filter((t) => !t.label).sort(byHash).slice(0, fails);
  const good = judged.filter((t) => t.label).sort(byHash).slice(0, passes);
  return [...bad, ...good].sort((a, b) => hash(`order:${a.key}`) - hash(`order:${b.key}`));
}

/** Pairs a reference rater with another rater on every key both have labeled. */
export function pairUp(
  reference: Record<string, boolean>,
  other: Record<string, boolean>,
): { label: boolean; judge: boolean }[] {
  return Object.keys(reference)
    .filter((k) => k in other)
    .map((k) => ({ label: reference[k], judge: other[k] }));
}

/** Reads labels.json; every value must be "pass" or "fail". */
export function parseLabels(raw: Record<string, unknown>): { labels: Record<string, boolean>; missing: string[] } {
  const labels: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const v = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (v === "pass") labels[key] = true;
    else if (v === "fail") labels[key] = false;
    else missing.push(key);
  }
  return { labels, missing };
}

function loadJudge(file: string): Record<string, boolean> {
  const verdicts = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8")).verdicts as Record<string, { pass: boolean }>;
  return Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.pass]));
}

function writeSheet() {
  const judged = new Set(Object.keys(loadJudge(JUDGE_FILES.rubric)));
  const picked = pickForLabeling(loadTrajectories().filter((t) => judged.has(t.key)));
  mkdirSync(HUMAN_DIR, { recursive: true });
  const parts = [
    "# Label these 20 conversations",
    "",
    "For each one, decide if the outcome is right, as if you were the technician:",
    "- **pass**: exactly one record was saved with the equipment, parts, quantities and duration the technician meant,",
    "  or nothing was saved when nothing should have been (a cancel, or a job that can't be logged).",
    "- **fail**: a wrong or guessed value was saved, a part was dropped, or a record that should exist was never saved.",
    "",
    "Write `pass` or `fail` for each key in `eval/human/labels.json`. Don't look at the checker or judge results first.",
    "",
  ];
  picked.forEach((t, i) => {
    parts.push(`## ${i + 1}. \`${t.key}\``, "", "```", renderTranscript(t), "```", "");
  });
  writeFileSync(SHEET_PATH, parts.join("\n"));
  if (existsSync(LABELS_PATH)) {
    console.log(`kept existing ${LABELS_PATH}`);
  } else {
    writeFileSync(LABELS_PATH, JSON.stringify(Object.fromEntries(picked.map((t) => [t.key, ""])), null, 1) + "\n");
  }
  console.log(`wrote ${picked.length} conversations to ${SHEET_PATH}`);
}

/** Same 20 conversations as the sheet, as a page with chat bubbles, plain-English tool steps and pass/fail buttons. */
function writePage() {
  const judged = new Set(Object.keys(loadJudge(JUDGE_FILES.rubric)));
  const picked = pickForLabeling(loadTrajectories().filter((t) => judged.has(t.key)));
  const data = picked.map((t) => ({ key: t.key, turns: t.turns, saved: t.submissions > 0 ? t.submitted : null }));
  const html = readFileSync(join(HUMAN_DIR, "labeling-template.html"), "utf8").replace(
    "/*DATA*/[]",
    JSON.stringify(data).replace(/</g, "\\u003c"),
  );
  writeFileSync(join(HUMAN_DIR, "labeling.html"), html);
  console.log(`wrote ${data.length} conversations to ${join(HUMAN_DIR, "labeling.html")}`);
}

function score() {
  const { labels, missing } = parseLabels(JSON.parse(readFileSync(LABELS_PATH, "utf8")));
  if (missing.length) {
    console.error(`${missing.length} conversations still need "pass" or "fail": ${missing.join(", ")}`);
    process.exit(1);
  }
  const checker = Object.fromEntries(loadTrajectories().map((t) => [t.key, t.label]));
  const summarize = (m: Metrics) => ({
    n: m.n,
    agreement: Math.round(m.accuracy * 1000) / 1000,
    kappa: m.kappa,
    bad_runs_passed: `${m.fp} of ${m.fp + m.tn}`,
    good_runs_failed: `${m.fn} of ${m.fn + m.tp}`,
  });
  const result = {
    labeled: Object.keys(labels).length,
    human_says_fail: Object.values(labels).filter((v) => !v).length,
    checker_vs_human: summarize(computeMetrics(pairUp(labels, checker))),
    judge_rubric_vs_human: summarize(computeMetrics(pairUp(labels, loadJudge(JUDGE_FILES.rubric)))),
    judge_reference_vs_human: summarize(computeMetrics(pairUp(labels, loadJudge(JUDGE_FILES.reference)))),
    disagreements: Object.keys(labels)
      .filter((k) => labels[k] !== checker[k])
      .map((k) => ({ key: k, human: labels[k] ? "pass" : "fail", checker: checker[k] ? "pass" : "fail" })),
  };
  writeFileSync(join(RESULTS_DIR, "human-agreement.json"), JSON.stringify(result, null, 1) + "\n");
  console.log(JSON.stringify(result, null, 1));
}

if (process.argv[1] && process.argv[1].endsWith("human-labels.ts")) {
  const cmd = process.argv[2];
  if (cmd === "sheet") writeSheet();
  else if (cmd === "page") writePage();
  else if (cmd === "score") score();
  else {
    console.error("usage: npx tsx eval/human-labels.ts sheet | page | score");
    process.exit(1);
  }
}
