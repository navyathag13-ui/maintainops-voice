import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TurnEvent } from "./agent.js";

// One JSON line per technician turn: what was said, what the agent did, how
// long each stage took. The review queue is built from these lines.
export interface TurnLogEntry {
  at: string;
  session: string;
  technician: string | null;
  turn: number;
  transcript: string;
  reply: string;
  events: TurnEvent[];
  tools: { name: string; status: string }[];
  timings: { sttMs: number; llmMs: number; ttsMs: number; totalMs: number };
  maintainops_log_id: number | null;
}

// Turns a person should look at: the agent was corrected, gave up, was
// overruled by MaintainOps, or tried to claim a save that didn't happen.
export const REVIEW_EVENTS: TurnEvent[] = [
  "readback_corrected",
  "rejected_by_maintainops",
  "save_claim_replaced",
  "stuck",
  "cancelled",
];

export class TurnLog {
  constructor(private path: string) {}

  async append(entry: TurnLogEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + "\n");
  }

  async all(): Promise<TurnLogEntry[]> {
    try {
      const text = await readFile(this.path, "utf8");
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as TurnLogEntry);
    } catch {
      return [];
    }
  }

  async reviewQueue(limit = 50): Promise<(TurnLogEntry & { reasons: TurnEvent[] })[]> {
    return (await this.all())
      .map((e) => ({ ...e, reasons: e.events.filter((ev) => REVIEW_EVENTS.includes(ev)) }))
      .filter((e) => e.reasons.length > 0)
      .reverse()
      .slice(0, limit);
  }
}
