// Runs only when MAINTAINOPS_URL points at a live MaintainOps (`docker compose up`
// in ../maintainops). Read-only plus one request MaintainOps must reject, so it
// never changes stock.
import { describe, expect, it } from "vitest";
import { MaintainOpsClient } from "../src/maintainops.js";
import { newSessionState, proposeLog, submitLog } from "../src/tools.js";

const url = process.env.MAINTAINOPS_URL;

describe.skipIf(!url)("against a live MaintainOps", () => {
  const api = new MaintainOpsClient(url!);

  it("resolves seeded equipment and parts by spoken name", async () => {
    const state = newSessionState();
    const r = await proposeLog({ api, state }, {
      equipment: "pressure washer", parts: [{ part: "bearings", quantity: 1 }], duration_minutes: 20, notes: "check",
    });
    expect(r.status).toBe("awaiting_confirmation");
    expect(state.pending?.draft.equipment.name).toBe("Pressure Washer #01");
  });

  it("surfaces MaintainOps' real 400 shortfall as a question, and nothing is written", async () => {
    const parts = await api.listParts();
    const belts = parts.find((p) => p.name === "Drive Belts")!;
    const state = newSessionState();
    state.turn = 2;
    state.lastUserUtterance = "yes";
    // Bypass our own pre-check to hit MaintainOps' all-or-nothing check directly,
    // as happens when stock changes between read-back and confirmation.
    state.pending = {
      proposedAtTurn: 1,
      draft: {
        equipment: { id: 1, name: "x" },
        parts: [
          { id: 5, name: "Bearings", quantity: 1, available: 999 },
          { id: belts.id, name: "Drive Belts", quantity: belts.quantity_on_hand + 5, available: 999 },
        ],
        duration_minutes: 10,
        notes: "integration test",
      },
    };
    const r = await submitLog({ api, state });
    expect(r).toMatchObject({ status: "rejected", http_status: 400, issues: [{ code: "insufficient_stock" }] });
    const after = await api.listParts();
    expect(after.find((p) => p.id === 5)!.quantity_on_hand).toBe(parts.find((p) => p.id === 5)!.quantity_on_hand);
  });

  it("surfaces a 404 for an equipment id that does not exist", async () => {
    const r = await api.createMaintenanceLog({ equipment_id: 999999, description: "x", parts_used: [] });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});
