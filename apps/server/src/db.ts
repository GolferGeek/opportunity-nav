import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type Sql = postgres.Sql;
/** A transaction or the pool; service functions accept either. */
export type Db = postgres.Sql | postgres.TransactionSql;

export function connect(url: string): Sql {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
  });
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Apply any .sql files in migrations/ not yet recorded. Runs under an advisory lock. */
export async function migrate(sql: Sql): Promise<string[]> {
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(4317)`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(await readFile(path.join(MIGRATIONS_DIR, file), "utf8"));
      await tx`insert into schema_migrations (name) values (${file})`;
      applied.push(file);
    }
  });
  return applied;
}
