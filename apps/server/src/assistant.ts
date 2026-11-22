import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sql } from "./db.ts";
import { createToken } from "./auth.ts";
import { HttpError } from "./errors.ts";

/**
 * "Tell it what to do." A plain-words request about whatever the person is
 * looking at, carried out by a headless agent that can only use this app's
 * own MCP tools. It gets a single-use agent token, revoked as soon as it
 * finishes. The command is configurable; Claude Code is the default.
 */

export interface AssistantConfig {
  /** Executable; default "claude". */
  command: string;
  /** Base URL the assistant reaches the server on (usually http://127.0.0.1:<port>). */
  selfUrl: string;
  timeoutMs: number;
}

export async function ask(sql: Sql, cfg: AssistantConfig, userId: string, text: string, scope: { id: string; path: string[] } | null) {
  const { id: tokenId, token } = await createToken(sql, userId, "agent", "Ask bar");
  const dir = await mkdtemp(path.join(tmpdir(), "opnav-ask-"));
  try {
    const mcpConfig = path.join(dir, "mcp.json");
    await writeFile(
      mcpConfig,
      JSON.stringify({ mcpServers: { opnav: { type: "http", url: `${cfg.selfUrl.replace(/\/+$/, "")}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }),
      { mode: 0o600 },
    );
    const where = scope ? `They are looking at "${scope.path.join(" / ")}" (id ${scope.id}). "This", "here" and "it" mean that item.` : "They are looking at everything (no item selected).";
    const system = [
      "You are the assistant inside Opportunity Nav, the person's home base for everything they're building.",
      where,
      "Do what they ask using only the opportunity-nav tools. Look things up with get_tree or get_overview before guessing ids.",
      "If they ask for real work on a project (code, writing, research), start a job with start_job rather than doing it yourself.",
      "Reply in one or two short plain sentences saying what you did. If you couldn't, say why in plain words.",
    ].join("\n");
    const args = [
      "-p", text,
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      "--allowedTools", "mcp__opnav",
      "--append-system-prompt", system,
      "--output-format", "json",
      "--max-turns", "12",
    ];
    const out = await run(cfg.command, args, dir, cfg.timeoutMs);
    let reply = out.stdout.trim();
    try {
      const j = JSON.parse(reply);
      if (j.is_error) throw new HttpError(502, `The assistant couldn't finish: ${j.result ?? j.subtype ?? "unknown error"}`);
      reply = String(j.result ?? "").trim();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (out.code !== 0) throw new HttpError(502, `The assistant stopped (${out.code}). ${out.stderr.split("\n").find((l) => l.trim()) ?? ""}`.trim());
    }
    return { reply: reply || "Done." };
  } finally {
    await sql`update api_tokens set revoked_at = now() where id = ${tokenId}`;
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.on("error", (e) => {
      clearTimeout(t);
      reject(new HttpError(503, `Couldn't start the assistant (${cmd}): ${e.message}. Install it on the server or set OPNAV_ASSISTANT_CMD.`));
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
