import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { readUsage } from "../src/index.ts";

function fixtureJwt(fields: object) {
  return "fixture." + Buffer.from(JSON.stringify(fields)).toString("base64url") + ".fixture";
}

async function workspace(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "opnav-usage-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    home,
    async save(name: string, data: object) {
      const file = join(home, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data));
    },
  };
}

test("Cursor, Grok Bot, Antigravity, Grok and Gemini report fixture accounts", async t => {
  const { home, save } = await workspace(t);
  await save(".config/cursor/auth.json", { accessToken: fixtureJwt({ sub: "auth0|cursor-test" }) });
  await save(".gemini/antigravity-cli/antigravity-oauth-token",
    { token: { access_token: "test-agy" }, id_token: fixtureJwt({ sub: "google-agy" }) });
  await save(".grok/auth.json", { fixture: { key: fixtureJwt({ sub: "grok-test" }) } });
  await save(".gemini/oauth_creds.json", { access_token: "test-gemini" });
  await save(".gemini/google_accounts.json", { active: "test@example.invalid" });
  const data = JSON.parse(await readFile(new URL("./fixtures/usage-responses.json", import.meta.url), "utf8"));
  const calls: string[] = [];
  const report = await readUsage({
    system: { home, env: {}, platform: "linux" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = url.pathname.split(/[/:]/).at(-1) + url.search;
      calls.push(method);
      if (method === "retrieveUserQuotaSummary") assert.deepEqual(JSON.parse(String(init?.body)), { project: "test-project" });
      assert.ok(data[method], method);
      return Response.json(data[method]);
    },
  });
  const [cursor, grokbot, agy, grok, gemini] = report.accounts;
  assert.deepEqual(report.accounts.map(account => account.provider), ["cursor", "grokbot", "agy", "grok", "gemini"]);
  assert.equal(cursor?.plan, "Fixture plan");
  assert.deepEqual(cursor?.windows.slice(0, 4).map(window => [window.kind, window.used]), [
    ["weekly", 25], ["weekly", 5], ["weekly", 40], ["spend", 1],
  ]);
  assert.equal(cursor?.windows.filter(window => window.unit === "tokens" && window.used === 12).length, 7);
  assert.equal(grokbot?.windows[0]?.used, 0);
  assert.deepEqual(agy?.windows.map(window => window.used), [50, 100]);
  assert.deepEqual(grok?.windows.map(window => window.used), [20, 30]);
  assert.equal(gemini?.status, "unavailable");
  assert.equal(calls.length, 14);
});

