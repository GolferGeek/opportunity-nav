import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { connect, migrate, type Sql } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { createToken } from "../src/auth.ts";

const url = process.env.OPNAV_TEST_DATABASE_URL;
const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

describe("Claude panel", { skip: !url && "set OPNAV_TEST_DATABASE_URL" }, () => {
  let sql: Sql;
  let app: FastifyInstance;
  let ui: string;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await app.inject({ method: method as any, url: p, headers: { authorization: `Bearer ${ui}` }, payload: body as any });
    assert.ok(r.statusCode < 300, `${method} ${p} → ${r.statusCode} ${r.body}`);
    return r.json() as any;
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      const t = await call("GET", `/api/chat/${id}`);
      if (!t.running) return t;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("chat never finished");
  };

  before(async () => {
    sql = connect(url!);
    await sql.unsafe("drop schema public cascade; create schema public;");
    await migrate(sql);
    const [u] = await sql`insert into users (name) values ('Test') returning id`;
    ui = (await createToken(sql, u!.id, "ui", "ui")).token;
    app = await buildApp({ sql, publicUrl: "http://test", webDist: "/nonexistent",
      chat: { command: fake, selfUrl: "http://127.0.0.1:1", timeoutMs: 20_000, appRepo: "github.com/x/app" } });
  });
  after(async () => { await app?.close(); await sql?.end(); });

  test("a conversation keeps its session and shows tools in plain words", async () => {
    const { threadId } = await call("POST", "/api/chat", { text: "hello" });
    const t1 = await settle(threadId);
    assert.deepEqual(t1.messages.map((m: any) => m.role), ["user", "tool", "assistant"]);
    assert.equal(t1.messages[1].text, "Added to your tree: Try it");
    assert.equal(t1.messages[2].text, "You said: hello");

    await call("POST", "/api/chat", { threadId, text: "again" });
    const t2 = await settle(threadId);
    assert.match(t2.messages.at(-1).text, /resumed fake-session-1/);
    const after = await call("GET", `/api/chat/${threadId}?after=${t1.messages.at(-1).id}`);
    assert.equal(after.messages[0].text, "again", "polling returns only new messages");

    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from api_tokens where label = 'Claude panel' and revoked_at is null`;
    const n = row!.n;
    assert.equal(n, 0, "the per-turn token is revoked");
    assert.equal((await call("GET", "/api/chat")).length, 1);
  });
});
