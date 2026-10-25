import type { ChatMessage, LlmClient } from "./openai.js";
import { isCancel, isConfirmation } from "./confirm.js";
import { newSessionState, runTool, submitLog, toolDefinitions, type Issue, type SessionState, type ToolContext } from "./tools.js";
import type { MaintenanceBackend, MaintenanceLogRead } from "./maintainops.js";
import { spokenSummary, type ResolvedDraft } from "./schema.js";

export const SYSTEM_PROMPT = `You are a voice assistant for maintenance technicians at a small industrial site.
The technician speaks a maintenance log; you turn it into a record in the site's maintenance system.
Replies are spoken aloud: one or two short sentences, no lists, no markdown.

A log needs: equipment, parts used with quantities (may be none), duration in minutes, and a short note on what was done.
Rules:
- Never guess an id. Pass names exactly as the technician said them; the tools resolve them.
- If the equipment or the duration is missing, ask for it. Do not ask for anything else.
- Once you have the equipment and the duration, call propose_log with everything you know.
- When the technician answers a question or corrects something, call propose_log again with the full, updated log.
- You cannot save logs. The system reads the summary back and saves it only after the technician says yes. Never say a log was saved.
- Durations are in minutes ("an hour and a half" = 90).`;

// What happened in a turn, for the turn log and the review queue.
export type TurnEvent =
  | "submitted"
  | "rejected_by_maintainops"
  | "cancelled"
  | "readback_corrected"
  | "clarifying_question"
  | "read_back"
  | "nudged"
  | "save_claim_replaced"
  | "stuck";

export interface TurnResult {
  reply: string;
  events: TurnEvent[];
  toolCalls: { name: string; args: unknown; result: unknown }[];
  llmMs: number;
  llmCalls: number;
  state: SessionState;
}

