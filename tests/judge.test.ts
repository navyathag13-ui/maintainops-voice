import { describe, expect, it } from "vitest";
import { buildPrompt, computeMetrics, parseVerdict, renderTranscript, stratifiedSample, type Trajectory } from "../eval/judge.js";

const traj: Trajectory = {
  key: "run1/c01/text",
  run: "run1",
  id: "c01",
  mode: "text",
  category: "clean",
  expected: { submit: true, equipment: "Pressure Washer #01", parts: { "O-Ring Seals": 2 }, duration_minutes: 40 },
  submitted: { equipment: "Pressure Washer #01", parts: { "O-Ring Seals": 2 }, duration_minutes: 40 },
  submissions: 1,
  turns: [
    { user: "Swapped two O-ring seals on the washer, forty minutes.", agent: "Should I submit it?", tools: [{ name: "propose_log", args: { equipment: "pressure washer" }, result: { status: "awaiting_confirmation" } }] },
    { user: "Yes.", agent: "Saved.", tools: [] },
  ],
  label: true,
};

describe("renderTranscript", () => {
  it("includes every turn, tool call and the saved record", () => {
    const text = renderTranscript(traj);
    expect(text).toContain("Technician: Swapped two O-ring seals");
    expect(text).toContain("[tool propose_log]");
    expect(text).toContain('"duration_minutes":40');
  });
  it("says plainly when nothing was saved", () => {
    expect(renderTranscript({ ...traj, submissions: 0, submitted: null })).toContain("nothing was saved");
  });
});

describe("buildPrompt", () => {
  it("only shows the answer key to the reference judge", () => {
    expect(buildPrompt(traj, "rubric").user).not.toContain("answer key");
    expect(buildPrompt(traj, "reference").user).toContain("answer key");
  });
});

describe("parseVerdict", () => {
  it("reads a JSON verdict, even with text around it", () => {
    expect(parseVerdict('{"pass": true, "reason": "ok"}')).toEqual({ pass: true, reason: "ok" });
    expect(parseVerdict('Sure: {"pass": false, "reason": "wrong part"} done').pass).toBe(false);
  });
  it("treats an unparseable reply as a fail", () => {
    expect(parseVerdict("looks good to me").pass).toBe(false);
    expect(parseVerdict("{pass: yes").pass).toBe(false);
  });
});

describe("computeMetrics", () => {
  it("counts the confusion matrix and the false-pass rate", () => {
    const m = computeMetrics([
      { label: true, judge: true },
      { label: true, judge: true },
      { label: true, judge: false },
      { label: false, judge: false },
      { label: false, judge: true },
    ]);
    expect(m).toMatchObject({ n: 5, tp: 2, fn: 1, tn: 1, fp: 1, accuracy: 0.6 });
    expect(m.falsePassRate).toBe(0.5);
    expect(m.falseFailRate).toBe(0.333);
  });
  it("gives kappa 1 for perfect agreement and about 0 for a judge that always says pass", () => {
    expect(computeMetrics([{ label: true, judge: true }, { label: false, judge: false }]).kappa).toBe(1);
    const lazy = computeMetrics([
      { label: true, judge: true }, { label: true, judge: true }, { label: true, judge: true }, { label: false, judge: true },
    ]);
    expect(lazy.kappa).toBe(0);
    expect(lazy.falsePassRate).toBe(1);
  });
});

describe("stratifiedSample", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ...traj, key: `r/${i}`, label: i % 5 !== 0 }));
  it("keeps every failing run and the requested number of passing ones", () => {
    const s = stratifiedSample(many, 6);
    expect(s.filter((t) => !t.label)).toHaveLength(4);
    expect(s.filter((t) => t.label)).toHaveLength(6);
  });
  it("picks the same sample every time", () => {
    expect(stratifiedSample(many, 6).map((t) => t.key)).toEqual(stratifiedSample(many, 6).map((t) => t.key));
  });
});
