import { useCallback, useEffect, useRef, useState } from "react";

interface DraftPart {
  id: number;
  name: string;
  quantity: number;
  available: number;
}
interface Draft {
  equipment: { id: number; name: string };
  parts: DraftPart[];
  duration_minutes: number;
  notes: string;
}
interface Issue {
  code: string;
  question: string;
}
interface TurnResponse {
  transcript: string;
  reply: string;
  audioBase64: string | null;
  audioMime: string;
  draft: Draft | null;
  issues: Issue[];
  awaitingConfirmation: boolean;
  submitted: { id: number } | null;
  timings: { sttMs: number; llmMs: number; ttsMs: number; totalMs: number };
}
interface HistoryEntry {
  maintainops_log_id: number;
  system?: string;
  technician: string | null;
  equipment: string;
  parts: { name: string; quantity: number }[];
  duration_minutes: number;
  notes: string;
  submitted_at: string;
}
interface Employee {
  id: number;
  name: string;
  role: string;
}
interface ReviewItem {
  at: string;
  technician: string | null;
  transcript: string;
  reply: string;
  reasons: string[];
}
interface Line {
  who: "tech" | "agent";
  text: string;
  ms?: number;
}

async function newSession(technicianId: number | null): Promise<string> {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ technicianId }),
  });
  return ((await res.json()) as { sessionId: string }).sessionId;
}

