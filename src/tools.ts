import type { Equipment, MaintenanceBackend, MaintenanceLogRead, Part } from "./maintainops.js";
import { matchByName } from "./matching.js";
import { canSubmit, type PendingProposal } from "./confirm.js";
import {
  describeForMaintainOps,
  LogDraftSchema,
  proposeLogJsonSchema,
  spokenSummary,
  type ResolvedDraft,
} from "./schema.js";

export type IssueCode =
  | "invalid_fields"
  | "ambiguous_equipment"
  | "unknown_equipment"
  | "ambiguous_part"
  | "unknown_part"
  | "duplicate_part"
  | "insufficient_stock"
  | "missing_duration"
  | "maintainops_rejected";

export interface Issue {
  code: IssueCode;
  // A ready-to-speak clarifying question. The LLM may rephrase it.
  question: string;
  options?: string[];
}

export interface SessionState {
  turn: number;
  lastUserUtterance: string;
  utterances: string[];
  cancelled: boolean;
  technician: { id: number; name: string } | null;
  pending: (PendingProposal & { draft: ResolvedDraft }) | null;
  // Most recent draft the agent tried, resolved or not, for the UI.
  lastDraft: ResolvedDraft | null;
  lastIssues: Issue[];
  submitted: MaintenanceLogRead | null;
}

export function newSessionState(): SessionState {
  return { turn: 0, lastUserUtterance: "", utterances: [], cancelled: false, technician: null, pending: null, lastDraft: null, lastIssues: [], submitted: null };
}

export interface ToolContext {
  api: MaintenanceBackend;
  state: SessionState;
  system?: string;
  onSubmitted?: (log: MaintenanceLogRead, draft: ResolvedDraft) => void | Promise<void>;
}

const SPOKEN_DURATION = /\b(min|mins|minutes?|hours?|hrs?)\b/i;

const names = (xs: { name: string }[]) => xs.map((x) => x.name);
const orList = (xs: string[]) =>
  xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;

function equipmentIssue(query: string, all: Equipment[], said: string[] = []): { item?: Equipment; issue?: Issue } {
  const m = matchByName(query, all, said);
  if (m.kind === "resolved") return { item: m.item };
  if (m.kind === "ambiguous") {
    const opts = names(m.candidates);
    return {
      issue: {
        code: "ambiguous_equipment",
        question: `There are ${opts.length} matches for "${query}": ${orList(opts)}. Which one was it?`,
        options: opts,
      },
    };
  }
  const opts = names(m.suggestions);
  return {
    issue: {
      code: "unknown_equipment",
      question: opts.length
        ? `I can't find equipment called "${query}". Did you mean ${orList(opts)}?`
        : `I can't find any equipment called "${query}". What's the name on the asset tag?`,
      options: opts,
    },
  };
}

function partIssue(query: string, all: Part[], said: string[] = []): { item?: Part; issue?: Issue } {
  const m = matchByName(query, all, said);
  if (m.kind === "resolved") return { item: m.item };
  if (m.kind === "ambiguous") {
    const opts = names(m.candidates);
    return {
      issue: {
        code: "ambiguous_part",
        question: `Which part did you mean by "${query}": ${orList(opts)}?`,
        options: opts,
      },
    };
  }
  const opts = names(m.suggestions);
  return {
    issue: {
      code: "unknown_part",
      question: opts.length
        ? `"${query}" isn't in the parts list. Did you mean ${orList(opts)}?`
        : `"${query}" isn't in the parts list. What part was it?`,
      options: opts,
    },
  };
}

export async function findEquipment(ctx: ToolContext, args: { query: string }) {
  const all = await ctx.api.listEquipment();
  const { item, issue } = equipmentIssue(args.query, all, ctx.state.utterances);
  if (item) return { status: "resolved", equipment: { id: item.id, name: item.name, location: item.current_location } };
  return { status: "needs_clarification", issues: [issue!] };
}

export async function checkPartStock(ctx: ToolContext, args: { part: string; quantity?: number }) {
  const all = await ctx.api.listParts();
  const { item, issue } = partIssue(args.part, all, ctx.state.utterances);
  if (!item) return { status: "needs_clarification", issues: [issue!] };
  const enough = args.quantity === undefined ? undefined : item.quantity_on_hand >= args.quantity;
  return { status: "resolved", part: { id: item.id, name: item.name, in_stock: item.quantity_on_hand }, enough };
}

