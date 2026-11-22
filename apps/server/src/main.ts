import { connect, migrate } from "./db.ts";
import { buildApp } from "./app.ts";
import { expireLeases } from "./services/jobs.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Set ${k} (see .env.example).`);
  return v;
};

const sql = connect(env("DATABASE_URL"));
const applied = await migrate(sql);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

// A restart ends any Claude panel turn that was running.
await sql`update chat_threads set running = false where running`;

const port = Number(env("PORT", "4317"));
const host = env("HOST", "127.0.0.1");
const app = await buildApp({
  sql,
  publicUrl: env("PUBLIC_URL", `http://${host}:${port}`),
  logger: true,
  assistant: {
    command: env("OPNAV_ASSISTANT_CMD", "claude"),
    selfUrl: `http://127.0.0.1:${port}`,
    timeoutMs: Number(env("OPNAV_ASSISTANT_TIMEOUT_MS", "180000")),
  },
  chat: {
    command: env("OPNAV_ASSISTANT_CMD", "claude"),
    selfUrl: `http://127.0.0.1:${port}`,
    timeoutMs: Number(env("OPNAV_CHAT_TIMEOUT_MS", "600000")),
    appRepo: env("OPNAV_APP_REPO", "github.com/golfergeek/opportunity-nav"),
  },
});
await app.listen({ port, host });

const sweep = setInterval(() => {
  expireLeases(sql).catch((e) => app.log.error(e, "lease sweep failed"));
}, 15_000);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    clearInterval(sweep);
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