const REASON_LABEL: Record<string, string> = {
  readback_corrected: "read-back corrected",
  rejected_by_maintainops: "rejected by MaintainOps",
  save_claim_replaced: "model claimed a save",
  stuck: "agent got stuck",
  cancelled: "cancelled",
};

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState("Press Record and describe the job.");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [technicianId, setTechnicianId] = useState<number | null>(null);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [system, setSystem] = useState("MaintainOps");
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const loadHistory = useCallback(async () => {
    const [h, r] = await Promise.all([fetch("/api/history"), fetch("/api/review")]);
    if (h.ok) setHistory(await h.json());
    if (r.ok) setReview(await r.json());
  }, []);

  useEffect(() => {
    fetch("/api/employees").then(async (r) => r.ok && setEmployees(await r.json()));
    fetch("/api/health").then(async (r) => r.ok && setSystem((await r.json()).system ?? "MaintainOps"));
    loadHistory();
  }, [loadHistory]);

  // A new session whenever the technician changes; the server stamps their name on the log.
  useEffect(() => {
    newSession(technicianId).then(setSessionId);
    setLines([]);
    setDraft(null);
    setIssues([]);
  }, [technicianId]);

  async function send(form: FormData) {
    if (!sessionId) return;
    form.append("sessionId", sessionId);
    setBusy(true);
    setStatus("Thinking…");
    try {
      const res = await fetch("/api/turn", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? res.statusText);
      const turn = data as TurnResponse;
      setLines((l) => [
        ...l,
        { who: "tech", text: turn.transcript },
        { who: "agent", text: turn.reply, ms: Math.round(turn.timings.totalMs) },
      ]);
      setDraft(turn.draft);
      setIssues(turn.issues);
      if (turn.submitted) {
        setStatus(`Saved to ${system} as record #${turn.submitted.id}.`);
        setSessionId(await newSession(technicianId));
        loadHistory();
      } else if ((turn as TurnResponse & { cancelled?: boolean }).cancelled) {
        setStatus("Cancelled. Nothing was saved.");
        setSessionId(await newSession(technicianId));
        loadHistory();
      } else if (turn.awaitingConfirmation) {
        setStatus("Waiting for your confirmation. Say yes to submit or correct anything.");
      } else if (turn.issues.length) {
        setStatus("Needs clarification.");
      } else {
        setStatus("Listening for the rest of the log.");
      }
      if (turn.audioBase64) new Audio(`data:${turn.audioMime};base64,${turn.audioBase64}`).play().catch(() => {});
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      setRecording(false);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    chunks.current = [];
    rec.ondataavailable = (e) => chunks.current.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
      const ext = blob.type.includes("mp4") ? "m4a" : "webm";
      const form = new FormData();
      form.append("audio", blob, `turn.${ext}`);
      send(form);
    };
    rec.start();
    recorder.current = rec;
    setRecording(true);
    setStatus("Recording… press Stop when you're done.");
  }

  function sendFile(file: File) {
    const form = new FormData();
    form.append("audio", file, file.name);
    send(form);
  }

  function sendTyped(e: React.FormEvent) {
    e.preventDefault();
    if (!typed.trim()) return;
    const form = new FormData();
    form.append("text", typed);
    setTyped("");
    send(form);
  }

  return (
    <main>
      <header>
        <h1>MaintainOps Voice</h1>
        <p className="muted">Speak a maintenance log. It's checked against {system} and read back before anything is saved.</p>
      </header>

      <section className="controls">
        <label className="tech">
          Technician{" "}
          <select
            value={technicianId ?? ""}
            onChange={(e) => setTechnicianId(e.target.value ? Number(e.target.value) : null)}
            disabled={busy || recording}
          >
            <option value="">Not set</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.role.replace("_", " ")})
              </option>
            ))}
          </select>
        </label>
        <button className={recording ? "rec on" : "rec"} onClick={toggleRecording} disabled={busy || !sessionId}>
          {recording ? "■ Stop" : "● Record"}
        </button>
        <label className="upload">
          Upload audio
          <input type="file" accept="audio/*" disabled={busy} onChange={(e) => e.target.files?.[0] && sendFile(e.target.files[0])} />
        </label>
        <form onSubmit={sendTyped} className="typed">
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="…or type instead" disabled={busy} />
          <button disabled={busy}>Send</button>
        </form>
      </section>
      <p className="status" role="status">{status}</p>

      <div className="grid">
        <section className="card">
          <h2>Conversation</h2>
          {lines.length === 0 && <p className="muted">Nothing yet.</p>}
          {lines.map((l, i) => (
            <p key={i} className={`line ${l.who}`}>
              <strong>{l.who === "tech" ? "You" : "Agent"}:</strong> {l.text}
              {l.ms !== undefined && <span className="muted"> ({l.ms} ms)</span>}
            </p>
          ))}
        </section>

        <section className="card">
          <h2>Extracted log</h2>
          {!draft && <p className="muted">No fields extracted yet.</p>}
          {draft && (
            <dl>
              <dt>Equipment</dt>
              <dd>{draft.equipment.name} (id {draft.equipment.id})</dd>
              <dt>Duration</dt>
              <dd>{draft.duration_minutes} min</dd>
              <dt>Parts</dt>
              <dd>
                {draft.parts.length === 0
                  ? "None"
                  : draft.parts.map((p) => (
                      <div key={p.id} className={p.quantity > p.available ? "short" : ""}>
                        {p.quantity} × {p.name} <span className="muted">({p.available} in stock)</span>
                      </div>
                    ))}
              </dd>
              <dt>Notes</dt>
              <dd>{draft.notes}</dd>
            </dl>
          )}
          {issues.length > 0 && (
            <ul className="issues">
              {issues.map((i, k) => (
                <li key={k}>
                  <code>{i.code}</code> {i.question}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Needs review</h2>
        {review.length === 0 && <p className="muted">Nothing flagged.</p>}
        {review.map((r, i) => (
          <div key={i} className="review">
            <div>
              {r.reasons.map((x) => (
                <span key={x} className="tag">{REASON_LABEL[x] ?? x}</span>
              ))}
              <span className="muted"> {r.technician ?? "No technician"} · {new Date(r.at).toLocaleString()}</span>
            </div>
            <div><strong>Tech:</strong> {r.transcript}</div>
            <div className="muted"><strong>Agent:</strong> {r.reply}</div>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Voice-submitted logs</h2>
        {history.length === 0 && <p className="muted">None yet.</p>}
        <table>
          <tbody>
            {history.map((h) => (
              <tr key={h.maintainops_log_id}>
                <td>{h.system ?? "MaintainOps"} #{h.maintainops_log_id}</td>
                <td>{h.technician ?? "—"}</td>
                <td>{h.equipment}</td>
                <td>{h.duration_minutes} min</td>
                <td>{h.parts.map((p) => `${p.quantity} ${p.name}`).join(", ") || "No parts"}</td>
                <td className="muted">{new Date(h.submitted_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
