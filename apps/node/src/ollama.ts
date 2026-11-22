import type { Turn } from "@opnav/shared";
import { object, string } from "./system.ts";
import type { System } from "./system.ts";
import type { Terminal } from "./worker.ts";

function endpoint(sys: System, path: string) {
  const host = sys.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  return new URL(path, host.includes("://") ? host : `http://${host}`);
}

export async function ollamaModels(sys: System, transport: typeof fetch, signal: AbortSignal): Promise<string[]> {
  try {
    const response = await transport(endpoint(sys, "/api/tags"), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: "error",
    });
    if (!response.ok) return [];
    const { models } = object(await response.json());
    if (!Array.isArray(models)) return [];
    return [...new Set(models.flatMap(item => {
      const name = string(object(item).model ?? object(item).name);
      return name ? [name] : [];
    }))];
  } catch {
    return [];
  }
}

export async function runOllama(sys: System, transport: typeof fetch, models: string[], turn: Turn,
  signal: AbortSignal): Promise<Terminal> {
  const model = turn.job.model ?? models[0];
  if (!model || !models.includes(model)) {
    return { type: "error", code: "provider_error", message: "The requested Ollama model is not installed.", retryable: false };
  }
  try {
    const response = await transport(endpoint(sys, "/api/chat"), {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: turn.job.prompt }] }),
    });
    if (!response.ok) throw new Error();
    const result = object(await response.json());
    const content = object(result.message).content;
    if (result.done !== true || typeof content !== "string" || !content.trim()) throw new Error();
    return { type: "result", summary: content };
  } catch {
    return signal.aborted
      ? { type: "error", code: "cancelled", message: "The turn was cancelled.", retryable: false }
      : { type: "error", code: "provider_error", message: "Ollama could not complete the request.", retryable: true };
  }
}
