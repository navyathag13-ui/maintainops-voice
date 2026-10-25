import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Logs submitted through the voice agent. MaintainOps is the source of truth
// for the log itself; this keeps what only the voice side knows: the
// transcript that produced it.
export interface VoiceLogEntry {
  // Id of the record in `system` (a MaintainOps log id or an Odoo maintenance.request id).
  maintainops_log_id: number;
  system?: string;
  technician: string | null;
  equipment: string;
  parts: { name: string; quantity: number }[];
  duration_minutes: number;
  notes: string;
  transcript: string[];
  submitted_at: string;
}

export class HistoryStore {
  constructor(private path: string) {}

  async list(): Promise<VoiceLogEntry[]> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as VoiceLogEntry[];
    } catch {
      return [];
    }
  }

  async add(entry: VoiceLogEntry): Promise<void> {
    const all = await this.list();
    all.unshift(entry);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(all, null, 2));
  }
}
