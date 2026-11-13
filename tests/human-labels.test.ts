import { describe, expect, it } from "vitest";
import { pairUp, parseLabels, pickForLabeling } from "../eval/human-labels.js";
import type { Trajectory } from "../eval/judge.js";

const make = (key: string, label: boolean): Trajectory => ({
  key,
  run: "run1",
  id: key,
  mode: "text",
  category: "clean",
  expected: null,
  submitted: null,
  submissions: 0,
  turns: [],
  label,
});

const pool = [
  ...Array.from({ length: 21 }, (_, i) => make(`bad-${i}`, false)),
  ...Array.from({ length: 59 }, (_, i) => make(`good-${i}`, true)),
];

describe("pickForLabeling", () => {
  it("takes 8 checker fails and 12 passes", () => {
    const picked = pickForLabeling(pool);
    expect(picked).toHaveLength(20);
    expect(picked.filter((t) => !t.label)).toHaveLength(8);
  });
  it("picks the same set in the same order on every run", () => {
    expect(pickForLabeling(pool).map((t) => t.key)).toEqual(pickForLabeling([...pool].reverse()).map((t) => t.key));
  });
  it("mixes fails among passes so the order gives nothing away", () => {
    const labels = pickForLabeling(pool).map((t) => t.label);
    expect(labels.slice(0, 8).every((l) => !l)).toBe(false);
  });
});

describe("parseLabels", () => {
  it("accepts pass and fail in any case and lists blanks as missing", () => {
    const { labels, missing } = parseLabels({ a: "Pass", b: " fail ", c: "", d: "maybe" });
    expect(labels).toEqual({ a: true, b: false });
    expect(missing).toEqual(["c", "d"]);
  });
});

describe("pairUp", () => {
  it("only pairs keys both raters labeled, human as the reference", () => {
    expect(pairUp({ a: true, b: false }, { a: false, z: true })).toEqual([{ label: true, judge: false }]);
  });
});
