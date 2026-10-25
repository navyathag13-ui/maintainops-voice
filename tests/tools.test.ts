import { describe, expect, it } from "vitest";
import { newSessionState, proposeLog, submitLog, checkPartStock, findEquipment, type ToolContext } from "../src/tools.js";
import { MaintainOpsClient } from "../src/maintainops.js";
import { FakeMaintainOps } from "./fakes.js";

function ctx(api = new FakeMaintainOps()): ToolContext & { api: FakeMaintainOps } {
  const state = newSessionState();
  state.turn = 1;
  return { api, state };
}

const good = {
  equipment: "generator two",
  parts: [{ part: "oil filters", quantity: 1 }],
  duration_minutes: 45,
  notes: "Changed oil and filter",
};

describe("lookup tools", () => {
  it("find_equipment returns the options when ambiguous", async () => {
    const r = await findEquipment(ctx(), { query: "generator" });
    expect(r).toMatchObject({ status: "needs_clarification", issues: [{ code: "ambiguous_equipment" }] });
  });
  it("check_part_stock reports whether there is enough", async () => {
    expect(await checkPartStock(ctx(), { part: "drive belts", quantity: 2 })).toMatchObject({
      status: "resolved",
      part: { id: 4, in_stock: 1 },
      enough: false,
    });
  });
});

describe("propose_log", () => {
  it("rejects a draft missing required fields via zod", async () => {
    const c = ctx();
    const r = await proposeLog(c, { equipment: "generator two", parts: [] });
    expect(r).toMatchObject({ status: "needs_clarification", issues: [{ code: "invalid_fields" }] });
    expect(c.state.pending).toBeNull();
  });
  it("rejects a non-positive quantity via zod", async () => {
    const r = await proposeLog(ctx(), { ...good, parts: [{ part: "bearings", quantity: 0 }] });
    expect(r.status).toBe("needs_clarification");
  });
  it("asks which equipment when the name is ambiguous", async () => {
    const r = await proposeLog(ctx(), { ...good, equipment: "generator" });
    expect(r).toMatchObject({ issues: [{ code: "ambiguous_equipment", options: ["Generator #01", "Generator #02", "Generator #03"] }] });
  });
  it("flags an unknown part", async () => {
    const r = await proposeLog(ctx(), { ...good, parts: [{ part: "flux capacitor", quantity: 1 }] });
    expect(r).toMatchObject({ issues: [{ code: "unknown_part" }] });
  });
  it("flags short stock before anything reaches MaintainOps", async () => {
    const c = ctx();
    const r = await proposeLog(c, { ...good, parts: [{ part: "drive belts", quantity: 3 }] });
    expect(r).toMatchObject({ issues: [{ code: "insufficient_stock" }] });
    expect((r as { issues: { question: string }[] }).issues[0].question).toContain("only 1 Drive Belts");
    expect(c.api.created).toHaveLength(0);
  });
  it("flags the same part said twice instead of silently merging", async () => {
    const r = await proposeLog(ctx(), { ...good, parts: [{ part: "bearings", quantity: 2 }, { part: "bearing", quantity: 1 }] });
    expect(r).toMatchObject({ issues: [{ code: "duplicate_part" }] });
  });
  it("reports every issue at once (equipment and part)", async () => {
    const r = await proposeLog(ctx(), { ...good, equipment: "generator", parts: [{ part: "filters", quantity: 1 }] });
    expect((r as { issues: { code: string }[] }).issues.map((i) => i.code)).toEqual(["ambiguous_equipment", "ambiguous_part"]);
  });
  it("sets a pending proposal with a read-back summary when everything resolves", async () => {
    const c = ctx();
    const r = await proposeLog(c, good);
    expect(r).toMatchObject({ status: "awaiting_confirmation" });
    expect((r as { summary: string }).summary).toBe("Generator #02, 45 minutes, 1 Oil Filters. Notes: Changed oil and filter");
    expect(c.state.pending).toMatchObject({ proposedAtTurn: 1, draft: { equipment: { id: 2 } } });
  });
});

