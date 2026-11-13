// A client for a language model server: llama.cpp or any OpenAI-compatible one, reached over HTTP. Whoever uses it names
// the server; requests to one server queue per device so a small GPU is never asked twice at once.
import { trimEnd } from "./text";

export interface LlmServer { baseUrl: string; apiKey?: string; model?: string }
export type LlmPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface LlmMessage { role: "system" | "user" | "assistant"; content: string | LlmPart[] }

// The text of a message, for sizing it.
export const textOf = (message: LlmMessage): string =>
  typeof message.content === "string" ? message.content : message.content.map((p) => (p.type === "text" ? p.text : "[picture]")).join(" ");
export interface LlmOptions {
  // Forces the reply to be JSON matching this schema (the server's grammar option).
  schema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}
export interface LlmReply { text: string; promptTokens: number; completionTokens: number; tokensPerSecond: number | null; ms: number }

// Where llama.cpp listens unless told otherwise.
export const localServerUrl = "http://localhost:8080";

const base = (server: LlmServer) =>
  `${trimEnd(server.baseUrl.trim() || localServerUrl, "/").replace(/\/v1$/, "")}`;
const headers = (server: LlmServer) => ({
  "Content-Type": "application/json",
  ...(server.apiKey?.trim() ? { Authorization: `Bearer ${server.apiKey.trim()}` } : {}),
});

const queues = new Map<string, { active: number; waiting: (() => void)[] }>();
const slotCounts = new Map<string, Promise<number>>();

// Requests the server works on at once (llama.cpp's --parallel); more wait here.
// A server that didn't answer is asked again after a minute (it may just have been starting), not every request.
function slotCount(server: LlmServer): Promise<number> {
  const key = base(server);
  let count = slotCounts.get(key);
  if (!count) {
    count = request(server, "/props", {}, 5000).then((d) => Math.max(1, Math.min(8, Number(d?.total_slots) || 1))).catch(() => {
      setTimeout(() => slotCounts.delete(key), 60_000);
      return 1;
    });
    slotCounts.set(key, count);
  }
  return count;
}

// A finished request hands its slot straight to the next waiting one, so a new caller arriving in between can't
// take it too and run one over the limit.
async function slot<T>(server: LlmServer, work: () => Promise<T>): Promise<T> {
  const key = base(server);
  let queue = queues.get(key);
  if (!queue) queues.set(key, (queue = { active: 0, waiting: [] }));
  const q = queue;
  const limit = await slotCount(server);
  if (q.active >= limit) await new Promise<void>((resolve) => q.waiting.push(resolve));
  else q.active++;
  try {
    return await work();
  } finally {
    const next = q.waiting.shift();
    if (next) next();
    else q.active--;
  }
}

async function request(server: LlmServer, path: string, init: RequestInit = {}, timeoutMs?: number): Promise<any> {
  const signal = init.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
  let response: Response;
  try {
    response = await fetch(`${base(server)}${path}`, { ...init, headers: headers(server), signal });
  } catch (e) {
    throw new Error(`Could not reach the language model server at ${base(server)}.`, { cause: e });
  }
  if (!response.ok) throw new Error(`The language model server answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

export async function llmComplete(server: LlmServer, messages: LlmMessage[], options: LlmOptions = {}): Promise<LlmReply> {
  return slot(server, async () => {
    const body: Record<string, unknown> = {
      messages, max_tokens: options.maxTokens ?? 512, temperature: options.temperature ?? 0.3, stream: false,
    };
    if (server.model?.trim()) body.model = server.model.trim();
    if (options.schema) body.response_format = { type: "json_schema", json_schema: { name: "reply", strict: true, schema: options.schema } };
    const started = Date.now();
    const data = await request(server, "/v1/chat/completions", { method: "POST", body: JSON.stringify(body), signal: options.signal });
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("The language model server sent no text.");
    return {
      text: text.trim(),
      promptTokens: Number(data.usage?.prompt_tokens) || 0,
      completionTokens: Number(data.usage?.completion_tokens) || 0,
      tokensPerSecond: Number(data.timings?.predicted_per_second) || null,
      ms: Date.now() - started,
    };
  });
}

export async function llmJson<T>(server: LlmServer, messages: LlmMessage[], schema: Record<string, unknown>,
  options: Omit<LlmOptions, "schema"> = {}): Promise<{ value: T; reply: LlmReply }> {
  const reply = await llmComplete(server, messages, { ...options, schema });
  return { value: JSON.parse(reply.text) as T, reply };
}

// The models the server offers (llama.cpp lists the one it loaded, or the router's models).
export async function llmModels(server: LlmServer): Promise<string[]> {
  const data = await request(server, "/v1/models", {}, 8000);
  return (Array.isArray(data?.data) ? data.data : []).map((m: { id?: unknown }) => String(m.id));
}

const visionCache = new Map<string, Promise<boolean>>();

// Whether the model on the server takes pictures (llama.cpp lists input modalities when a vision projector is loaded).
export function llmSeesPictures(server: LlmServer): Promise<boolean> {
  const key = `${base(server)}|${server.model ?? ""}`;
  let known = visionCache.get(key);
  if (!known) {
    known = request(server, "/v1/models", {}, 8000).then((data) => {
      const models: { id?: string; architecture?: { input_modalities?: string[] }; capabilities?: string[] }[] = Array.isArray(data?.data) ? data.data : [];
      const model = models.find((m) => m.id === server.model) ?? models[0];
      return !!model?.architecture?.input_modalities?.includes("image");
    }).catch(() => false);
    visionCache.set(key, known);
  }
  return known;
}

// Context size per request slot, when the server says (llama.cpp's /props).
export async function llmContextSize(server: LlmServer): Promise<number | null> {
  try {
    const data = await request(server, "/props", {}, 8000);
    const size = Number(data?.default_generation_settings?.n_ctx ?? data?.n_ctx);
    return size > 0 ? size : null;
  } catch {
    return null;
  }
}
