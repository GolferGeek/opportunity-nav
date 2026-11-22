import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sql } from "./db.ts";
import { createToken } from "./auth.ts";
import { HttpError } from "./errors.ts";
import type { AssistantConfig } from "./assistant.ts";

/**
 * The Claude panel. Each thread is a resumable Claude Code session that can
 * only use this app's own tools (over MCP, with a token that lives for one
 * turn). It talks with the person, changes their data, writes down what they
 * want to do as items in the tree, and turns requests to change the app itself
 * into jobs on the app's own project, which land on a branch for review.
 */

export interface ChatConfig extends AssistantConfig {
  /** Normalised remote of this app's own repo, so "change the app" knows where to go. */
  appRepo: string;
}

const running = new Map<string, ChildProcess>();

const TOOL_WORDS: Record<string, string> = {
  get_overview: "Looked at what's happening",
  get_tree: "Looked at your tree",
  add_item: "Added to your tree",
  update_item: "Changed an item",
  answer_question: "Answered a question",
  start_job: "Started a job",
  get_job: "Checked a job",
  cancel_job: "Stopped a job",
  clear_roadblock: "Cleared a roadblock",
  message_grok_bot: "Sent Grok Bot a message",
};

function systemPrompt(cfg: ChatConfig, scope: { id: string; path: string[] } | null) {
  return [
    "You are Claude, in a side panel inside Opportunity Nav: the person's home base for everything they're building (a tree of areas, projects and items; jobs agents run; questions and roadblocks; subscription usage).",
    scope ? `Right now they're looking at "${scope.path.join(" / ")}" (id ${scope.id}). "This", "here" and "it" mean that item unless they say otherwise.` : "Right now they're looking at everything (nothing selected).",
    "You can only act through the opportunity-nav tools. Look things up (get_tree, get_overview) before guessing ids.",
    "When they mention something they want to do, offer to record it, or just record it if they clearly asked: add it as an item (kind \"item\") under the right project, with a short title and the details in notes.",
    `When they want this app itself to look or work differently, it's the project whose repo is ${cfg.appRepo} (find it with get_tree). Talk it through until the change is clear, then start a job on that project (provider claude) with a precise, self-contained description: what to change, where in the UI, and how they'll know it's right. Tell them it will land on its own branch for them to review before it ships. Don't claim it's done until the job succeeds.`,
    "Grok Bot is Matt's CEO agent and knows a lot about his work. When something is better asked of it, or Matt says to ask it, use message_grok_bot with a clear, self-contained request. Its answer arrives later as changes in the tree, not in this chat.",
    "For real work on any other project (code, writing, research), start a job there rather than doing it yourself.",
    "Write plainly and briefly. One thought per line. No headers. Say what you did after you do it.",
  ].join("\n");
}

export async function listThreads(sql: Sql, userId: string) {
  return sql`select id, title, running, updated_at as "updatedAt" from chat_threads where user_id = ${userId} order by updated_at desc limit 30`;
}

export async function getThread(sql: Sql, userId: string, threadId: string, afterId = 0) {
  const [t] = await sql`select id, title, running, updated_at as "updatedAt" from chat_threads where id = ${threadId} and user_id = ${userId}`;
  if (!t) throw new HttpError(404, "No such conversation.");
  const messages = await sql`select id, role, text, at from chat_messages where thread_id = ${threadId} and id > ${afterId} order by id`;
  return { ...t, messages: messages.map((m) => ({ ...m, id: Number(m.id) })) };
}

export async function stopThread(sql: Sql, userId: string, threadId: string) {
  const [t] = await sql`select id from chat_threads where id = ${threadId} and user_id = ${userId}`;
  if (!t) throw new HttpError(404, "No such conversation.");
  running.get(threadId)?.kill("SIGTERM");
  return { stopping: running.has(threadId) };
}

