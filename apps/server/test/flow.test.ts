/**
 * End-to-end server flow against a real Postgres. Set OPNAV_TEST_DATABASE_URL
 * (a throwaway database: it is wiped). Skipped when unset.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { connect, migrate, type Sql } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { createToken } from "../src/auth.ts";
import { expireLeases } from "../src/services/jobs.ts";

const url = process.env.OPNAV_TEST_DATABASE_URL;
const key = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

describe("server flow", { skip: !url && "set OPNAV_TEST_DATABASE_URL" }, () => {
  let sql: Sql;
  let app: FastifyInstance;
  let ui: string, node: string, agent: string, node2: string;

  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await app.inject({ method: method as any, url: path, headers: { authorization: `Bearer ${token}` }, payload: body as any });
    return { status: r.statusCode, body: r.json() as any };
  };
  const ok = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await call(token, method, path, body);
    assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  before(async () => {
    sql = connect(url!);
    await sql.unsafe("drop schema public cascade; create schema public;");
    await migrate(sql);
    const [u] = await sql`insert into users (name) values ('Test') returning id`;
    ui = (await createToken(sql, u!.id, "ui", "test ui")).token;
    node = (await createToken(sql, u!.id, "node", "laptop")).token;
    node2 = (await createToken(sql, u!.id, "node", "studio")).token;
    agent = (await createToken(sql, u!.id, "agent", "grok bot")).token;
    app = await buildApp({ sql, publicUrl: "http://test", webDist: "/nonexistent" });
  });
  after(async () => {
    await app?.close();
    await sql?.end();
  });

  const hb = (name: string) => ({
    hostname: name, platform: "linux", arch: "arm64", helperVersion: "0.1.0",
    providers: [{ provider: "claude", signedIn: true, canRunJobs: true, locations: ["cloud"], models: [] }],
    checkouts: [{ path: `/home/${name}/Projects/opportunity-nav`, remote: "git@github.com:GolferGeek/opportunity-nav.git" }],
  });

  let projectId: string;
  test("tree: area, project, favorite, order", async () => {
    const area = await ok(ui, "POST", "/api/tree", { kind: "area", title: "Golfer Geek" });
    const p = await ok(ui, "POST", "/api/tree", { kind: "project", title: "Opportunity Nav", parentId: area.id, repoRemote: "https://github.com/GolferGeek/opportunity-nav", defaultProvider: "claude" });
    const first = await ok(ui, "POST", "/api/tree", { kind: "project", title: "First", parentId: area.id, beforeId: p.id });
    await ok(ui, "PATCH", `/api/tree/${p.id}`, { favorite: true });
    const tree = await ok(ui, "GET", "/api/tree");
    assert.deepEqual(tree.map((n: any) => n.title), ["Golfer Geek", "First", "Opportunity Nav"]);
    assert.equal(tree[2].repoRemote, "github.com/golfergeek/opportunity-nav");
    assert.equal(tree[2].favorite, true);
    const bad = await call(ui, "PATCH", `/api/tree/${area.id}`, { parentId: first.id });
    assert.equal(bad.status, 400, "no cycles");
    projectId = p.id;
  });

  test("roles are enforced", async () => {
    assert.equal((await call(node, "GET", "/api/tree")).status, 403);
    assert.equal((await call(ui, "POST", "/api/node/heartbeat", hb("x"))).status, 403);
    assert.equal((await call("opn_ui_nope", "GET", "/api/tree")).status, 401);
  });

  test("job: start → question → answer → resume → done", async () => {
    await ok(node, "POST", "/api/node/heartbeat", hb("laptop"));
    const job = await ok(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "Add a healthz route" });
    assert.equal(job.provider, "claude");

    const { turns } = await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] });
    assert.equal(turns.length, 1);
    const t = turns[0];
    assert.equal(t.kind, "start");
    assert.equal(t.job.checkoutPath, "/home/laptop/Projects/opportunity-nav");
    assert.equal((await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns.length, 0, "not handed out twice");

    const ev = (seq: number, e: object) => ({ seq, at: now(), ...e });
    await ok(node, "POST", `/api/node/jobs/${job.id}/events`, { leaseId: t.leaseId, events: [ev(0, { type: "session", providerSessionId: "sess-1" }), ev(1, { type: "progress", text: "Reading the server" })] });
    // A retried batch is ignored.
    const again = await ok(node, "POST", `/api/node/jobs/${job.id}/events`, { leaseId: t.leaseId, events: [ev(1, { type: "progress", text: "dup" })] });
    assert.equal(again.lastSeq, 1);
    await ok(node, "POST", `/api/node/jobs/${job.id}/events`, { leaseId: t.leaseId, events: [ev(2, { type: "needs_input", needsInput: { question: "Port 4317 or 8080?", options: ["4317", "8080"] } })] });

    const h = await ok(ui, "GET", "/api/happening");
    const q = h[0].items.find((i: any) => i.kind === "question");
    assert.equal(q.title, "Port 4317 or 8080?");
    assert.deepEqual(h[0].path, ["Golfer Geek", "Opportunity Nav"]);
    assert.equal((await call(node, "POST", `/api/node/jobs/${job.id}/lease`, { leaseId: t.leaseId })).status, 409, "turn ended");

    const a1 = await ok(ui, "POST", `/api/questions/${q.id}/answer`, { answer: "4317" });
    const a2 = await ok(ui, "POST", `/api/questions/${q.id}/answer`, { answer: "8080" });
    assert.equal(a2.alreadyAnswered, true);
    assert.equal(a2.answerId, a1.answerId);

    // Another machine can't take the continuation: it's pinned to where the session lives.
    await ok(node2, "POST", "/api/node/heartbeat", hb("studio"));
    assert.equal((await ok(node2, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns.length, 0);

    const c = (await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns;
    assert.equal(c.length, 1, "exactly one continuation");
    assert.equal(c[0].kind, "continue");
    assert.equal(c[0].providerSessionId, "sess-1");
    assert.equal(c[0].answer.text, "4317");
    await ok(node, "POST", `/api/node/jobs/${job.id}/events`, { leaseId: c[0].leaseId, events: [ev(0, { type: "result", summary: "Added /healthz on 4317" })] });

    const done = await ok(ui, "GET", `/api/jobs/${job.id}`);
    assert.equal(done.status, "succeeded");
    assert.equal(done.questions[0].answer, "4317");
    const dash = await ok(ui, "GET", "/api/dashboard");
    assert.match(dash.projects.find((p: any) => p.id === projectId).line, /Last done: Added \/healthz/);
  });

  test("lost lease requeues to any machine; cancel stops it", async () => {
    const job = await ok(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "Long thing" });
    const [t] = (await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns;
    await sql`update turns set lease_expires_at = now() - interval '1 second' where id = ${t.turnId}`;
    assert.equal(await expireLeases(sql), 1);
    const [t2] = (await ok(node2, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns;
    assert.equal(t2.job.id, job.id, "the other machine picked it up");
    assert.equal(t2.job.checkoutPath, "/home/studio/Projects/opportunity-nav");
    assert.equal((await ok(ui, "POST", `/api/jobs/${job.id}/cancel`)).status, "cancelling");
    assert.equal((await ok(node2, "POST", `/api/node/jobs/${job.id}/lease`, { leaseId: t2.leaseId })).cancel, true);
    await ok(node2, "POST", `/api/node/jobs/${job.id}/events`, { leaseId: t2.leaseId, events: [{ seq: 0, at: now(), type: "error", code: "cancelled", message: "Stopped" }] });
    assert.equal((await ok(ui, "GET", `/api/jobs/${job.id}`)).status, "cancelled");
  });

  test("cloudroom jobs go only to a machine that has Cloudroom for that agent", async () => {
    const bad = await call(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "x", provider: "ollama", runner: "cloudroom" });
    assert.equal(bad.status, 400);
    const job = await ok(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "Try it in the cloud", runner: "cloudroom" });
    assert.equal(job.runner, "cloudroom");
    assert.equal(job.cloudroom.branch, `opnav/${job.id.slice(0, 8)}`);
    // A plain claude claim doesn't take it.
    assert.equal((await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns.length, 0);
    await ok(node2, "POST", "/api/node/heartbeat", { ...hb("studio"), cloudroom: { providers: ["claude", "codex"] } });
    const machines = await ok(ui, "GET", "/api/machines");
    assert.deepEqual(machines.find((m: any) => m.name === "studio").cloudroom.providers, ["claude", "codex"]);
    const [t] = (await ok(node2, "POST", "/api/node/jobs/claim", { providers: ["claude"], cloudroomProviders: ["claude"] })).turns;
    assert.equal(t.job.id, job.id);
    assert.equal(t.job.runner, "cloudroom");
    await ok(node2, "POST", `/api/node/jobs/${job.id}/events`, { leaseId: t.leaseId, events: [
      { seq: 0, at: now(), type: "session", providerSessionId: "thr_test1" },
      { seq: 1, at: now(), type: "result", summary: "Pushed opnav branch" }] });
    const done = await ok(ui, "GET", `/api/jobs/${job.id}`);
    assert.equal(done.status, "succeeded");
    assert.equal(done.cloudroom.thread, "thr_test1");
  });

  test("usage: deduped by account; a failure never wipes a good reading", async () => {
    const acct = key("claude-account-123");
    const good = {
      observedAt: now(),
      accounts: [{ provider: "claude", accountKey: acct, plan: "Max 20x", status: "ok", fetchedAt: now(),
        windows: [{ id: "seven_day", label: "Weekly", kind: "weekly", unit: "percent", used: 9, resetsAt: new Date(Date.now() + 86400e3).toISOString() }] }],
    };
    await ok(node, "POST", "/api/node/usage", good);
    await ok(node2, "POST", "/api/node/usage", { observedAt: now(), accounts: [{ provider: "claude", accountKey: acct, status: "auth_required", message: "Sign in again", windows: [] }] });
    const d = await ok(ui, "GET", "/api/dashboard");
    assert.equal(d.subscriptions.length, 1);
    assert.equal(d.subscriptions[0].status, "ok", "laptop's fresh reading wins");
    assert.equal(d.subscriptions[0].windows[0].percent, 9);
    await ok(ui, "PATCH", `/api/subscriptions/${d.subscriptions[0].id}`, { monthlyCostUsd: 200 });
    assert.equal((await ok(ui, "GET", "/api/dashboard")).totalMonthlyUsd, 200);
  });

  test("check now: online machines read usage at their next heartbeat, once", async () => {
    const r = await ok(ui, "POST", "/api/usage/check");
    assert.ok(r.machines >= 1);
    assert.equal((await ok(node, "POST", "/api/node/heartbeat", hb("laptop"))).checkUsageNow, true);
    assert.equal((await ok(node, "POST", "/api/node/heartbeat", hb("laptop"))).checkUsageNow, false);
    assert.equal((await call(node, "POST", "/api/usage/check")).status, 403);
  });

  test("handoff work shows under its project, with its questions", async () => {
    await ok(node2, "POST", "/api/node/external", {
      items: [{ source: "handoff", externalId: "2026-11-22-x.md", title: "Fix login", status: "running", repo: "/home/studio/Projects/opportunity-nav", questions: ["Ship it?"], updatedAt: now() }],
      complete: ["handoff"],
    });
    const h = await ok(ui, "GET", "/api/happening");
    const g = h.find((x: any) => x.projectId === projectId);
    assert.ok(g.items.some((i: any) => i.kind === "external" && i.title === "Fix login"));
    assert.ok(g.items.some((i: any) => i.kind === "question" && i.title === "Ship it?"));
    await ok(node2, "POST", "/api/node/external", { items: [], complete: ["handoff"] });
    const h2 = await ok(ui, "GET", "/api/happening");
    assert.ok(!h2.flatMap((x: any) => x.items).some((i: any) => i.title === "Fix login" || i.title === "Ship it?"), "gone when the file is gone");
  });

  test("A2A: card is public; agents act by data part or title path", async () => {
    const card = (await app.inject({ url: "/.well-known/agent-card.json" })).json();
    assert.equal(card.url, "http://test/a2a");
    assert.ok(card.skills.some((s: any) => s.id === "start_job"));
    const rpc = (data: any) => ok(agent, "POST", "/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", parts: [{ kind: "data", data }] } } });
    const r = await rpc({ action: "add_item", input: { parent: "golfer geek / opportunity nav", kind: "item", title: "Voice control" } });
    assert.equal(r.result.parts[0].data.result.title, "Voice control");
    const bad = await rpc({ action: "add_item", input: { parent: "Nope", kind: "item", title: "x" } });
    assert.match(bad.error.message, /Nothing in the tree is called "Nope"/);
    assert.equal((await call(node, "POST", "/a2a", {})).status, 403);
  });

  test("MCP: lists the same tools", async () => {
    const r = await app.inject({
      method: "POST", url: "/mcp",
      headers: { authorization: `Bearer ${agent}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    assert.equal(r.statusCode, 200, r.body);
    const names = r.json().result.tools.map((t: any) => t.name);
    assert.ok(names.includes("get_overview") && names.includes("answer_question"));
  });
});