const MAX_STEPS = 6;
const CLAIMS_SAVED = /\b(saved|submitted|recorded|logged)\b|\blog (number |#)?\d+/i;

export const readBack = (d: ResolvedDraft) => `I have ${spokenSummary(d)}. Should I submit it?`;

export class Agent {
  readonly state: SessionState = newSessionState();
  readonly messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  constructor(
    private llm: LlmClient,
    private api: MaintenanceBackend,
    private onSubmitted?: (log: MaintenanceLogRead, draft: ResolvedDraft, transcript: string[]) => void | Promise<void>,
    // Name spoken to the technician for the system logs go to.
    private system = "MaintainOps",
  ) {}

  async turn(utterance: string): Promise<TurnResult> {
    // If the LLM call fails (network, quota), undo this turn so a retry of the
    // same utterance doesn't appear twice in the conversation.
    const snapshot = {
      messages: this.messages.length,
      utterances: this.state.utterances.length,
      turn: this.state.turn,
      last: this.state.lastUserUtterance,
    };
    try {
      return await this.runTurn(utterance);
    } catch (err) {
      this.messages.length = snapshot.messages;
      this.state.utterances.length = snapshot.utterances;
      this.state.turn = snapshot.turn;
      this.state.lastUserUtterance = snapshot.last;
      throw err;
    }
  }

  private events: TurnEvent[] = [];

  private say(reply: string, rest: Omit<TurnResult, "reply" | "state" | "events">): TurnResult {
    this.messages.push({ role: "assistant", content: reply });
    return { reply, events: this.events, ...rest, state: this.state };
  }

  private async runTurn(utterance: string): Promise<TurnResult> {
    this.events = [];
    this.state.turn += 1;
    this.state.lastUserUtterance = utterance;
    this.state.utterances.push(utterance);
    this.messages.push({ role: "user", content: utterance });

    const ctx: ToolContext = {
      api: this.api,
      state: this.state,
      system: this.system,
      onSubmitted: (log, draft) => this.onSubmitted?.(log, draft, [...this.state.utterances]),
    };
    const toolCalls: TurnResult["toolCalls"] = [];

    // The yes/no on a read-back is handled in code, not by the model: the model
    // has no submit tool, so it can neither save early nor claim a save that
    // didn't happen.
    if (this.state.pending) {
      if (isConfirmation(utterance)) {
        const result = await submitLog(ctx);
        toolCalls.push({ name: "submit_log", args: {}, result });
        if (result.status === "submitted") this.events.push("submitted");
        if (result.status === "rejected") this.events.push("rejected_by_maintainops");
        const reply =
          result.status === "submitted"
            ? `Saved to ${this.system} as ${this.system === "MaintainOps" ? "log" : "record"} number ${result.maintainops_log_id}.`
            : result.status === "rejected"
              ? (result.issues?.[0]?.question ?? "MaintainOps rejected the log. Nothing was saved.")
              : "Sorry, I couldn't submit that. Can you say yes again?";
        return this.say(reply, { toolCalls, llmMs: 0, llmCalls: 0 });
      }
      if (isCancel(utterance)) {
        this.state.pending = null;
        this.state.cancelled = true;
        this.events.push("cancelled");
        this.state.lastDraft = null;
        this.state.lastIssues = [];
        return this.say("Okay, I won't save it. Nothing was submitted.", { toolCalls, llmMs: 0, llmCalls: 0 });
      }
      // Anything else is a correction: the model re-proposes the log.
      this.state.pending = null;
      this.events.push("readback_corrected");
    }
    // A log is in progress if the last turn ended in a read-back or a question
    // from propose_log. Answers to those must lead to a new propose_log call.
    const logInProgress = this.state.lastDraft !== null || this.state.lastIssues.length > 0;
    let nudged = false;

    let llmMs = 0;
    let llmCalls = 0;
    let modelText = "";
    const seen: { propose: { status: string; issues?: Issue[] } | null } = { propose: null };

    for (let step = 0; step < MAX_STEPS; step++) {
      const t0 = performance.now();
      const msg = await this.llm.complete(this.messages, toolDefinitions);
      llmMs += performance.now() - t0;
      llmCalls += 1;

      if (!msg.tool_calls?.length) {
        modelText = msg.content?.trim() ?? "";
        // Seen in eval run 2: after "15 minutes." or a correction, qwen2.5:7b
        // replied "Proposing log again with 15 minutes" and called nothing.
        // Seen in run 4: it asked "...in 15 minutes. Confirm?" itself, a
        // read-back that isn't the real record. While a log is in progress,
        // every question comes from propose_log, so any reply without a tool
        // call gets one retry with an explicit instruction.
        if (logInProgress && !nudged) {
          nudged = true;
          this.events.push("nudged");
          this.messages.push({ role: "assistant", content: msg.content ?? "" });
          this.messages.push({
            role: "system",
            content: "Do not describe the log. Call propose_log now with the full, updated log, using the technician's latest answer.",
          });
          continue;
        }
        break;
      }
      this.messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args: unknown;
        let result: unknown;
        try {
          args = JSON.parse(call.function.arguments || "{}");
          result = await runTool(ctx, call.function.name, args);
        } catch (err) {
          result = { status: "error", reason: (err as Error).message };
        }
        toolCalls.push({ name: call.function.name, args, result });
        if (call.function.name === "propose_log") seen.propose = result as typeof seen.propose;
        this.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      // Once propose_log has answered, what to say next is decided by its result.
      if (seen.propose) break;
    }

    // Read-backs and clarifying questions come from the tool results, word for
    // word, so the technician always hears the exact record that would be saved.
    const lastPropose = seen.propose;
    let reply: string;
    // (re-read: propose_log mutated state.pending inside the loop)
    const pending = this.state.pending as SessionState["pending"];
    if (lastPropose?.status === "awaiting_confirmation" && pending) {
      reply = readBack(pending.draft);
      this.events.push("read_back");
    } else if (lastPropose?.issues?.length) {
      reply = lastPropose.issues[0].question;
      this.events.push("clarifying_question");
    } else if (!modelText) {
      reply = "Sorry, I got stuck on that one. Can you repeat the log?";
      this.events.push("stuck");
    } else if (logInProgress) {
      // The model ignored the retry too (seen in eval run 5: "Propose_log with
      // 15 minutes duration."). Don't speak its prose; repeat the open question.
      const open = this.state.lastIssues[0]?.question;
      reply = open ? `Sorry, I didn't get that. ${open}` : "Sorry, I didn't get that. Can you say the whole log again?";
      this.events.push("stuck");
    } else if (CLAIMS_SAVED.test(modelText)) {
      reply = "Nothing has been saved yet. Which equipment was it, and how long did the job take?";
      this.events.push("save_claim_replaced");
    } else {
      reply = modelText;
    }
    return this.say(reply, { toolCalls, llmMs, llmCalls });
  }
}
