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
import { mergeSubscriptions } from "../src/services/machines.ts";

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

  test("priority sorts projects; favorites reorder by drag", async () => {
    const area = await ok(ui, "POST", "/api/tree", { kind: "area", title: "Priority area" });
    const a = await ok(ui, "POST", "/api/tree", { kind: "project", title: "PA", parentId: area.id });
    const b = await ok(ui, "POST", "/api/tree", { kind: "project", title: "PB", parentId: area.id });
    const c = await ok(ui, "POST", "/api/tree", { kind: "project", title: "PC", parentId: area.id });
    assert.equal(a.priority, "medium", "default");
    await ok(ui, "PATCH", `/api/tree/${c.id}`, { priority: "high" });
    await ok(ui, "PATCH", `/api/tree/${a.id}`, { priority: "low" });
    const bad = await call(ui, "PATCH", `/api/tree/${a.id}`, { priority: "urgent" });
    assert.equal(bad.status, 400);
    let tree = await ok(ui, "GET", "/api/tree");
    assert.deepEqual(tree.filter((n: any) => n.parentId === area.id).map((n: any) => n.title), ["PC", "PB", "PA"]);
    const dash = await ok(ui, "GET", "/api/dashboard");
    const names = dash.projects.map((p: any) => p.path.at(-1));
    assert.equal(names[0], "PC", "high first on the dashboard");
    assert.equal(names.at(-1), "PA", "low last");

    const favs = async () => (await ok(ui, "GET", "/api/tree")).filter((n: any) => n.favorite)
      .sort((x: any, y: any) => x.favoritePosition - y.favoritePosition).map((n: any) => n.title);
    for (const n of [a, b, c]) await ok(ui, "PATCH", `/api/tree/${n.id}`, { favorite: true });
    const before = (await favs()).filter((t: string) => !["PA", "PB", "PC"].includes(t));
    assert.deepEqual((await favs()).slice(-3), ["PA", "PB", "PC"]);
    await ok(ui, "PATCH", `/api/tree/${c.id}`, { favoriteBeforeId: a.id }); // drag PC above PA
    assert.deepEqual((await favs()).slice(-3), ["PC", "PA", "PB"]);
    await ok(ui, "PATCH", `/api/tree/${c.id}`, { favoriteBeforeId: null }); // drag PC to the bottom
    assert.deepEqual((await favs()).slice(-3), ["PA", "PB", "PC"]);
    assert.deepEqual((await favs()).slice(0, -3), before, "other favorites keep their order");
    const notFav = await call(ui, "PATCH", `/api/tree/${area.id}`, { favoriteBeforeId: a.id });
    assert.equal(notFav.status, 400, "only a favorite can be reordered");

    for (const n of [a, b, c, area]) await ok(ui, "PATCH", `/api/tree/${n.id}`, { archived: true, favorite: false });
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

  test("a refused tool is logged on the job; only a job that fails opens a roadblock", async () => {
    const ev = (seq: number, e: object) => ({ seq, at: now(), ...e });
    const run = async (prompt: string) => {
      const job = await ok(ui, "POST", "/api/jobs", { nodeId: projectId, prompt });
      const [t] = (await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns;
      assert.equal(t.job.id, job.id);
      return { job, t };
    };
    const open = async (jobId: string) => (await sql`select body from roadblocks where job_id = ${jobId} and status = 'open'`).map((r) => r.body);

    // Refused one tool, finished another way: nothing for the person to do.
    const a = await run("Refused a tool, then succeeded");
    await ok(node, "POST", `/api/node/jobs/${a.job.id}/events`, { leaseId: a.t.leaseId, events: [
      ev(0, { type: "progress", text: "Working" }), ev(1, { type: "blocked", text: "Claude could not get permission to run WebFetch." })] });
    assert.deepEqual(await open(a.job.id), [], "a refusal alone is not a roadblock");
    const [u] = await sql`select user_id from jobs where id = ${a.job.id}`;
    await sql`insert into roadblocks (user_id, project_id, job_id, body) values (${u!.user_id}, ${projectId}, ${a.job.id}, 'Opened earlier')`;
    await ok(node, "POST", `/api/node/jobs/${a.job.id}/events`, { leaseId: a.t.leaseId, events: [
      ev(2, { type: "result", summary: "Done another way" })] });
    assert.deepEqual(await open(a.job.id), [], "success clears the job's roadblocks");
    const detail = await ok(ui, "GET", `/api/jobs/${a.job.id}`);
    assert.equal(detail.status, "succeeded");
    assert.ok(JSON.stringify(detail).includes("permission to run WebFetch"), "the refusal stays on the job's log");
    assert.ok(!(await ok(ui, "GET", "/api/happening")).some((g: any) => g.items.some((i: any) => i.kind === "roadblock" && i.jobId === a.job.id)));

    // Refused a tool and then failed: a roadblock with the real reason.
    const b = await run("Refused a tool, then failed");
    await ok(node, "POST", `/api/node/jobs/${b.job.id}/events`, { leaseId: b.t.leaseId, events: [
      ev(0, { type: "blocked", text: "Claude could not get permission to run Bash." }),
      ev(1, { type: "error", code: "provider_error", message: "Tests still fail.", retryable: false })] });
    assert.equal((await ok(ui, "GET", `/api/jobs/${b.job.id}`)).status, "failed");
    assert.deepEqual(await open(b.job.id), ["Tests still fail.\nClaude could not get permission to run Bash."]);
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

  test("needs and location: a job that needs Docker or a database only goes to a machine that has them", async () => {
    // "local" means a model on the machine; Antigravity has none, so say so rather than queue a job that fails.
    const local = await call(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "Review", provider: "agy", location: "local" });
    assert.equal(local.status, 400);
    assert.match(local.body.error, /Antigravity runs its models in the cloud/);
    assert.equal((await call(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "x", provider: "ollama", location: "local" })).status, 200);
    await sql`update jobs set status = 'cancelled' where provider = 'ollama'`;
    await sql`update turns set status = 'cancelled' where job_id in (select id from jobs where provider = 'ollama')`;

    const job = await ok(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "Run the server tests", needs: ["database"] });
    assert.deepEqual(job.needs, ["database"]);
    await ok(node, "POST", "/api/node/heartbeat", hb("laptop")); // no tools
    assert.equal((await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns.length, 0, "the laptop has no database");
    await ok(node2, "POST", "/api/node/heartbeat", { ...hb("studio"), tools: ["docker", "database"] });
    const [t] = (await ok(node2, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns;
    assert.equal(t.job.id, job.id);
    const seen = await ok(ui, "GET", `/api/jobs/${job.id}`);
    assert.equal(seen.machine, "studio", "the job says which machine runs it");
    await ok(node2, "POST", `/api/node/jobs/${job.id}/events`, { leaseId: t.leaseId, events: [{ seq: 0, at: now(), type: "result", summary: "ok" }] });

    // A project default applies when the job doesn't say.
    await ok(ui, "PATCH", `/api/tree/${projectId}`, { defaultNeeds: ["docker"] });
    const d = await ok(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "Build the image" });
    assert.deepEqual(d.needs, ["docker"]);
    assert.equal((await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns.length, 0);
    const plain = await ok(ui, "POST", "/api/jobs", { nodeId: projectId, prompt: "Edit the README", needs: [] });
    assert.equal((await ok(node, "POST", "/api/node/jobs/claim", { providers: ["claude"] })).turns[0].job.id, plain.id, "a job that needs nothing goes anywhere");
    await ok(ui, "PATCH", `/api/tree/${projectId}`, { defaultNeeds: [] });
    for (const j of [d, plain]) await ok(ui, "POST", `/api/jobs/${j.id}/cancel`);
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

  test("usage: one card per account, even when older helpers keyed it per machine", async () => {
    const studioOld = key("studio-refresh"), laptopOld = key("laptop-refresh"), stable = key("person@example.com");
    const weekly = (used: number) => [{ id: "weekly", label: "Weekly", kind: "weekly", unit: "percent", used }];
    const report = (accountKey: string, status: string, used: number, extra: object = {}) => ({ observedAt: now(),
      accounts: [{ provider: "agy", accountKey, plan: "Google AI Ultra", status, fetchedAt: status === "ok" ? now() : new Date(Date.now() - 3600e3).toISOString(), windows: weekly(used), ...extra }] });
    const cards = async () => (await ok(ui, "GET", "/api/dashboard")).subscriptions.filter((s: any) => s.provider === "agy");

    // Old helpers: two machines, two keys, two cards.
    await ok(node2, "POST", "/api/node/usage", report(studioOld, "stale", 10));
    await ok(node, "POST", "/api/node/usage", report(laptopOld, "ok", 20));
    assert.equal((await cards()).length, 2);
    await ok(ui, "PATCH", `/api/subscriptions/${(await cards()).find((c: any) => c.status === "stale").id}`, { monthlyCostUsd: 250 });

    // The Studio's new helper reports the stable key and its old one: that card carries on under the new key.
    await ok(node2, "POST", "/api/node/usage", report(stable, "stale", 10, { aliases: [studioOld] }));
    assert.equal((await cards()).length, 2);
    // Fold the laptop's old card in by hand (what `opnav-admin merge-usage` does).
    const [survivor] = await sql`select id, user_id from subscriptions where provider = 'agy' and account_key = ${stable}`;
    const [dup] = await sql`select id from subscriptions where provider = 'agy' and account_key = ${laptopOld}`;
    await sql.begin((tx) => mergeSubscriptions(tx, survivor!.user_id, dup!.id, survivor!.id));
    let c = await cards();
    assert.equal(c.length, 1, "one card");
    assert.equal(c[0].status, "ok", "the freshest good reading wins");
    assert.equal(c[0].windows[0].percent, 20);
    assert.equal(c[0].monthlyCostUsd, 250, "cost carries over");

    // The laptop's old helper still reports under its old key: it lands on the same card.
    await ok(node, "POST", "/api/node/usage", report(laptopOld, "ok", 30));
    c = await cards();
    assert.equal(c.length, 1);
    assert.equal(c[0].windows[0].percent, 30);
    // A stale report from the other machine doesn't hide a fresh one.
    await ok(node2, "POST", "/api/node/usage", report(stable, "stale", 10, { aliases: [studioOld] }));
    c = await cards();
    assert.equal(c[0].status, "ok");
    assert.equal(c[0].windows[0].percent, 30);
    const [kept] = await sql`select hidden, merged_into from subscriptions where id = ${dup!.id}`;
    assert.deepEqual([kept!.hidden, kept!.merged_into], [true, survivor!.id], "old card is hidden, not deleted");
    // Each machine's own reports of the account are kept, and follow it when it's folded.
    const src = await sql`select n.name, u.status from usage_sources u join nodes n on n.id = u.node_id where u.subscription_id = ${survivor!.id} order by n.name`;
    assert.deepEqual(src.map((r) => [r.name, r.status]), [["laptop", "ok"], ["studio", "stale"]]);
    assert.equal((await sql`select count(*)::int as n from usage_sources where subscription_id = ${dup!.id}`)[0]!.n, 0);
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
    const ms = (await rpc({ action: "list_machines", input: {} })).result.parts[0].data.result;
    assert.deepEqual(ms.find((m: any) => m.name === "studio").tools, ["docker", "database"]);
    const pinned = (await rpc({ action: "start_job", input: { item: "golfer geek / opportunity nav", prompt: "On the studio", machine: "Studio" } })).result.parts[0].data.result;
    const [row] = await sql`select n.name from jobs j join nodes n on n.id = j.node_id where j.id = ${pinned.id}`;
    assert.equal(row!.name, "studio");
    await ok(ui, "POST", `/api/jobs/${pinned.id}/cancel`);

    // A handoff brief names its project by repo, and can ask for the work to be pushed.
    const byRepo = (await rpc({ action: "start_job", input: { repo: "git@github.com:golfergeek/opportunity-nav.git", prompt: "From a brief", machine: "studio", push: true } })).result.parts[0].data.result;
    assert.equal(byRepo.projectId, projectId);
    assert.equal(byRepo.push, true);
    const claimed = await ok(node2, "POST", "/api/node/jobs/claim", { providers: ["claude"], max: 5 });
    assert.equal(claimed.turns.find((t: any) => t.job.id === byRepo.id)?.job.push, true);
    await sql`update turns set status = 'expired', lease_id = null where job_id = ${byRepo.id}`;
    await sql`update jobs set status = 'cancelled' where id = ${byRepo.id}`;
    const plain = (await rpc({ action: "start_job", input: { repo: "https://github.com/GolferGeek/opportunity-nav", prompt: "No push" } })).result.parts[0].data.result;
    assert.equal(plain.push, false);
    await ok(ui, "POST", `/api/jobs/${plain.id}/cancel`);
    assert.match((await rpc({ action: "start_job", input: { repo: "github.com/nobody/nothing", prompt: "x" } })).error.message, /No project has the repo github.com\/nobody\/nothing/);
    assert.match((await rpc({ action: "start_job", input: { prompt: "x" } })).error.message, /Name the project: item or repo/);
  });

  test("start_review: Antigravity or Codex, whichever has more usage left and can run", async () => {
    const rpc = async (input: any) => (await ok(agent, "POST", "/a2a", { jsonrpc: "2.0", id: 1, method: "message/send",
      params: { message: { role: "user", messageId: "m2", parts: [{ kind: "data", data: { action: "start_review", input } }] } } }));
    const review = async (input: object = {}) => {
      const r = await rpc({ item: "golfer geek / opportunity nav", prompt: "Review the branch", ...input });
      if (r.error) return { error: r.error.message as string };
      const job = r.result.parts[0].data.result;
      await ok(ui, "POST", `/api/jobs/${job.id}/cancel`);
      return job;
    };
    // Earlier tests leave a job running on the laptop; a busy machine can't take a review, so end it.
    await sql`update turns set status = 'expired', lease_id = null where status = 'running'`;
    const can = (provider: string, canRunJobs = true) => ({ provider, signedIn: true, canRunJobs, locations: ["cloud"], models: [] });
    await ok(node, "POST", "/api/node/heartbeat", { ...hb("laptop"), providers: [can("agy"), can("codex")] });
    await ok(node2, "POST", "/api/node/heartbeat", { ...hb("studio"), providers: [can("codex")], tools: ["docker", "database"] });
    await sql`update subscriptions set hidden = true where provider in ('agy', 'codex')`;
    const week = new Date(Date.now() + 5 * 86400e3).toISOString();
    const usage = (agyUsed: number, codex: object[]) => ok(node, "POST", "/api/node/usage", { observedAt: now(), accounts: [
      { provider: "agy", accountKey: key("review-agy"), status: "ok", fetchedAt: now(),
        windows: [{ id: "3p-weekly", label: "Weekly", kind: "weekly", unit: "percent", used: agyUsed, resetsAt: week }] },
      { provider: "codex", accountKey: key("review-codex"), status: "ok", fetchedAt: now(), windows: codex }] });
    const codexWeekly = (used: number, resetsAt = week) => [
      { id: "codex:primary", label: "5-hour", kind: "session", unit: "percent", used: 10 },
      { id: "codex:secondary", label: "Weekly", kind: "weekly", unit: "percent", used, resetsAt }];

    await usage(30, codexWeekly(60));
    let r = await review();
    assert.equal(r.provider, "agy", "70% left beats Codex's tightest window, 40%");
    assert.equal(r.picked.why, "Antigravity has 70% left. Codex has 40% left.");

    await new Promise((res) => setTimeout(res, 5));
    await usage(90, codexWeekly(60));
    assert.equal((await review()).provider, "codex");

    await new Promise((res) => setTimeout(res, 5));
    await usage(90, codexWeekly(100, new Date(Date.now() - 1000).toISOString()));
    assert.equal((await review()).picked.why, "Codex has 90% left. Antigravity has 10% left.", "a window past its reset is back to unused");

    // Antigravity has more left but no machine can run it: Codex goes.
    await new Promise((res) => setTimeout(res, 5));
    await usage(10, codexWeekly(60));
    await ok(node, "POST", "/api/node/heartbeat", { ...hb("laptop"), providers: [can("agy", false), can("codex")] });
    r = await review();
    assert.equal(r.provider, "codex");
    assert.match(r.picked.why, /Antigravity can't run: no online machine can run it/);
    await ok(node, "POST", "/api/node/heartbeat", { ...hb("laptop"), providers: [can("agy"), can("codex")] });

    // Needs a database: only the studio has one, and it only runs Codex.
    assert.equal((await review({ needs: ["database"] })).provider, "codex");
    const none = await review({ among: ["agy"], needs: ["database"] });
    assert.match(none.error, /No reviewer can run right now. Antigravity: no machine that runs it has database/);

    // 0% left: never picked. Antigravity is empty, so Codex goes even with less left elsewhere; both empty: refused.
    await new Promise((res) => setTimeout(res, 5));
    await usage(100, codexWeekly(95));
    r = await review();
    assert.equal(r.provider, "codex");
    assert.match(r.picked.why, /Antigravity can't run: no usage left/);
    await new Promise((res) => setTimeout(res, 5));
    await usage(100, codexWeekly(100));
    const both = await review();
    assert.equal(both.error, "No reviewer can run right now. Antigravity: no usage left. Codex: no usage left.");
    assert.match((await review({ among: ["codex"] })).error, /Codex: no usage left/);

    // A review doesn't inherit a model meant for the project's default agent.
    await new Promise((res) => setTimeout(res, 5));
    await usage(20, codexWeekly(10));
    const [proj] = await sql`select id, default_provider, default_model from tree_nodes where kind = 'project' and title ilike 'opportunity nav' limit 1`;
    await sql`update tree_nodes set default_provider = 'claude', default_model = 'claude-opus-5-5' where id = ${proj!.id}`;
    r = await review();
    assert.equal(r.provider, "codex");
    assert.equal(r.model, null);
    await sql`update tree_nodes set default_provider = ${proj!.default_provider}, default_model = ${proj!.default_model} where id = ${proj!.id}`;
    await sql`update subscriptions set hidden = true where provider in ('agy', 'codex')`;
  });

  test("start_review: the picked agent is what runs; busy machines, readings that aren't current, two accounts, a missing repo", async () => {
    const start = async (input: object = {}, item = "golfer geek / opportunity nav") => {
      const r = await ok(agent, "POST", "/a2a", { jsonrpc: "2.0", id: 1, method: "message/send",
        params: { message: { role: "user", messageId: "m3", parts: [{ kind: "data", data: { action: "start_review", input: { item, prompt: "Review the branch", ...input } } }] } } });
      return r.error ? { error: r.error.message as string } : r.result.parts[0].data.result;
    };
    const review = async (input: object = {}) => {
      const job = await start(input);
      if (!job.error) await ok(ui, "POST", `/api/jobs/${job.id}/cancel`);
      return job;
    };
    await sql`update turns set status = 'cancelled' where status = 'queued'`;
    await sql`update turns set status = 'expired', lease_id = null where status = 'running'`;
    await sql`update jobs set status = 'cancelled' where status in ('queued', 'running')`;
    const [laptop] = await sql`select n.id from nodes n join api_tokens t on t.id = n.token_id where n.name = 'laptop' and t.revoked_at is null`;
    const [studio] = await sql`select n.id from nodes n join api_tokens t on t.id = n.token_id where n.name = 'studio' and t.revoked_at is null`;
    const week = new Date(Date.now() + 5 * 86400e3).toISOString();
    const acct = (provider: string, name: string, used: number) => ({ provider, accountKey: key(name), status: "ok", fetchedAt: now(),
      windows: [{ id: "weekly", label: "Weekly", kind: "weekly", unit: "percent", used, resetsAt: week }] });
    await ok(node, "POST", "/api/node/usage", { observedAt: now(), accounts: [acct("agy", "r2-agy", 50), acct("codex", "r2-codex-laptop", 70)] });

    // The review the picker chose is the one the laptop claims: Antigravity, with no model.
    const job = await start();
    assert.equal(job.provider, "agy");
    const { turns } = await ok(node, "POST", "/api/node/jobs/claim", { providers: ["agy", "codex"], max: 1 });
    assert.equal(turns[0].job.id, job.id);
    assert.equal(turns[0].job.provider, "agy");
    assert.equal(turns[0].job.model, undefined);

    // The laptop is busy now (one job at a time): Antigravity can't run there, and Codex goes to the studio.
    let r = await review();
    assert.equal(r.provider, "codex");
    assert.match(r.picked.why, /Antigravity can't run: the machine that runs it is busy/);
    assert.equal(r.machineId, null, "one Codex account: not pinned");

    // A second Codex account, read by the studio: while the laptop is busy, the studio's usage counts and the review goes there.
    await ok(node2, "POST", "/api/node/usage", { observedAt: now(), accounts: [acct("codex", "r2-codex-studio", 80)] });
    r = await review();
    assert.equal(r.picked.why, "Codex has 20% left. Antigravity can't run: the machine that runs it is busy.");
    assert.equal(r.machineId, studio!.id);

    // A machine that says it runs two at once still has a slot.
    await ok(node, "POST", "/api/node/heartbeat", { ...hb("laptop"), providers: [{ provider: "agy", signedIn: true, canRunJobs: true, locations: ["cloud"], models: [] }, { provider: "codex", signedIn: true, canRunJobs: true, locations: ["cloud"], models: [] }], capacity: 2 });
    assert.equal((await review()).provider, "agy");
    await ok(node, "POST", "/api/node/heartbeat", { ...hb("laptop"), providers: [{ provider: "agy", signedIn: true, canRunJobs: true, locations: ["cloud"], models: [] }, { provider: "codex", signedIn: true, canRunJobs: true, locations: ["cloud"], models: [] }] });

    // The laptop finishes: it's free again, and its Codex account (30% left) beats the studio's (20%).
    await ok(node, "POST", `/api/node/jobs/${job.id}/events`, { leaseId: turns[0].leaseId, events: [{ seq: 0, at: now(), type: "result", summary: "Looks fine" }] });
    r = await review({ among: ["codex"] });
    assert.equal(r.picked.why, "Codex has 30% left.");
    assert.equal(r.machineId, laptop!.id);

    // Antigravity's reading is three hours old: Codex, with less left but current, goes first.
    await sql`update subscriptions set fetched_at = now() - interval '3 hours' where account_key = ${key("r2-agy")}`;
    r = await review();
    assert.equal(r.provider, "codex");
    assert.match(r.picked.why, /Antigravity has 50% left \(not current: read 3 h ago\)\./);
    const dash = await ok(ui, "GET", "/api/dashboard");
    assert.equal(dash.subscriptions.find((s: any) => s.provider === "agy").current, false);
    assert.equal(dash.subscriptions.find((s: any) => s.provider === "codex").current, true);

    // Antigravity's reading only has its Claude and GPT group: no Gemini reading, so it counts as half left
    // and beats Codex (30% on the laptop) for its fair share.
    await ok(node, "POST", "/api/node/usage", { observedAt: now(), accounts: [{ provider: "agy", accountKey: key("r2-agy"), status: "ok", fetchedAt: now(),
      windows: [{ id: "Claude and GPT models:3p-weekly", label: "Claude and GPT", kind: "weekly", unit: "percent", used: 100, resetsAt: week }] }] });
    r = await review();
    assert.equal(r.provider, "agy");
    assert.equal(r.picked.why, "Antigravity has no usage reading for its default model (counted as half left). Codex has 30% left.");

    // A project whose repo no machine has.
    const [area] = await sql`select id from tree_nodes where kind = 'area' and title = 'Golfer Geek'`;
    await ok(ui, "POST", "/api/tree", { kind: "project", title: "Elsewhere", parentId: area!.id, repoRemote: "https://github.com/GolferGeek/elsewhere" });
    const missing = await start({}, "golfer geek / elsewhere");
    assert.equal(missing.error, "No reviewer can run right now. Antigravity: no machine that runs it has this repo. Codex: no machine that runs it has this repo.");

    await sql`update subscriptions set hidden = true where provider in ('agy', 'codex')`;
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
