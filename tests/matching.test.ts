import { describe, expect, it } from "vitest";
import { matchByName, tokens } from "../src/matching.js";
import { FakeMaintainOps } from "./fakes.js";

const api = new FakeMaintainOps();

describe("tokens", () => {
  it("normalizes asset numbers and spoken numbers the same way", () => {
    expect(tokens("Generator #02")).toEqual(["generator", "2"]);
    expect(tokens("generator number two")).toEqual(["generator", "2"]);
    expect(tokens("the generator 2")).toEqual(["generator", "2"]);
  });
  it("singularizes plurals", () => {
    expect(tokens("Drive Belts")).toEqual(["drive", "belt"]);
  });
});

describe("matchByName", () => {
  it("is ambiguous when several pieces of equipment share the spoken name", () => {
    const m = matchByName("generator", api.equipment);
    expect(m.kind).toBe("ambiguous");
    if (m.kind === "ambiguous") expect(m.candidates.map((c) => c.id)).toEqual([1, 2, 3]);
  });
  it("resolves a numbered reference", () => {
    const m = matchByName("generator two", api.equipment);
    expect(m).toMatchObject({ kind: "resolved", item: { id: 2 } });
  });
  it("resolves a partial name when only one item contains every word", () => {
    expect(matchByName("pressure washer", api.equipment)).toMatchObject({ kind: "resolved", item: { id: 6 } });
    expect(matchByName("belt", api.parts)).toMatchObject({ kind: "resolved", item: { id: 4 } });
  });
  it("treats 'filters' as ambiguous across oil, air and respirator filters", () => {
    const m = matchByName("filters", api.parts);
    expect(m.kind).toBe("ambiguous");
    if (m.kind === "ambiguous") expect(m.candidates).toHaveLength(3);
  });
  it("returns suggestions but never resolves an unknown name", () => {
    const m = matchByName("hydraulic pump", api.equipment.concat());
    expect(m.kind).toBe("none");
    const p = matchByName("hydraulic seals", api.parts);
    expect(p.kind).toBe("none");
    if (p.kind === "none") expect(p.suggestions.map((s) => s.name)).toContain("Hydraulic Hoses");
  });
  it("does not resolve 'generator 4' to a different generator", () => {
    expect(matchByName("generator 4", api.equipment).kind).toBe("none");
  });
});
