import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Sql } from "./db.ts";
import type { Principal } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { actions, runAction } from "./services/actions.ts";

/**
 * A2A (JSON-RPC 2.0 over HTTP). Agents send `message/send` with either:
 *   - a data part: { "action": "<skill id>", "input": { ... } }   ← preferred; exact
 *   - a text part: "overview" / "tree" / "help"                    ← quick looks
 * The reply is a Message with a data part (the result) and a short text part.
 */

export function agentCard(publicUrl: string) {
  const base = publicUrl.replace(/\/+$/, "");
  return {
    protocolVersion: "0.3.0",
    name: "Opportunity Nav",
    description:
      "One person's home base for everything they're building: a tree of areas and projects, what's in flight, questions waiting on them, roadblocks, and subscription usage. Read it, add to it, answer questions, start agent jobs.",
    url: `${base}/a2a`,
    preferredTransport: "JSONRPC",
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "An agent token created in Opportunity Nav → Settings → Agents." } },
    security: [{ bearer: [] }],
    additionalInterfaces: [{ url: `${base}/mcp`, transport: "MCP-streamable-http" }],
    skills: Object.entries(actions).map(([id, a]) => ({
      id,
      name: id.replace(/_/g, " "),
      description: `${a.description} Send a data part {"action":"${id}","input":{...}}. Input schema: ${JSON.stringify(zodToJsonSchema(a.input, { $refStrategy: "none" }))}`,
      tags: ["opportunity-nav"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    })),
  };
}

type Part = { kind: "text"; text: string } | { kind: "data"; data: any };

export async function handleA2A(sql: Sql, who: Principal, body: any) {
  const id = body?.id ?? null;
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (body?.jsonrpc !== "2.0" || typeof body?.method !== "string") return fail(-32600, "Expected a JSON-RPC 2.0 request.");
  if (body.method !== "message/send") return fail(-32601, `Method ${body.method} isn't supported. Use message/send.`);
  const msg = body.params?.message;
  const parts: Part[] = Array.isArray(msg?.parts) ? msg.parts : [];
  const by = `agent:${who.label}`;

  const reply = (out: Part[]) => ({
    jsonrpc: "2.0",
    id,
    result: { kind: "message", role: "agent", messageId: randomUUID(), contextId: msg?.contextId, parts: out },
  });

  try {
    const data = parts.find((p): p is Extract<Part, { kind: "data" }> => p.kind === "data")?.data;
    if (data?.action) {
      const result = await runAction(sql, who.userId, data.action, data.input, by);
      return reply([{ kind: "data", data: { action: data.action, result } }, { kind: "text", text: `Done: ${data.action}.` }]);
    }
    const text = parts.filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text").map((p) => p.text).join(" ").trim().toLowerCase();
    if (/^(overview|status|what'?s happening)\b/.test(text)) {
      const result = await runAction(sql, who.userId, "get_overview", {}, by);
      return reply([{ kind: "data", data: { action: "get_overview", result } }, { kind: "text", text: summarise(result) }]);
    }
    if (/^tree\b/.test(text)) {
      const result = await runAction(sql, who.userId, "get_tree", {}, by);
      return reply([{ kind: "data", data: { action: "get_tree", result } }]);
    }
    return reply([
      {
        kind: "text",
        text: `Send a data part {"action": "...", "input": {...}}. Actions: ${Object.keys(actions).join(", ")}. The agent card lists each input. Text "overview" or "tree" also works.`,
      },
    ]);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status === 404 ? -32001 : -32602, e.message);
    throw e;
  }
}

function summarise(o: any): string {
  const lines: string[] = [];
  for (const g of o.happening ?? []) {
    lines.push(g.path.join(" / "));
    for (const it of g.items) lines.push(`  ${it.kind === "question" ? "?" : it.kind === "roadblock" ? "!" : "•"} ${it.title.split("\n")[0]}`);
  }
  return lines.length ? lines.join("\n") : "Nothing needs you right now.";
}
