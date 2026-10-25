// Odoo 17 (Community) as the maintenance backend, over its JSON-RPC API.
// Same interface as MaintainOpsClient, mapped onto Odoo's own models:
//   equipment   -> maintenance.equipment
//   parts       -> product.product (storable), stock = qty_available
//   technicians -> hr.employee
//   a log       -> maintenance.request (with real duration and employee fields)
//                  + one stock.picking that consumes every part used
import type {
  CreateLogResult,
  Employee,
  Equipment,
  MaintenanceBackend,
  MaintenanceLogCreate,
  Part,
  Shortfall,
} from "./maintainops.js";

export const CONSUMPTION_LOCATION = "Maintenance Consumption";

export class OdooError extends Error {}

export function requestTitle(description: string): string {
  const notes = description.replace(/^\[Voice log\]\s*(Technician: [^.]*\.\s*)?(Duration: \d+ min\.\s*)?/, "").trim();
  return notes.slice(0, 80) || "Voice maintenance log";
}

export class OdooRpc {
  private uid: number | null = null;
  private id = 0;

  constructor(
    private url: string,
    private db: string,
    private login: string,
    private password: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const res = await this.fetchImpl(`${this.url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: ++this.id }),
    });
    if (!res.ok) throw new OdooError(`Odoo HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { data?: { message?: string }; message?: string } };
    if (body.error) throw new OdooError(body.error.data?.message ?? body.error.message ?? "Odoo error");
    return body.result as T;
  }

  async kw<T>(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<T> {
    if (this.uid === null) {
      const uid = await this.call<number | false>("common", "login", [this.db, this.login, this.password]);
      if (!uid) throw new OdooError("Odoo login failed");
      this.uid = uid;
    }
    return this.call<T>("object", "execute_kw", [this.db, this.uid, this.password, model, method, args, kwargs]);
  }
}

type M2O = [number, string] | false;

export class OdooBackend implements MaintenanceBackend {
  private ids: { stock: number; consumption: number; pickingType: number; doneStage: number } | null = null;

  constructor(private rpc: OdooRpc) {}

  // Odoo ids that differ per database, looked up once by name or flag.
  private async refs() {
    if (this.ids) return this.ids;
    const [stock] = await this.rpc.kw<{ id: number }[]>("stock.location", "search_read", [[["usage", "=", "internal"]]], { fields: ["id"], limit: 1 });
    const [consumption] = await this.rpc.kw<{ id: number }[]>("stock.location", "search_read", [[["name", "=", CONSUMPTION_LOCATION]]], { fields: ["id"], limit: 1 });
    const [pickingType] = await this.rpc.kw<{ id: number }[]>("stock.picking.type", "search_read", [[["code", "=", "outgoing"]]], { fields: ["id"], limit: 1 });
    const [doneStage] = await this.rpc.kw<{ id: number }[]>("maintenance.stage", "search_read", [[["done", "=", true]]], { fields: ["id"], order: "sequence", limit: 1 });
    if (!stock || !consumption || !pickingType || !doneStage) {
      throw new OdooError(`Odoo is missing setup (run odoo/seed.ts): stock=${!!stock} consumption=${!!consumption} pickingType=${!!pickingType} doneStage=${!!doneStage}`);
    }
    this.ids = { stock: stock.id, consumption: consumption.id, pickingType: pickingType.id, doneStage: doneStage.id };
    return this.ids;
  }

