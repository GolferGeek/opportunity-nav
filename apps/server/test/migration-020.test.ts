/** Migration 020 upgrade coverage against a real throwaway Postgres database. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, migrate, type Sql } from "../src/db.ts";
import { attended } from "../src/services/views.ts";

const url = process.env.OPNAV_TEST_DATABASE_URL;
const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("migration 020", { skip: !url && "set OPNAV_TEST_DATABASE_URL" }, () => {
  let admin: Sql;
  let sql: Sql;
  const schema = `migration_020_${randomUUID().replaceAll("-", "")}`;

  before(async () => {
    admin = connect(url!);
    await admin.unsafe(`create schema ${schema}`);
    const scopedUrl = new URL(url!);
    const options = [scopedUrl.searchParams.get("options"), `-c search_path=${schema}`].filter(Boolean).join(" ");
    scopedUrl.searchParams.set("options", options);
    sql = connect(scopedUrl.toString());

    await sql`create table schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql") && file < "020_job_item.sql").sort();
    for (const file of files) {
      await sql.unsafe(await readFile(path.join(migrations, file), "utf8"));
      await sql`insert into schema_migrations (name) values (${file})`;
    }
  });

  after(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });

  test("keeps legacy rows and treats their project's attendance as unknown", async () => {
    const [user] = await sql`insert into users (name) values ('Upgrade test') returning id`;
    const [project] = await sql`insert into tree_nodes (user_id, kind, title) values (${user!.id}, 'project', 'Old project') returning id`;
    const [item] = await sql`insert into tree_nodes (user_id, parent_id, kind, title) values (${user!.id}, ${project!.id}, 'item', 'Old item') returning id`;
    const [nested] = await sql`insert into tree_nodes (user_id, parent_id, kind, title) values (${user!.id}, ${item!.id}, 'item', 'Nested old item') returning id`;
    const [legacyJob] = await sql`insert into jobs
      (user_id, project_id, title, prompt, provider, location, status, created_by)
      values (${user!.id}, ${project!.id}, 'Legacy work', 'Keep working', 'codex', 'local', 'running', 'test') returning id`;

    assert.deepEqual(await migrate(sql), ["020_job_item.sql"]);
    const [kept] = await sql`select item_id from jobs where id = ${legacyJob!.id}`;
    assert.ok(kept, "the existing job is kept");
    assert.equal(kept!.item_id, null, "a legacy job stays unlinked");
    assert.deepEqual(new Set(await attended(sql, user!.id)), new Set([item!.id, nested!.id]), "all project items are conservatively attended");

    // A previous app version does not mention item_id. It must keep working if
    // the database has migrated before that app is restored during rollback.
    const [oldAppJob] = await sql`insert into jobs
      (user_id, project_id, title, prompt, provider, location, status, created_by)
      values (${user!.id}, ${project!.id}, 'Started by old app', 'Still works', 'codex', 'local', 'queued', 'test') returning id, item_id`;
    assert.equal(oldAppJob!.item_id, null);

    await sql`update jobs set status = 'succeeded', finished_at = now() where project_id = ${project!.id}`;
    assert.deepEqual(await attended(sql, user!.id), [], "items become unattended after all legacy jobs finish");
  });
});
