import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.js";
import { toolDefinitions } from "../src/tools.js";
import { createApp } from "../src/server.js";
import { HistoryStore } from "../src/history.js";
import { FakeMaintainOps, ScriptedLlm } from "./fakes.js";

const log = { equipment: "generator 2", parts: [{ part: "bearings", quantity: 2 }], duration_minutes: 30, notes: "Replaced bearings" };

describe("Agent loop", () => {
  it("never offers the model a submit tool", () => {
    expect(toolDefinitions.map((t) => t.function.name)).toEqual(["find_equipment", "check_part_stock", "propose_log"]);
  });

  it("reads back the exact resolved record after propose_log, not the model's own wording", async () => {
    const api = new FakeMaintainOps();
    const llm = new ScriptedLlm([{ tools: [{ name: "propose_log", args: log }] }]);
    const agent = new Agent(llm, api);
    const r = await agent.turn("Replaced two bearings on generator 2, took 30 minutes, yes submit it");
    expect(r.reply).toBe("I have Generator #02, 30 minutes, 2 Bearings. Notes: Replaced bearings. Should I submit it?");
    expect(api.created).toHaveLength(0); // "yes submit it" in the same breath is not a confirmation
    expect(llm.calls).toBe(1);
  });

  it("speaks the first clarifying question from propose_log", async () => {
    const llm = new ScriptedLlm([{ tools: [{ name: "propose_log", args: { ...log, equipment: "generator" } }] }]);
    const r = await new Agent(llm, new FakeMaintainOps()).turn("bearings on the generator, 30 minutes");
    expect(r.reply).toBe('There are 3 matches for "generator": Generator #01, Generator #02 or Generator #03. Which one was it?');
  });

  it("submits exactly once on a spoken yes, in code, without calling the model", async () => {
    const api = new FakeMaintainOps();
    const submitted: number[] = [];
    const llm = new ScriptedLlm([{ tools: [{ name: "propose_log", args: log }] }]);
    const agent = new Agent(llm, api, (l) => {
      submitted.push(l.id);
    });
    await agent.turn("Replaced two bearings on generator 2, 30 minutes");
    const r = await agent.turn("yes");
    expect(r.reply).toBe("Saved to MaintainOps as log number 100.");
    expect(r.llmCalls).toBe(0);
    expect(api.created).toHaveLength(1);
    expect(submitted).toEqual([100]);
  });

  it("sends a correction back to the model and re-reads the corrected log", async () => {
    const api = new FakeMaintainOps();
    const llm = new ScriptedLlm([
      { tools: [{ name: "propose_log", args: log }] },
      { tools: [{ name: "propose_log", args: { ...log, equipment: "generator 3" } }] },
    ]);
    const agent = new Agent(llm, api);
    await agent.turn("two bearings on generator 2, 30 minutes");
    const r = await agent.turn("no, it was generator three");
    expect(r.reply).toContain("I have Generator #03");
    expect(api.created).toHaveLength(0);
    expect((await agent.turn("yes")).reply).toBe("Saved to MaintainOps as log number 100.");
    expect(api.created[0].equipment_id).toBe(3);
  });

  it("retries once when the model narrates instead of re-proposing after an answer", async () => {
    const api = new FakeMaintainOps();
    const llm = new ScriptedLlm([
      { tools: [{ name: "propose_log", args: { ...log, equipment: "generator" } }] },
      { say: "Proposing log again with generator 2." },
      { tools: [{ name: "propose_log", args: log }] },
    ]);
    const agent = new Agent(llm, api);
    await agent.turn("two bearings on the generator, 30 minutes");
    const r = await agent.turn("Generator two.");
    expect(r.reply).toContain("I have Generator #02");
    expect(r.llmCalls).toBe(2);
  });

  it("does not nudge when no log is in progress", async () => {
    const llm = new ScriptedLlm([{ say: "Which equipment did you work on" }]);
    const r = await new Agent(llm, new FakeMaintainOps()).turn("hello");
    expect(r.llmCalls).toBe(1);
  });

  it("cancels on request and writes nothing", async () => {
    const api = new FakeMaintainOps();
    const agent = new Agent(new ScriptedLlm([{ tools: [{ name: "propose_log", args: log }] }]), api);
    await agent.turn("two bearings on generator 2, 30 minutes");
    const r = await agent.turn("No, cancel that.");
    expect(r.reply).toBe("Okay, I won't save it. Nothing was submitted.");
    expect(agent.state.pending).toBeNull();
    expect(api.created).toHaveLength(0);
  });

  it("replaces a reply that claims a save that never happened", async () => {
    // Seen with qwen2.5:7b: "Log 456789 was saved." with no submit at all.
    const llm = new ScriptedLlm([{ say: "Log 456789 was saved." }]);
    const r = await new Agent(llm, new FakeMaintainOps()).turn("yes");
    expect(r.reply).toBe("Nothing has been saved yet. Which equipment was it, and how long did the job take?");
  });

  it("uses the technician's words as notes when the model leaves notes out", async () => {
    const { notes: _omit, ...noNotes } = log;
    const agent = new Agent(new ScriptedLlm([{ tools: [{ name: "propose_log", args: noNotes }] }]), new FakeMaintainOps());
    await agent.turn("Swapped two bearings on generator 2, half an hour");
    expect(agent.state.pending?.draft.notes).toBe("Swapped two bearings on generator 2, half an hour");
  });

  it("rolls back the turn when the LLM call fails, so a retry isn't duplicated", async () => {
    const api = new FakeMaintainOps();
    const llm = new ScriptedLlm([]); // throws on first call
    const agent = new Agent(llm, api);
    await expect(agent.turn("generator two, 30 minutes")).rejects.toThrow();
    expect(agent.messages).toHaveLength(1); // system prompt only
    expect(agent.state.turn).toBe(0);
  });

  it("feeds tool errors back to the model instead of crashing", async () => {
    const api = new FakeMaintainOps();
    api.listEquipment = async () => {
      throw new Error("MaintainOps GET /equipment failed: 503");
    };
    const llm = new ScriptedLlm([{ tools: [{ name: "find_equipment", args: { query: "generator" } }] }, { say: "MaintainOps is down." }]);
    const r = await new Agent(llm, api).turn("generator");
    expect(r.toolCalls[0].result).toMatchObject({ status: "error" });
    expect(r.reply).toBe("MaintainOps is down.");
  });
});