  async listEquipment(): Promise<Equipment[]> {
    const rows = await this.rpc.kw<{ id: number; name: string; location: string | false; category_id: M2O }[]>(
      "maintenance.equipment", "search_read", [[]], { fields: ["name", "location", "category_id"] },
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.category_id ? r.category_id[1] : "",
      location: r.location || "",
      current_location: r.location || "",
      status: "operational",
      is_overdue: false,
    }));
  }

  async listParts(): Promise<Part[]> {
    const rows = await this.rpc.kw<{ id: number; name: string; default_code: string | false; qty_available: number }[]>(
      "product.product", "search_read", [[["detailed_type", "=", "product"]]], { fields: ["name", "default_code", "qty_available"] },
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.default_code || "",
      quantity_on_hand: Math.floor(r.qty_available),
      reorder_threshold: 0,
    }));
  }

  async listEmployees(): Promise<Employee[]> {
    const rows = await this.rpc.kw<{ id: number; name: string; job_title: string | false; active: boolean }[]>(
      "hr.employee", "search_read", [[]], { fields: ["name", "job_title", "active"] },
    );
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.job_title || "employee", active: r.active }));
  }

  async createMaintenanceLog(body: MaintenanceLogCreate): Promise<CreateLogResult> {
    try {
      const ref = await this.refs();
      const exists = await this.rpc.kw<number>("maintenance.equipment", "search_count", [[["id", "=", body.equipment_id]]]);
      if (!exists) return { ok: false, status: 404, detail: `Equipment ${body.equipment_id} not found` };

      // Parts first, as one transfer: reserve everything, and only validate if
      // every line is fully reserved. Validation is a single Odoo transaction,
      // so either all parts leave stock or none do (like MaintainOps' 400).
      let pickingId: number | null = null;
      if (body.parts_used.length) {
        const products = await this.rpc.kw<{ id: number; uom_id: M2O; display_name: string }[]>(
          "product.product", "read", [body.parts_used.map((p) => p.part_id)], { fields: ["uom_id", "display_name"] },
        );
        if (products.length !== body.parts_used.length) {
          return { ok: false, status: 404, detail: "One or more parts not found" };
        }
        const uom = new Map(products.map((p) => [p.id, p.uom_id ? p.uom_id[0] : 1]));
        const name = new Map(products.map((p) => [p.id, p.display_name]));
        pickingId = await this.rpc.kw<number>("stock.picking", "create", [{
          picking_type_id: ref.pickingType,
          location_id: ref.stock,
          location_dest_id: ref.consumption,
          origin: "Voice maintenance log",
          move_ids: body.parts_used.map((p) => [0, 0, {
            name: name.get(p.part_id),
            product_id: p.part_id,
            product_uom_qty: p.quantity,
            product_uom: uom.get(p.part_id),
            location_id: ref.stock,
            location_dest_id: ref.consumption,
          }]),
        }]);
        await this.rpc.kw("stock.picking", "action_confirm", [[pickingId]]);
        await this.rpc.kw("stock.picking", "action_assign", [[pickingId]]);
        const moves = await this.rpc.kw<{ product_id: M2O; product_uom_qty: number; quantity: number }[]>(
          "stock.move", "search_read", [[["picking_id", "=", pickingId]]], { fields: ["product_id", "product_uom_qty", "quantity"] },
        );
        const short = moves.filter((m) => m.quantity < m.product_uom_qty);
        if (short.length) {
          await this.rpc.kw("stock.picking", "action_cancel", [[pickingId]]);
          const shortfalls: Shortfall[] = short.map((m) => ({
            part_id: m.product_id ? m.product_id[0] : 0,
            requested: m.product_uom_qty,
            available: Math.floor(m.quantity),
          }));
          return { ok: false, status: 400, detail: "Insufficient stock", shortfalls };
        }
        const moveIds = await this.rpc.kw<number[]>("stock.move", "search", [[["picking_id", "=", pickingId]]]);
        await this.rpc.kw("stock.move", "write", [moveIds, { picked: true }]);
        const validated = await this.rpc.kw<unknown>("stock.picking", "button_validate", [[pickingId]]);
        if (validated !== true) {
          await this.rpc.kw("stock.picking", "action_cancel", [[pickingId]]);
          return { ok: false, status: 409, detail: "Odoo could not validate the parts transfer; nothing was consumed" };
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      const requestId = await this.rpc.kw<number>("maintenance.request", "create", [{
        // Title is just the notes: technician and duration have real fields here.
        name: requestTitle(body.description),
        equipment_id: body.equipment_id,
        description: body.description,
        maintenance_type: "corrective",
        duration: (body.duration_minutes ?? 0) / 60,
        employee_id: body.technician_id ?? false,
        stage_id: ref.doneStage,
        request_date: today,
        close_date: today,
      }]);
      if (pickingId) {
        // Link the transfer to the request so the two can be found from each other.
        const [req] = await this.rpc.kw<{ name: string }[]>("maintenance.request", "read", [[requestId]], { fields: ["name"] });
        await this.rpc.kw("stock.picking", "write", [[pickingId], { origin: `Maintenance request ${requestId}: ${req.name}` }]);
      }
      return {
        ok: true,
        log: {
          id: requestId,
          equipment_id: body.equipment_id,
          performed_at: new Date().toISOString(),
          description: body.description,
          parts_used: body.parts_used,
        },
      };
    } catch (err) {
      return { ok: false, status: 502, detail: `Odoo: ${(err as Error).message}` };
    }
  }
}