export async function proposeLog(ctx: ToolContext, rawArgs: unknown) {
  ctx.state.pending = null;
  const parsed = LogDraftSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".") || "input").join(", ");
    const issue: Issue = {
      code: "invalid_fields",
      question: `I still need: ${missing}. Can you tell me?`,
    };
    ctx.state.lastIssues = [issue];
    return { status: "needs_clarification", issues: [issue], field_errors: parsed.error.issues };
  }
  const draft = parsed.data;
  const [equipment, parts] = await Promise.all([ctx.api.listEquipment(), ctx.api.listParts()]);

  const said = ctx.state.utterances;
  const issues: Issue[] = [];
  const eq = equipmentIssue(draft.equipment, equipment, said);
  if (eq.issue) issues.push(eq.issue);
  // Seen in the eval: with no duration spoken, the model filled in "30".
  // A duration only counts if the technician said a time unit at some point.
  if (said.length && !said.some((u) => SPOKEN_DURATION.test(u))) {
    issues.push({ code: "missing_duration", question: "How long did the job take?" });
  }

  const resolvedParts: ResolvedDraft["parts"] = [];
  for (const p of draft.parts) {
    const r = partIssue(p.part, parts, said);
    if (r.issue) {
      issues.push(r.issue);
      continue;
    }
    const part = r.item!;
    if (resolvedParts.some((x) => x.id === part.id)) {
      issues.push({
        code: "duplicate_part",
        question: `You mentioned ${part.name} more than once. What's the total quantity you used?`,
        options: [part.name],
      });
      continue;
    }
    if (part.quantity_on_hand < p.quantity) {
      issues.push({
        code: "insufficient_stock",
        question: `The system shows only ${part.quantity_on_hand} ${part.name} in stock, but you said ${p.quantity}. How many did you actually use?`,
        options: [part.name],
      });
    }
    resolvedParts.push({ id: part.id, name: part.name, quantity: p.quantity, available: part.quantity_on_hand });
  }

  const resolved: ResolvedDraft | null = eq.item
    ? {
        equipment: { id: eq.item.id, name: eq.item.name },
        parts: resolvedParts,
        duration_minutes: draft.duration_minutes,
        notes: draft.notes?.trim() || ctx.state.utterances[0] || "",
      }
    : null;
  ctx.state.lastDraft = resolved;
  ctx.state.lastIssues = issues;

  if (issues.length || !resolved) return { status: "needs_clarification", issues };

  ctx.state.pending = { draft: resolved, proposedAtTurn: ctx.state.turn };
  return {
    status: "awaiting_confirmation",
    summary: spokenSummary(resolved),
    instruction: "The system will read this back and save it only if the technician says yes.",
  };
}

export async function submitLog(ctx: ToolContext) {
  const gate = canSubmit(ctx.state.pending, ctx.state.turn, ctx.state.lastUserUtterance);
  if (!gate.allowed) return { status: "refused", reason: gate.reason };
  const draft = ctx.state.pending!.draft;

  const result = await ctx.api.createMaintenanceLog({
    equipment_id: draft.equipment.id,
    description: describeForMaintainOps(draft, ctx.state.technician),
    duration_minutes: draft.duration_minutes,
    technician_id: ctx.state.technician?.id ?? null,
    parts_used: draft.parts.map((p) => ({ part_id: p.id, quantity: p.quantity })),
  });

  if (result.ok) {
    ctx.state.pending = null;
    ctx.state.submitted = result.log;
    ctx.state.lastIssues = [];
    await ctx.onSubmitted?.(result.log, draft);
    return { status: "submitted", maintainops_log_id: result.log.id };
  }

  // MaintainOps rejected it (e.g. stock changed between read-back and submit:
  // its all-or-nothing check returns 400 with shortfalls and nothing is written).
  ctx.state.pending = null;
  const issues: Issue[] = result.shortfalls?.length
    ? result.shortfalls.map((s) => {
        const name = draft.parts.find((p) => p.id === s.part_id)?.name ?? `part ${s.part_id}`;
        return {
          code: "insufficient_stock" as const,
          question: `${ctx.system ?? "MaintainOps"} rejected the log: only ${s.available} ${name} in stock, you said ${s.requested}. Nothing was saved. How many did you actually use?`,
          options: [name],
        };
      })
    : [
        {
          code: "maintainops_rejected" as const,
          question: `${ctx.system ?? "MaintainOps"} rejected the log (${result.status}: ${result.detail}). Nothing was saved. Can you check the details?`,
        },
      ];
  ctx.state.lastIssues = issues;
  return { status: "rejected", http_status: result.status, issues };
}

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_equipment",
      description: "Look up a piece of equipment in MaintainOps by the name the technician used.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_part_stock",
      description: "Look up a spare part by name and check how many are in stock.",
      parameters: {
        type: "object",
        properties: { part: { type: "string" }, quantity: { type: "integer", minimum: 1 } },
        required: ["part"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_log",
      description:
        "Validate the full maintenance log against MaintainOps (equipment, parts, stock). Returns issues to ask about, or confirms the log is ready for the technician's yes.",
      parameters: proposeLogJsonSchema,
    },
  },
] as const;

export async function runTool(ctx: ToolContext, name: string, args: unknown): Promise<unknown> {
  switch (name) {
    case "find_equipment":
      return findEquipment(ctx, args as { query: string });
    case "check_part_stock":
      return checkPartStock(ctx, args as { part: string; quantity?: number });
    case "propose_log":
      return proposeLog(ctx, args);
    default:
      return { status: "error", reason: `Unknown tool ${name}` };
  }
}
