import type { ExternalWorkReport, NodeHeartbeat, UsageReport } from "@opnav/shared";
import type { Db, Sql } from "../db.ts";
import { listTree, normaliseRemote } from "./tree.ts";

/** Register or refresh the machine behind a node token. */
export async function heartbeat(db: Db, userId: string, tokenId: string, hb: NodeHeartbeat): Promise<string> {
  const checkouts = hb.checkouts.map((c) => ({ ...c, remote: c.remote ? normaliseRemote(c.remote) : undefined }));
  const [r] = await db<{ id: string }[]>`
    insert into nodes (user_id, token_id, hostname, name, platform, arch, helper_version, providers, checkouts, handoff, autonomy, cloudroom, last_seen_at)
    values (${userId}, ${tokenId}, ${hb.hostname}, ${hb.name ?? hb.hostname}, ${hb.platform}, ${hb.arch}, ${hb.helperVersion},
            ${db.json(hb.providers as any)}, ${db.json(checkouts as any)}, ${hb.handoff ? db.json(hb.handoff as any) : null}, ${hb.autonomy}, ${hb.cloudroom ? db.json(hb.cloudroom as any) : null}, now())
    on conflict (token_id) do update set hostname = excluded.hostname, name = coalesce(nullif(${hb.name ?? ""}, ''), nodes.name),
      platform = excluded.platform, arch = excluded.arch, helper_version = excluded.helper_version,
      providers = excluded.providers, checkouts = excluded.checkouts, handoff = excluded.handoff, autonomy = excluded.autonomy, cloudroom = excluded.cloudroom, last_seen_at = now()
    returning id`;
  return r!.id;
}

export async function machineForToken(db: Db, tokenId: string): Promise<string | null> {
  const [r] = await db<{ id: string }[]>`select id from nodes where token_id = ${tokenId}`;
  return r?.id ?? null;
}

export async function listMachines(db: Db, userId: string) {
  const rows = await db`select n.*, t.revoked_at from nodes n join api_tokens t on t.id = n.token_id where n.user_id = ${userId} order by n.name`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hostname: r.hostname,
    platform: r.platform,
    helperVersion: r.helper_version,
    providers: r.providers,
    checkouts: r.checkouts,
    handoff: r.handoff,
    autonomy: r.autonomy,
    cloudroom: r.cloudroom as { providers: string[] } | null,
    lastSeenAt: r.last_seen_at,
    online: !r.revoked_at && Date.now() - new Date(r.last_seen_at).getTime() < 120_000,
    revoked: !!r.revoked_at,
  }));
}

/** A fresh good reading from another machine beats a failure from this one for this long. */
const GOOD_READING_WINS_MS = 30 * 60_000;

/**
 * Store a usage report. Per (account, window) the newest good reading wins; a
 * failed poll keeps the last good windows and only changes status when nobody
 * else has a recent good reading. A failure is never stored as zero use.
 */
