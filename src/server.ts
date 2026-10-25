import express from "express";
import multer from "multer";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent } from "./agent.js";
import { getConfig } from "./config.js";
import { HistoryStore } from "./history.js";
import { MaintainOpsClient, type MaintainOpsApi } from "./maintainops.js";
import type { LlmClient } from "./openai.js";
import { runTurn, type Speech } from "./pipeline.js";
import { buildProviders } from "./providers.js";

export interface AppDeps {
  api: MaintainOpsApi;
  llm: LlmClient;
  speech: Speech;
  history: HistoryStore;
  staticDir?: string;
}

export function createApp(deps: AppDeps) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const sessions = new Map<string, Agent>();
  app.use(express.json());

  const agentFor = (id: string) => {
    let agent = sessions.get(id);
    if (!agent) {
      agent = new Agent(deps.llm, deps.api, (log, draft, transcript) =>
        deps.history.add({
          maintainops_log_id: log.id,
          equipment: draft.equipment.name,
          parts: draft.parts.map((p) => ({ name: p.name, quantity: p.quantity })),
          duration_minutes: draft.duration_minutes,
          notes: draft.notes,
          transcript,
          submitted_at: new Date().toISOString(),
        }),
      );
      sessions.set(id, agent);
    }
    return agent;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/session", (_req, res) => {
    res.status(201).json({ sessionId: randomUUID() });
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
      if (out.state.submitted) sessions.delete(sessionId); // log done; next turn starts fresh
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
        timings: out.timings,
      });
    } catch (err) {
      res.status(502).json({ detail: (err as Error).message });
    }
  });

  app.get("/api/history", async (_req, res) => {
    res.json(await deps.history.list());
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
  const here = dirname(fileURLToPath(import.meta.url));
  const app = createApp({
    api: new MaintainOpsClient(cfg.maintainopsUrl),
    llm: providers.llm,
    speech: providers.speech,
    history: new HistoryStore(cfg.historyPath),
    staticDir: join(here, "..", "dist", "web"),
  });
  app.listen(cfg.port, () => console.log(`maintainops-voice on http://localhost:${cfg.port} -> ${cfg.maintainopsUrl} (${JSON.stringify(providers.label)})`));
}
