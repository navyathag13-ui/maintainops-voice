import { describe, expect, it } from "vitest";
import { canSubmit, isConfirmation } from "../src/confirm.js";

describe("isConfirmation", () => {
  it.each(["yes", "Yes.", "yeah go ahead", "that's correct", "yep submit it", "okay"])("accepts %s", (t) => {
    expect(isConfirmation(t)).toBe(true);
  });
  it.each([
    "",
    "no",
    "yes but it was three belts",
    "wait, it was generator three",
    "actually make it 45 minutes",
    "it was the oil filters",
    "don't submit",
  ])("rejects %s", (t) => {
    expect(isConfirmation(t)).toBe(false);
  });
});

describe("canSubmit", () => {
  it("refuses when nothing was proposed", () => {
    expect(canSubmit(null, 3, "yes").allowed).toBe(false);
  });
  it("refuses in the same turn the summary was produced, even if the turn said yes", () => {
    // e.g. "log it, yes, submit" in one breath: the tech never heard the read-back
    expect(canSubmit({ proposedAtTurn: 2 }, 2, "yes submit it").allowed).toBe(false);
  });
  it("refuses a later turn that is a correction", () => {
    expect(canSubmit({ proposedAtTurn: 2 }, 3, "no, two belts").allowed).toBe(false);
  });
  it("allows a later turn that is a clear yes", () => {
    expect(canSubmit({ proposedAtTurn: 2 }, 3, "yes").allowed).toBe(true);
  });
});