/** Add the person's message and start Claude on it. Returns at once; the panel polls the thread. */
export async function send(sql: Sql, cfg: ChatConfig, userId: string, input: { threadId?: string; text: string; scope: { id: string; path: string[] } | null }) {
  let threadId = input.threadId;
  if (threadId) {
    const [t] = await sql`update chat_threads set running = true, updated_at = now()
      where id = ${threadId} and user_id = ${userId} and not running returning id`;
    if (!t) {
      const [exists] = await sql`select running from chat_threads where id = ${threadId} and user_id = ${userId}`;
      throw new HttpError(exists ? 409 : 404, exists ? "Claude is still answering. Wait, or stop it." : "No such conversation.");
    }
  } else {
    const title = input.text.split("\n")[0]!.slice(0, 80);
    const [t] = await sql`insert into chat_threads (user_id, title, running) values (${userId}, ${title}, true) returning id`;
    threadId = t!.id as string;
  }
  await sql`insert into chat_messages (thread_id, role, text) values (${threadId}, 'user', ${input.text})`;
  void run(sql, cfg, userId, threadId, input.text, input.scope).catch(async (e) => {
    await sql`insert into chat_messages (thread_id, role, text) values (${threadId}, 'error', ${String((e as Error).message ?? e)})`.catch(() => {});
  }).finally(async () => {
    running.delete(threadId!);
    await sql`update chat_threads set running = false, updated_at = now() where id = ${threadId}`.catch(() => {});
  });
  return { threadId };
}

async function run(sql: Sql, cfg: ChatConfig, userId: string, threadId: string, text: string, scope: { id: string; path: string[] } | null) {
  const [t] = await sql`select claude_session_id from chat_threads where id = ${threadId}`;
  const { id: tokenId, token } = await createToken(sql, userId, "agent", "Claude panel");
  const dir = await mkdtemp(path.join(tmpdir(), "opnav-chat-"));
  try {
    const mcpConfig = path.join(dir, "mcp.json");
    await writeFile(
      mcpConfig,
      JSON.stringify({ mcpServers: { opnav: { type: "http", url: `${cfg.selfUrl.replace(/\/+$/, "")}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }),
      { mode: 0o600 },
    );
    const args = [
      "-p", text,
      "--output-format", "stream-json", "--verbose",
      "--mcp-config", mcpConfig, "--strict-mcp-config",
      "--allowedTools", "mcp__opnav",
      "--append-system-prompt", systemPrompt(cfg, scope),
      "--max-turns", "30",
      ...(t?.claude_session_id ? ["--resume", t.claude_session_id] : []),
    ];
    const p = spawn(cfg.command, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    running.set(threadId, p);
    let spawnError: NodeJS.ErrnoException | null = null;
    p.on("error", (e) => (spawnError = e));
    let stderr = "";
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => p.kill("SIGTERM"), cfg.timeoutMs);
    let said = false;
    let failed: string | null = null;
    // Writes go one at a time so messages keep the order Claude produced them in.
    let chain: Promise<unknown> = Promise.resolve();
    const queue = (f: () => Promise<unknown>) => (chain = chain.then(f));
    const writes = { push: (f: () => Promise<unknown>) => queue(f) };
    const add = (role: string, body: string) => queue(() => sql`insert into chat_messages (thread_id, role, text) values (${threadId}, ${role}, ${body})`);

    for await (const line of createInterface({ input: p.stdout })) {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.session_id && ev.type === "system")
        writes.push(() => sql`update chat_threads set claude_session_id = ${ev.session_id} where id = ${threadId}`);
      if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) {
            add("assistant", c.text.trim());
            said = true;
          }
          if (c.type === "tool_use") {
            const name = String(c.name ?? "").replace(/^mcp__opnav__/, "");
            const what = c.input?.title ?? c.input?.item ?? "";
            add("tool", `${TOOL_WORDS[name] ?? name}${what ? `: ${String(what).slice(0, 80)}` : ""}`);
          }
        }
      }
      if (ev.type === "result" && (ev.is_error || (ev.subtype && ev.subtype !== "success"))) failed = String(ev.result ?? ev.subtype);
    }
    const code: number | null = await new Promise((r) => (p.exitCode !== null ? r(p.exitCode) : p.once("close", r)));
    clearTimeout(timer);
    await chain;
    if (spawnError) throw spawnError;
    if (p.signalCode === "SIGTERM" && code !== 0) add("error", "Stopped.");
    else if (failed) add("error", `Claude couldn't finish: ${failed}`);
    else if (code !== 0 && !said) add("error", `Claude stopped (${code}). ${stderr.split("\n").find((l) => l.trim()) ?? ""}`.trim());
    await chain;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Couldn't start Claude (${cfg.command}). Install Claude Code on the server or set OPNAV_ASSISTANT_CMD.`);
    throw e;
  } finally {
    await sql`update api_tokens set revoked_at = now() where id = ${tokenId}`;
    await rm(dir, { recursive: true, force: true });
  }
}
