// Direct calls to the OpenAI REST API (no SDK): Whisper STT, chat completions
// with tool calling, and TTS. Each takes an injectable fetch for tests.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmClient {
  complete(messages: ChatMessage[], tools: readonly unknown[]): Promise<ChatMessage>;
}

const BASE = "https://api.openai.com/v1";

async function check(res: Response, what: string) {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${what} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return res;
}

export class OpenAiChat implements LlmClient {
  // baseUrl also points this at any OpenAI-compatible server, e.g. Ollama's
  // http://localhost:11434/v1 for the free local mode.
  constructor(
    private apiKey: string,
    private model: string,
    private baseUrl: string = BASE,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(messages: ChatMessage[], tools: readonly unknown[]): Promise<ChatMessage> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, tools, temperature: 0 }),
    });
    await check(res, "chat");
    const data = (await res.json()) as { choices: { message: ChatMessage }[] };
    return data.choices[0].message;
  }
}

export async function transcribe(
  apiKey: string,
  model: string,
  audio: Buffer,
  filename: string,
  mimeType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append("model", model);
  form.append("language", "en");
  // Biasing prompt: equipment and part vocabulary Whisper would otherwise mishear.
  form.append("prompt", "Maintenance log. Generator, water pump, air compressor, drive belts, oil filters, bearings, hydraulic hoses.");
  const res = await fetchImpl(`${BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  await check(res, "transcription");
  const data = (await res.json()) as { text: string };
  return data.text.trim();
}

export async function synthesize(
  apiKey: string,
  model: string,
  voice: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const res = await fetchImpl(`${BASE}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
  });
  await check(res, "speech");
  return Buffer.from(await res.arrayBuffer());
}
