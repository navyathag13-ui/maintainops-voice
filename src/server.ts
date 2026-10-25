import express from "express";
import multer from "multer";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent } from "./agent.js";
import { getConfig } from "./config.js";
import { HistoryStore } from "./history.js";
import { TurnLog } from "./turnlog.js";
import type { MaintenanceBackend } from "./maintainops.js";
import type { LlmClient } from "./openai.js";
import { runTurn, type Speech } from "./pipeline.js";
import { buildBackend, buildProviders } from "./providers.js";

export interface AppDeps {
  api: MaintenanceBackend;
  llm: LlmClient;
  speech: Speech;
  history: HistoryStore;
  turnLog: TurnLog;
  // Display name of the system logs are written to, e.g. "MaintainOps" or "Odoo".
  system?: string;
  staticDir?: string;
}

export function createApp(deps: AppDeps) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const sessions = new Map<string, Agent>();
  app.use(express.json());

  const technicians = new Map<string, { id: number; name: string } | null>();

  const agentFor = (id: string) => {
    let agent = sessions.get(id);
    if (!agent) {
      const technician = technicians.get(id) ?? null;
      agent = new Agent(deps.llm, deps.api, (log, draft, transcript) =>
        deps.history.add({
          maintainops_log_id: log.id,
          system,
          technician: technician?.name ?? null,
          equipment: draft.equipment.name,
          parts: draft.parts.map((p) => ({ name: p.name, quantity: p.quantity })),
          duration_minutes: draft.duration_minutes,
          notes: draft.notes,
          transcript,
          submitted_at: new Date().toISOString(),
        }),
        system,
      );
      agent.state.technician = technician;
      sessions.set(id, agent);
    }
    return agent;
  };

  const system = deps.system ?? "MaintainOps";

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", system });
  });

  // Active employees from MaintainOps, so the technician picks themself.
  app.get("/api/employees", async (_req, res) => {
    try {
      const all = await deps.api.listEmployees();
      res.json(all.filter((e) => e.active).map((e) => ({ id: e.id, name: e.name, role: e.role })));
    } catch (err) {
      res.status(502).json({ detail: (err as Error).message });
    }
  });

  app.post("/api/session", async (req, res) => {
    const sessionId = randomUUID();
    const techId = req.body?.technicianId;
    if (techId !== undefined && techId !== null && techId !== "") {
      const tech = (await deps.api.listEmployees()).find((e) => e.id === Number(techId) && e.active);
      if (!tech) {
        res.status(400).json({ detail: `Unknown or inactive employee ${techId}` });
        return;
      }
      technicians.set(sessionId, { id: tech.id, name: tech.name });
    }
    res.status(201).json({ sessionId, technician: technicians.get(sessionId) ?? null });
  });

  // One turn. Multipart with an `audio` file, or a `text` field (typed fallback).
  app.post("/api/turn", upload.single("audio"), async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? "");
    if (!sessionId) {
      res.status(400).json({ detail: "sessionId is required" });
      return;
    }
    const agent = agentFor(sessionId);
    try {
      const out = await runTurn(agent, deps.speech, {
        text: req.body?.text,
        audio: req.file
          ? { data: req.file.buffer, filename: req.file.originalname || "audio.webm", mimeType: req.file.mimetype }
          : undefined,
        speak: req.body?.speak !== "false",
      });
      await deps.turnLog.append({
        at: new Date().toISOString(),
        session: sessionId,
        technician: out.state.technician?.name ?? null,
        turn: out.state.turn,
        transcript: out.transcript,
        reply: out.reply,
        events: out.events,
        tools: out.toolCalls.map((t) => ({ name: t.name, status: String((t.result as { status?: string })?.status ?? "") })),
        timings: out.timings,
        maintainops_log_id: out.state.submitted?.id ?? null,
      });
      if (out.state.submitted || out.state.cancelled) sessions.delete(sessionId); // log done; next turn starts fresh
      res.json({
        transcript: out.transcript,
        reply: out.reply,
        audioBase64: out.audio?.toString("base64") ?? null,
        audioMime: deps.speech.audioMime,
        draft: out.state.lastDraft,
        issues: out.state.lastIssues,
        awaitingConfirmation: out.state.pending !== null,
        submitted: out.state.submitted,
        toolCalls: out.toolCalls.map((t) => t.name),
        events: out.events,
        cancelled: out.state.cancelled,
        timings: out.timings,
      });
    } catch (err) {
      res.status(502).json({ detail: (err as Error).message });
    }
  });

  app.get("/api/history", async (_req, res) => {
    res.json(await deps.history.list());
  });

  app.get("/api/review", async (_req, res) => {
    res.json(await deps.turnLog.reviewQueue());
  });

  if (deps.staticDir && existsSync(deps.staticDir)) {
    app.use(express.static(deps.staticDir));
  }
  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cfg = getConfig();
  let providers;
  try {
    providers = buildProviders(cfg);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const backend = buildBackend(cfg);
  const here = dirname(fileURLToPath(import.meta.url));
  const app = createApp({
    api: backend.backend,
    system: cfg.backend === "odoo" ? "Odoo" : "MaintainOps",
    llm: providers.llm,
    speech: providers.speech,
    history: new HistoryStore(cfg.historyPath),
    turnLog: new TurnLog(cfg.turnLogPath),
    staticDir: join(here, "..", "dist", "web"),
  });
  providers.warm?.().then(
    (ms) => console.log(`models loaded in ${Math.round(ms)} ms`),
    (err) => console.error(`warm-up failed: ${(err as Error).message}`),
  );
  app.listen(cfg.port, () => console.log(`maintainops-voice on http://localhost:${cfg.port} -> ${backend.label} (${JSON.stringify(providers.label)})`));
}