describe("HTTP API", () => {
  it("runs a typed two-turn conversation and records the voice log in history", async () => {
    const api = new FakeMaintainOps();
    const llm = new ScriptedLlm([{ tools: [{ name: "propose_log", args: log }] }]);
    const history = new HistoryStore(join(mkdtempSync(join(tmpdir(), "mov-")), "history.json"));
    const speech = { transcribe: async () => "unused", synthesize: async () => Buffer.from("mp3"), audioMime: "audio/mpeg" };
    const server = createApp({ api, llm, speech, history }).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const turn = (text: string) =>
        fetch(`${base}/api/turn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "s1", text }) }).then((r) => r.json());
      const first = await turn("two bearings on generator 2, 30 minutes");
      expect(first).toMatchObject({ awaitingConfirmation: true, submitted: null, audioBase64: Buffer.from("mp3").toString("base64") });
      const second = await turn("yes");
      expect(second.submitted).toMatchObject({ id: 100 });
      const h = await fetch(`${base}/api/history`).then((r) => r.json());
      expect(h).toMatchObject([{ maintainops_log_id: 100, equipment: "Generator #02", transcript: ["two bearings on generator 2, 30 minutes", "yes"] }]);
    } finally {
      server.close();
    }
  });

  it("requires a sessionId", async () => {
    const server = createApp({
      api: new FakeMaintainOps(),
      llm: new ScriptedLlm([]),
      speech: { transcribe: async () => "", synthesize: async () => Buffer.alloc(0), audioMime: "audio/mpeg" },
      history: new HistoryStore("/nonexistent/h.json"),
    }).listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
