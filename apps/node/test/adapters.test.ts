import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
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

test("Cursor, Grok Bot, Antigravity and Grok report fixture accounts", async t => {
  const { home, save } = await workspace(t);
  await save(".config/cursor/auth.json", { accessToken: fixtureJwt({ sub: "auth0|cursor-test" }) });
  await save(".gemini/antigravity-cli/antigravity-oauth-token",
    { token: { access_token: "test-agy" }, id_token: fixtureJwt({ sub: "google-agy" }) });
  await save(".grok/auth.json", { fixture: { key: fixtureJwt({ sub: "grok-test" }) } });
  await save(".gemini/oauth_creds.json", { access_token: "test-gemini" });
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
  const [cursor, grokbot, agy, grok] = report.accounts;
  // Gemini CLI is no longer reported, even when its sign-in is on the machine.
  assert.deepEqual(report.accounts.map(account => account.provider), ["cursor", "grokbot", "agy", "grok"]);
  assert.equal(cursor?.plan, "Fixture plan");
  assert.deepEqual(cursor?.windows.slice(0, 4).map(window => [window.kind, window.used]), [
    ["weekly", 25], ["weekly", 5], ["weekly", 40], ["spend", 1],
  ]);
  assert.equal(cursor?.windows.filter(window => window.unit === "tokens" && window.used === 12).length, 7);
  assert.equal(grokbot?.windows[0]?.used, 0);
  assert.deepEqual(agy?.windows.map(window => window.used), [50, 100]);
  assert.deepEqual(grok?.windows.map(window => window.used), [20, 30]);
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
    system: { home, env: { PATH: bin, OPNAV_NODE_TOKEN: "fixture-service" }, platform: "linux" },
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
  const system = { home, env: {}, platform: "linux" as const };
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
  const { accounts: [account] } = await readUsage({ system: { home, env: {}, platform: "linux" }, fetch });
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

async function fakeCommand(bin: string, name: string, script: string) {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), "#!/bin/sh\n" + script);
  await chmod(join(bin, name), 0o700);
}

test("Cursor reads cursor-agent's sign-in from the Secret Service when auth.json points there", async t => {
  const { home, save } = await workspace(t);
  const bin = join(home, "bin");
  const token = fixtureJwt({ sub: "auth0|user_secret", exp: Date.now() / 1000 + 3600 });
  await save(".config/cursor/auth.json", { storedIn: "os-secret-store" });
  await fakeCommand(bin, "secret-tool", `[ "$*" = "lookup service cursor-credentials account cursor-user" ] && printf '%s' '${JSON.stringify({ accessToken: token, refreshToken: "fixture-refresh" })}'\n`);
  const seen: string[] = [];
  const { accounts } = await readUsage({
    system: { home, env: { PATH: bin }, platform: "linux" },
    fetch: async (url, init) => {
      seen.push(new Headers(init?.headers).get("Authorization") ?? "");
      const method = String(url).split("/").at(-1);
      if (method === "GetCurrentPeriodUsage") return Response.json({ planUsage: { totalPercentUsed: 7 } });
      if (method === "GetSandUsageStatus") return Response.json({ hasNonZeroIncludedLimit: true, usagePercent: 3 });
      return Response.json({});
    },
  });
  assert.ok(seen.length && seen.every(value => value === `Bearer ${token}`));
  assert.equal(accounts.find(a => a.provider === "cursor")?.windows[0]?.used, 7);
  assert.equal(accounts.find(a => a.provider === "grokbot")?.windows[0]?.used, 3);
});

test("Grok Bot reads the Grok Bot app's own sign-in on macOS, or says how to allow it", async t => {
  const { home, save } = await workspace(t);
  const bin = join(home, "bin");
  const subject = "google-oauth2|user_grokbot";
  const token = fixtureJwt({ sub: subject, exp: Date.now() / 1000 + 3600 });
  const key = pbkdf2Sync("fixture-password", "saltysalt", 1003, 16, "sha1");
  const encrypt = (text: string) => {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    return Buffer.concat([Buffer.from("v10"), cipher.update(text), cipher.final()]).toString("base64");
  };
  const active = createHash("sha256").update(subject).digest("hex");
  await save("Library/Application Support/Grok Bot/sand-secrets.json", { version: 1, "cursor-accounts": JSON.stringify({
    active, accounts: { [active]: { "cursor-access-token": encrypt(token), "cursor-refresh-token": encrypt("fixture-refresh") } },
  }) });
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
    assert.match(String(url), /GetSandUsageStatus$/);
    return Response.json({ hasNonZeroIncludedLimit: true, usagePercent: 42 });
  };

  await fakeCommand(bin, "security", "exit 1\n");
  // A refused keychain read is remembered per home for hours, so this run uses its own spelling of the home.
  const denied = await readUsage({ system: { home: home + "/", env: { PATH: bin }, platform: "darwin" }, fetch });
  const waiting = denied.accounts.find(a => a.provider === "grokbot");
  assert.equal(waiting?.status, "auth_required");
  assert.match(waiting?.message ?? "", /Always Allow/);

  await fakeCommand(bin, "security", `[ "$*" = "find-generic-password -s Grok Bot Safe Storage -a Grok Bot Key -w" ] && echo fixture-password\n`);
  const { accounts } = await readUsage({ system: { home, env: { PATH: bin }, platform: "darwin" }, fetch });
  const account = accounts.find(a => a.provider === "grokbot");
  assert.equal(account?.status, "ok");
  assert.equal(account?.windows[0]?.used, 42);
});
