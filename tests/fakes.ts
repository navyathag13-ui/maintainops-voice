import type { ChatMessage, LlmClient, ToolCall } from "../src/openai.js";
import type {
  CreateLogResult,
  Equipment,
  MaintainOpsApi,
  MaintenanceLogCreate,
  Part,
} from "../src/maintainops.js";

const eq = (id: number, name: string): Equipment => ({
  id, name, type: "x", location: "Garage Storage #1", current_location: "Garage Storage #1", status: "operational", is_overdue: false,
});
const part = (id: number, name: string, qty: number): Part => ({
  id, name, sku: `SKU-${id}`, quantity_on_hand: qty, reorder_threshold: 2,
});

// A tiny in-memory MaintainOps with the same names as its seed data and the
// same all-or-nothing stock rule (400 + shortfalls, nothing written).
export class FakeMaintainOps implements MaintainOpsApi {
  equipment: Equipment[] = [
    eq(1, "Generator #01"), eq(2, "Generator #02"), eq(3, "Generator #03"),
    eq(4, "Water Pump #01"), eq(5, "Water Pump #02"), eq(6, "Pressure Washer #01"),
    eq(7, "Air Compressor #01"),
  ];
  parts: Part[] = [
    part(4, "Drive Belts", 1), part(5, "Bearings", 20), part(6, "Oil Filters", 3),
    part(7, "Air Filters", 28), part(28, "Respirator Filters", 2), part(15, "Hydraulic Hoses", 13),
  ];
  created: MaintenanceLogCreate[] = [];
  nextId = 100;

  async listEquipment() { return structuredClone(this.equipment); }
  async listParts() { return structuredClone(this.parts); }

  async createMaintenanceLog(body: MaintenanceLogCreate): Promise<CreateLogResult> {
    if (!this.equipment.some((e) => e.id === body.equipment_id)) {
      return { ok: false, status: 404, detail: `Equipment ${body.equipment_id} not found` };
    }
    const shortfalls = body.parts_used
      .map((p) => ({ p, part: this.parts.find((x) => x.id === p.part_id)! }))
      .filter(({ p, part }) => part.quantity_on_hand < p.quantity)
      .map(({ p, part }) => ({ part_id: p.part_id, requested: p.quantity, available: part.quantity_on_hand }));
    if (shortfalls.length) return { ok: false, status: 400, detail: "Insufficient stock", shortfalls };
    for (const p of body.parts_used) this.parts.find((x) => x.id === p.part_id)!.quantity_on_hand -= p.quantity;
    this.created.push(body);
    return {
      ok: true,
      log: { id: this.nextId++, equipment_id: body.equipment_id, performed_at: new Date().toISOString(), description: body.description, parts_used: body.parts_used },
    };
  }
}

// An LLM stand-in that replays a script: each step is either tool calls or a final reply.
export type ScriptStep = { tools: { name: string; args?: unknown }[] } | { say: string };

export class ScriptedLlm implements LlmClient {
  calls = 0;
  constructor(private script: ScriptStep[]) {}
  async complete(_messages: ChatMessage[]): Promise<ChatMessage> {
    const step = this.script[this.calls++];
    if (!step) throw new Error("Scripted LLM ran out of steps");
    if ("say" in step) return { role: "assistant", content: step.say };
    const tool_calls: ToolCall[] = step.tools.map((t, i) => ({
      id: `call_${this.calls}_${i}`,
      type: "function",
      function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
    }));
    return { role: "assistant", content: null, tool_calls };
  }
}
