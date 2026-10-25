// Runs only when ODOO_URL points at the local Odoo from odoo/ (init.sh + seed.ts).
// The last test writes one real maintenance request and consumes 1 Bearings.
import { describe, expect, it } from "vitest";
import { OdooBackend, OdooRpc } from "../src/odoo.js";
import { newSessionState, proposeLog, submitLog } from "../src/tools.js";

const url = process.env.ODOO_URL;

describe.skipIf(!url)("against a live Odoo", () => {
  const rpc = new OdooRpc(url!, process.env.ODOO_DB ?? "voice", "admin", "admin");
  const odoo = new OdooBackend(rpc);
  const stockOf = async (name: string) => (await odoo.listParts()).find((p) => p.name === name)!.quantity_on_hand;

  it("resolves spoken names against Odoo's equipment and products", async () => {
    const state = newSessionState();
    state.utterances = ["pressure washer, one bearing, 20 minutes"];
    const r = await proposeLog({ api: odoo, state }, { equipment: "pressure washer", parts: [{ part: "bearings", quantity: 1 }], duration_minutes: 20 });
    expect(r.status).toBe("awaiting_confirmation");
    expect(state.pending?.draft.equipment.name).toBe("Pressure Washer #01");
  });

  it("rejects a multi-part log with one short part and moves no stock at all", async () => {
    const parts = await odoo.listParts();
    const bearings = parts.find((p) => p.name === "Bearings")!;
    const belts = parts.find((p) => p.name === "Drive Belts")!;
    const [eq] = await odoo.listEquipment();
    const r = await odoo.createMaintenanceLog({
      equipment_id: eq.id,
      description: "integration test",
      parts_used: [{ part_id: bearings.id, quantity: 1 }, { part_id: belts.id, quantity: belts.quantity_on_hand + 5 }],
    });
    expect(r).toMatchObject({ ok: false, status: 400, shortfalls: [{ part_id: belts.id, available: belts.quantity_on_hand }] });
    expect(await stockOf("Bearings")).toBe(bearings.quantity_on_hand);
  });

  it("returns 404 for unknown equipment", async () => {
    expect(await odoo.createMaintenanceLog({ equipment_id: 999999, description: "x", parts_used: [] })).toMatchObject({ ok: false, status: 404 });
  });

  it("writes a done maintenance request with real duration and technician, and consumes the part", async () => {
    const before = await stockOf("Bearings");
    const priya = (await odoo.listEmployees()).find((e) => e.name === "Priya Shah")!;
    const state = newSessionState();
    state.technician = { id: priya.id, name: priya.name };
    state.utterances = ["Generator two, replaced one bearing, 45 minutes"];
    await proposeLog({ api: odoo, state }, { equipment: "generator 2", parts: [{ part: "bearing", quantity: 1 }], duration_minutes: 45, notes: "Replaced one bearing" });
    state.turn = 2;
    state.lastUserUtterance = "yes";
    const r = await submitLog({ api: odoo, state });
    expect(r.status).toBe("submitted");
    const id = (r as { maintainops_log_id: number }).maintainops_log_id;
    const [req] = await rpc.kw<{ duration: number; employee_id: [number, string]; equipment_id: [number, string]; stage_id: [number, string] }[]>(
      "maintenance.request", "read", [[id]], { fields: ["duration", "employee_id", "equipment_id", "stage_id"] },
    );
    expect(req.duration).toBe(0.75);
    expect(req.employee_id[1]).toBe("Priya Shah");
    expect(req.equipment_id[1]).toBe("Generator #02");
    expect(req.stage_id[1]).toBe("Repaired");
    expect(await stockOf("Bearings")).toBe(before - 1);
  });
});
