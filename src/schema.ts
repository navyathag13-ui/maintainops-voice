import { z } from "zod";

// What the LLM extracts from the technician's speech. It passes spoken names,
// not ids: ids are resolved in code (see tools.ts) so a hallucinated id can
// never reach MaintainOps.
export const LogDraftSchema = z.object({
  equipment: z.string().min(1).describe("Equipment as the technician said it, e.g. 'generator 2'"),
  parts: z
    .array(
      z.object({
        part: z.string().min(1).describe("Part as the technician said it, e.g. 'drive belts'"),
        quantity: z.number().int().positive(),
      }),
    )
    .default([]),
  duration_minutes: z.number().int().positive().max(24 * 60),
  // Optional: when the model leaves it out, the technician's own words are used.
  notes: z.string().optional().describe("What was done, in the technician's words"),
});

export type LogDraft = z.infer<typeof LogDraftSchema>;

// A draft after every name has been resolved to a MaintainOps id.
export interface ResolvedDraft {
  equipment: { id: number; name: string };
  parts: { id: number; name: string; quantity: number; available: number }[];
  duration_minutes: number;
  notes: string;
}

export function describeForMaintainOps(d: ResolvedDraft): string {
  // MaintainOps' log has no duration column, so it goes into the description.
  return `[Voice log] Duration: ${d.duration_minutes} min. ${d.notes}`;
}

export function spokenSummary(d: ResolvedDraft): string {
  const parts = d.parts.length
    ? d.parts.map((p) => `${p.quantity} ${p.name}`).join(", ")
    : "no parts";
  return `${d.equipment.name}, ${d.duration_minutes} minutes, ${parts}. Notes: ${d.notes.replace(/[.\s]+$/, "")}`;
}

// JSON schema handed to the LLM for the propose_log tool. Kept in sync with
// LogDraftSchema by tests/schema.test.ts.
export const proposeLogJsonSchema = {
  type: "object",
  properties: {
    equipment: { type: "string", description: "Equipment as the technician said it" },
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          part: { type: "string", description: "Part name as the technician said it" },
          quantity: { type: "integer", minimum: 1 },
        },
        required: ["part", "quantity"],
        additionalProperties: false,
      },
    },
    duration_minutes: { type: "integer", minimum: 1 },
    notes: { type: "string" },
  },
  required: ["equipment", "parts", "duration_minutes"],
  additionalProperties: false,
} as const;