export async function ingestUsage(sql: Sql, userId: string, machineId: string, report: UsageReport): Promise<number> {
  return sql.begin(async (tx) => {
    for (const a of report.accounts) {
      const fetchedAt = a.fetchedAt ?? (a.status === "ok" ? report.observedAt : null);
      const [cur] = await tx`select id, status, fetched_at from subscriptions
        where user_id = ${userId} and provider = ${a.provider} and account_key = ${a.accountKey} for update`;
      const curFetched = cur?.fetched_at ? new Date(cur.fetched_at).getTime() : 0;
      const incomingFetched = fetchedAt ? new Date(fetchedAt).getTime() : 0;
      const hasNewerWindows = a.windows.length > 0 && incomingFetched > curFetched;
      const othersFresh = cur && cur.status === "ok" && a.status !== "ok" && Date.now() - curFetched < GOOD_READING_WINS_MS;

      let id: string = cur?.id;
      if (!cur) {
        const [r] = await tx`insert into subscriptions (user_id, provider, account_key, label, plan, status, message, fetched_at, observed_at, reported_by)
          values (${userId}, ${a.provider}, ${a.accountKey}, ${a.label ?? null}, ${a.plan ?? null}, ${a.status}, ${a.message ?? null},
                  ${fetchedAt}, ${report.observedAt}, ${machineId}) returning id`;
        id = r!.id;
      } else if (!othersFresh) {
        await tx`update subscriptions set status = ${a.status}, message = ${a.message ?? null},
          label = coalesce(${a.label ?? null}, label), plan = coalesce(${a.plan ?? null}, plan),
          fetched_at = greatest(fetched_at, ${fetchedAt}), observed_at = ${report.observedAt}, reported_by = ${machineId}
          where id = ${id}`;
      }
      if (hasNewerWindows) {
        await tx`delete from usage_windows where subscription_id = ${id}`;
        for (const w of a.windows) {
          await tx`insert into usage_windows (subscription_id, window_id, label, kind, unit, used, lim, resets_at, model, fetched_at)
            values (${id}, ${w.id}, ${w.label}, ${w.kind}, ${w.unit}, ${w.used}, ${w.limit ?? null}, ${w.resetsAt ?? null}, ${w.model ?? null}, ${fetchedAt})`;
        }
      }
    }
    return report.accounts.length;
  });
}

/** Upsert handoff tasks, issues and cloud agents; attach them to projects by repo; lift their questions. */
export async function ingestExternal(sql: Sql, userId: string, machineId: string, report: ExternalWorkReport): Promise<number> {
  const tree = await listTree(sql, userId);
  const projects = tree.filter((n) => n.kind === "project" && n.repoRemote);
  const [machine] = await sql`select checkouts from nodes where id = ${machineId}`;
  const pathToRemote = new Map<string, string>();
  for (const c of (machine?.checkouts ?? []) as { path: string; remote?: string }[]) if (c.remote) pathToRemote.set(c.path.replace(/\/+$/, ""), c.remote);
  const projectFor = (repo?: string) => {
    if (!repo) return null;
    const expanded = repo.replace(/\/+$/, "");
    const remote = pathToRemote.get(expanded) ?? [...pathToRemote].find(([p]) => p.endsWith(expanded.replace(/^~/, "")))?.[1] ?? normaliseRemote(repo);
    return projects.find((p) => p.repoRemote === remote)?.id ?? null;
  };
  return sql.begin(async (tx) => {
    for (const it of report.items) {
      const [w] = await tx`
        insert into external_work (user_id, node_id, source, external_id, project_id, title, status, repo, url, summary, updated_at, started_at, detail)
        values (${userId}, ${machineId}, ${it.source}, ${it.externalId}, ${projectFor(it.repo)}, ${it.title}, ${it.status},
                ${it.repo ?? null}, ${it.url ?? null}, ${it.summary ?? null}, ${it.updatedAt}, ${it.startedAt ?? null},
                ${it.detail ? tx.json(it.detail as any) : null})
        on conflict (user_id, source, external_id) do update set node_id = excluded.node_id, project_id = excluded.project_id,
          title = excluded.title, status = excluded.status, repo = excluded.repo, url = excluded.url, summary = excluded.summary,
          updated_at = excluded.updated_at, gone_at = null, started_at = coalesce(excluded.started_at, external_work.started_at),
          detail = coalesce(excluded.detail, external_work.detail)
        returning id, project_id`;
      for (const q of it.questions) {
        await tx`insert into questions (user_id, project_id, external_work_id, body) values (${userId}, ${w!.project_id}, ${w!.id}, ${q})
          on conflict (external_work_id, body) where external_work_id is not null do nothing`;
      }
    }
    for (const source of report.complete) {
      const ids = report.items.filter((i) => i.source === source).map((i) => i.externalId);
      await tx`update external_work set gone_at = now() where user_id = ${userId} and node_id = ${machineId} and source = ${source}
        and gone_at is null and ${ids.length ? tx`external_id not in ${tx(ids)}` : tx`true`}`;
    }
    return report.items.length;
  });
}