test("Codex uses the app-server with isolated external auth and falls back to account/read", async t => {
  const { home, save } = await workspace(t);
  const bin = join(home, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await copyFile(new URL("./fixtures/app-server.mjs", import.meta.url), join(bin, "codex"));
  await chmod(join(bin, "codex"), 0o700);
  const auth = { tokens: { access_token: fixtureJwt({}), account_id: "fixture-workspace",
    id_token: fixtureJwt({ "https://api.openai.com/auth": { chatgpt_user_id: "fixture-user" } }) } };
  await save(".codex/auth.json", auth);
  const { accounts } = await readUsage({
    system: { home, env: { PATH: bin, OPNAV_NODE_TOKEN: "fixture-service" } },
    fetch: async () => { throw new Error("No provider HTTP expected"); },
  });
  const account = accounts[0];
  assert.equal(account?.plan, "Plus");
  assert.deepEqual(account?.windows.map(window => window.used), [12, 37, 25]);
  assert.deepEqual(JSON.parse(await readFile(join(home, ".codex/auth.json"), "utf8")), auth);
});

test("Codex reads file-store usage without the CLI and keeps it when the sign-in lapses", async t => {
  const { home, save } = await workspace(t);
  const path = ".codex/auth.json";
  const auth = { tokens: { access_token: fixtureJwt({}), account_id: "fixture-workspace",
    id_token: fixtureJwt({ "https://api.openai.com/auth": { chatgpt_user_id: "fixture-user" } }) } };
  await save(path, auth);
  const system = { home, env: {} };
  const fixture = JSON.parse(await readFile(new URL("./fixtures/codex-usage.json", import.meta.url), "utf8"));
  const { accounts: [account] } = await readUsage({
    system,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${auth.tokens.access_token}`);
      assert.equal(headers.get("ChatGPT-Account-Id"), auth.tokens.account_id);
      return Response.json(fixture);
    },
  });
  assert.equal(account?.provider, "codex");
  assert.equal(account?.status, "ok");
  assert.equal(account?.plan, "Plus");
  assert.deepEqual(account?.windows.map(({ id, label, kind, used, resetsAt }) => [id, label, kind, used, resetsAt]), [
    ["codex:primary", "5-hour", "session", 12, "2030-01-01T00:00:00.000Z"],
    ["codex:secondary", "Weekly", "weekly", 37, "2030-01-07T00:00:00.000Z"],
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(home, path), "utf8")), auth);

  const { accounts: [rejected] } = await readUsage({
    system, fetch: async () => new Response(null, { status: 401 }),
  });
  assert.equal(rejected?.status, "stale");
  assert.match(rejected?.message ?? "", /^Start Codex to refresh it\./);

  await save(path, { tokens: { ...auth.tokens, access_token: fixtureJwt({ exp: 1 }) } });
  const fetch = t.mock.fn(async () => new Response());
  const { accounts: [expired] } = await readUsage({ system, fetch });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(expired?.status, "stale");
  assert.match(expired?.message ?? "", /^Start Codex to refresh it\./);
  assert.equal(expired?.fetchedAt, account?.fetchedAt);
  assert.deepEqual(expired?.windows.map(window => window.used), [12, 37]);
});

test("Codex suggests installing the CLI when the file fallback lacks an account id", async t => {
  const { home, save } = await workspace(t);
  await save(".codex/auth.json", { tokens: { access_token: fixtureJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-claim-only" },
  }) } });
  const fetch = t.mock.fn(async () => new Response());
  const { accounts: [account] } = await readUsage({ system: { home, env: {} }, fetch });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(account?.status, "unavailable");
  assert.equal(account?.message, "Install the Codex CLI to read usage on this machine.");
});

test("scoped Claude windows win over legacy windows and lapsed accounts stay visible", async t => {
  const { home, save } = await workspace(t);
  await save(".claude/.credentials.json", { claudeAiOauth: { accessToken: "test-claude" } });
  await save(".gemini/antigravity-cli/antigravity-oauth-token",
    { token: { access_token: "test-agy", refresh_token: "fixture-refresh", expiry: "2000-01-01" } });
  await save(".config/cursor/auth.json", { accessToken: "test-cursor" });
  const { accounts } = await readUsage({
    system: { home, env: {}, platform: "linux" },
    fetch: async url => {
      assert.doesNotMatch(String(url), /googleapis/);
      if (String(url).includes("cursor.sh")) return new Response(null, { status: 401 });
      return Response.json({
        five_hour: null, seven_day: { utilization: 99 },
        limits: [
          { kind: "weekly_all", group: "weekly", percent: 9 },
          { kind: "weekly_scoped", group: "weekly", percent: 0, scope: { model: { display_name: "Fable" } } },
        ],
      });
    },
  });
  assert.deepEqual(accounts.find(a => a.provider === "claude")?.windows.map(w => [w.id, w.label, w.used, w.model]), [
    ["weekly_all", "Weekly", 9, undefined], ["weekly_scoped:fable", "Fable weekly", 0, "Fable"],
  ]);
  const agy = accounts.find(a => a.provider === "agy");
  assert.equal(agy?.status, "stale");
  assert.equal(agy?.message, "Start Antigravity to refresh it. No need to sign in again.");
  assert.match(agy?.accountKey ?? "", /^[a-f0-9]{64}$/);
  const cursor = accounts.find(a => a.provider === "cursor");
  assert.equal(cursor?.status, "auth_required");
  assert.equal(cursor?.message, "Cursor refused the saved sign-in. Sign in to the Cursor editor, or run `cursor-agent login`.");
});
