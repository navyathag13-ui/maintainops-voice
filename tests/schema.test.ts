import { describe, expect, it } from "vitest";
import { LogDraftSchema, proposeLogJsonSchema } from "../src/schema.js";

describe("propose_log schema", () => {
  it("the JSON schema sent to the LLM matches the zod fields, with notes the only optional one", () => {
    expect(Object.keys(proposeLogJsonSchema.properties).sort()).toEqual(Object.keys(LogDraftSchema.shape).sort());
    expect([...proposeLogJsonSchema.required].sort()).toEqual(["duration_minutes", "equipment", "parts"]);
    expect(LogDraftSchema.shape.notes.isOptional()).toBe(true);
  });
  it("zod rejects a fractional quantity and an over-24h duration", () => {
    const base = { equipment: "pump 1", parts: [{ part: "bearings", quantity: 1 }], duration_minutes: 30, notes: "n" };
    expect(LogDraftSchema.safeParse(base).success).toBe(true);
    expect(LogDraftSchema.safeParse({ ...base, parts: [{ part: "bearings", quantity: 1.5 }] }).success).toBe(false);
    expect(LogDraftSchema.safeParse({ ...base, duration_minutes: 2000 }).success).toBe(false);
  });
});