describe("submit_log", () => {
  it("refuses in the same turn as the proposal", async () => {
    const c = ctx();
    await proposeLog(c, good);
    c.state.lastUserUtterance = "yes";
    expect(await submitLog(c)).toMatchObject({ status: "refused" });
    expect(c.api.created).toHaveLength(0);
  });
  it("refuses when the next turn is a correction", async () => {
    const c = ctx();
    await proposeLog(c, good);
    c.state.turn = 2;
    c.state.lastUserUtterance = "no, it was two filters";
    expect(await submitLog(c)).toMatchObject({ status: "refused" });
    expect(c.api.created).toHaveLength(0);
  });
  it("submits after a yes on the next turn, with duration in the description", async () => {
    const c = ctx();
    await proposeLog(c, good);
    c.state.turn = 2;
    c.state.lastUserUtterance = "yes";
    expect(await submitLog(c)).toMatchObject({ status: "submitted", maintainops_log_id: 100 });
    expect(c.api.created).toEqual([
      { equipment_id: 2, description: "[Voice log] Duration: 45 min. Changed oil and filter", parts_used: [{ part_id: 6, quantity: 1 }] },
    ]);
    expect(c.state.pending).toBeNull();
    // A second yes does not submit twice
    expect(await submitLog(c)).toMatchObject({ status: "refused" });
    expect(c.api.created).toHaveLength(1);
  });
  it("turns MaintainOps' 400 shortfall into a spoken question when stock changes after read-back", async () => {
    const c = ctx();
    await proposeLog(c, { ...good, parts: [{ part: "oil filters", quantity: 3 }] });
    c.api.parts.find((p) => p.id === 6)!.quantity_on_hand = 1; // someone else used two meanwhile
    c.state.turn = 2;
    c.state.lastUserUtterance = "yes";
    const r = await submitLog(c);
    expect(r).toMatchObject({ status: "rejected", http_status: 400, issues: [{ code: "insufficient_stock" }] });
    expect((r as { issues: { question: string }[] }).issues[0].question).toContain("only 1 Oil Filters");
    expect(c.state.pending).toBeNull();
    expect(c.api.created).toHaveLength(0);
  });
});

describe("MaintainOpsClient", () => {
  it("parses a 400 insufficient-stock response including shortfalls", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ detail: "Insufficient stock for: part 4", shortfalls: [{ part_id: 4, requested: 3, available: 1 }] }), {
        status: 400,
      })) as unknown as typeof fetch;
    const client = new MaintainOpsClient("http://x", fakeFetch);
    expect(await client.createMaintenanceLog({ equipment_id: 1, description: "d", parts_used: [] })).toEqual({
      ok: false,
      status: 400,
      detail: "Insufficient stock for: part 4",
      shortfalls: [{ part_id: 4, requested: 3, available: 1 }],
    });
  });
  it("parses a 404", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ detail: "Equipment 999 not found" }), { status: 404 })) as unknown as typeof fetch;
    const r = await new MaintainOpsClient("http://x", fakeFetch).createMaintenanceLog({ equipment_id: 999, description: "d", parts_used: [] });
    expect(r).toMatchObject({ ok: false, status: 404, detail: "Equipment 999 not found" });
  });
});

describe("guards added after eval run 1", () => {
  it("asks for a duration the technician never said instead of accepting the model's guess", async () => {
    const c = ctx();
    c.state.utterances = ["Shop vacuum one, replaced the air filter, just one."];
    const r = await proposeLog(c, { ...good, equipment: "pressure washer" });
    expect(r).toMatchObject({ issues: [{ code: "missing_duration" }] });
  });
  it("recovers an asset number the model dropped, from the technician's own words", async () => {
    const c = ctx();
    c.state.utterances = ["Generator two, changed the oil filter, 45 minutes"];
    const r = await proposeLog(c, { ...good, equipment: "generator" });
    expect(r.status).toBe("awaiting_confirmation");
    expect(c.state.pending?.draft.equipment.name).toBe("Generator #02");
  });
  it("does not treat 'one air filter on the generator' as Generator #01", async () => {
    const c = ctx();
    c.state.utterances = ["Changed one air filter on the generator, thirty minutes."];
    const r = await proposeLog(c, { ...good, equipment: "generator" });
    expect(r).toMatchObject({ issues: [{ code: "ambiguous_equipment" }] });
  });
});
