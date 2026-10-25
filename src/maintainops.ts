// Thin typed client for the MaintainOps REST API. Only the endpoints the
// voice agent needs: list equipment, list parts, create a maintenance log.

export interface Equipment {
  id: number;
  name: string;
  type: string;
  location: string;
  current_location: string;
  status: string;
  is_overdue: boolean;
}

export interface Part {
  id: number;
  name: string;
  sku: string;
  quantity_on_hand: number;
  reorder_threshold: number;
}

export interface MaintenanceLogCreate {
  equipment_id: number;
  description: string;
  parts_used: { part_id: number; quantity: number }[];
}

export interface MaintenanceLogRead {
  id: number;
  equipment_id: number;
  performed_at: string;
  description: string;
  parts_used: { part_id: number; quantity: number; part_name?: string | null }[];
}

export interface Shortfall {
  part_id: number;
  requested: number;
  available: number;
}

// MaintainOps returns JSON errors with `detail`; insufficient stock (400)
// also carries a `shortfalls` array.
export type CreateLogResult =
  | { ok: true; log: MaintenanceLogRead }
  | { ok: false; status: number; detail: string; shortfalls?: Shortfall[] };

export interface MaintainOpsApi {
  listEquipment(): Promise<Equipment[]>;
  listParts(): Promise<Part[]>;
  createMaintenanceLog(body: MaintenanceLogCreate): Promise<CreateLogResult>;
}

export class MaintainOpsClient implements MaintainOpsApi {
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch) {}

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`MaintainOps GET ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  listEquipment() {
    return this.getJson<Equipment[]>("/equipment");
  }

  listParts() {
    return this.getJson<Part[]>("/parts");
  }

  async createMaintenanceLog(body: MaintenanceLogCreate): Promise<CreateLogResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/maintenance-logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 201) return { ok: true, log: data as unknown as MaintenanceLogRead };
    const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail ?? data);
    return {
      ok: false,
      status: res.status,
      detail,
      shortfalls: Array.isArray(data.shortfalls) ? (data.shortfalls as Shortfall[]) : undefined,
    };
  }
}
