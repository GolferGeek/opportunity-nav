import type { ExternalWorkReport, NodeHeartbeat, UsageReport } from "@opnav/shared";
import type { Db, Sql } from "../db.ts";
import { listTree, normaliseRemote } from "./tree.ts";

/** Register or refresh the machine behind a node token. */
export async function heartbeat(db: Db, userId: string, tokenId: string, hb: NodeHeartbeat): Promise<string> {
  const checkouts = hb.checkouts.map((c) => ({ ...c, remote: c.remote ? normaliseRemote(c.remote) : undefined }));
  const [r] = await db<{ id: string }[]>`
    insert into nodes (user_id, token_id, hostname, name, platform, arch, helper_version, providers, checkouts, handoff, autonomy, cloudroom, tools, capacity, last_seen_at)
    values (${userId}, ${tokenId}, ${hb.hostname}, ${hb.name ?? hb.hostname}, ${hb.platform}, ${hb.arch}, ${hb.helperVersion},
            ${db.json(hb.providers as any)}, ${db.json(checkouts as any)}, ${hb.handoff ? db.json(hb.handoff as any) : null}, ${hb.autonomy}, ${hb.cloudroom ? db.json(hb.cloudroom as any) : null}, ${db.json([...new Set(hb.tools)])}, ${hb.capacity ?? 1}, now())
    on conflict (token_id) do update set hostname = excluded.hostname, name = coalesce(nullif(${hb.name ?? ""}, ''), nodes.name),
      platform = excluded.platform, arch = excluded.arch, helper_version = excluded.helper_version,
      providers = excluded.providers, checkouts = excluded.checkouts, handoff = excluded.handoff, autonomy = excluded.autonomy, cloudroom = excluded.cloudroom, tools = excluded.tools, capacity = excluded.capacity, last_seen_at = now()
    returning id`;
  return r!.id;
}

export async function machineForToken(db: Db, tokenId: string): Promise<string | null> {
  const [r] = await db<{ id: string }[]>`select id from nodes where token_id = ${tokenId}`;
  return r?.id ?? null;
}

export async function listMachines(db: Db, userId: string) {
  // Running = turns it holds a live lease on. That's the server's own record, so
  // it doesn't wait for the helper's next heartbeat (activeJobIds).
  const rows = await db`select n.*, t.revoked_at,
      (select count(*)::int from turns r where r.node_id = n.id and r.status = 'running' and r.lease_expires_at > now()) as running
    from nodes n join api_tokens t on t.id = n.token_id where n.user_id = ${userId} order by n.name`;
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
    tools: (r.tools ?? []) as string[],
    /** Jobs it runs at once, and how many it's running now. */
    capacity: Number(r.capacity ?? 1),
    running: Number(r.running ?? 0),
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
      const card = async (key: string) => (await tx`select id, status, fetched_at, merged_into from subscriptions
        where user_id = ${userId} and provider = ${a.provider} and account_key = ${key} for update`)[0];
      let cur = await card(a.accountKey);
      // A key that was folded into another card reports to that card.
      if (cur?.merged_into) cur = (await tx`select id, status, fetched_at, merged_into from subscriptions
        where id = ${cur.merged_into} and user_id = ${userId} for update`)[0] ?? cur;
      // Fold in cards this account was reported under before (older, machine-local keys).
      for (const alias of a.aliases ?? []) {
        const old = await card(alias);
        if (!old || old.merged_into || old.id === cur?.id) continue;
        if (!cur) {
          // Nothing under the new key yet: the old card carries on under it.
          await tx`update subscriptions set account_key = ${a.accountKey} where id = ${old.id}`;
          cur = old;
        } else {
          await mergeSubscriptions(tx, userId, old.id, cur.id);
          cur = (await tx`select id, status, fetched_at, merged_into from subscriptions where id = ${cur.id}`)[0];
        }
      }
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
      // This machine reads this account (whatever card wins the reading above).
      await tx`insert into usage_sources (subscription_id, node_id, status, fetched_at, observed_at)
        values (${id}, ${machineId}, ${a.status}, ${fetchedAt}, ${report.observedAt})
        on conflict (subscription_id, node_id) do update set status = excluded.status,
          fetched_at = greatest(usage_sources.fetched_at, excluded.fetched_at), observed_at = excluded.observed_at`;
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

/**
 * Fold one subscription card into another for the same provider: the newer good
 * reading wins, the cost and label carry over if the survivor has none, and the
 * old card is hidden and points at the survivor. Nothing is deleted.
 */
export async function mergeSubscriptions(db: Db, userId: string, fromId: string, intoId: string) {
  if (fromId === intoId) throw new Error("A card can't be merged into itself.");
  const rows = await db`select * from subscriptions where user_id = ${userId} and id in ${db([fromId, intoId])} for update`;
  const from = rows.find((r) => r.id === fromId), into = rows.find((r) => r.id === intoId);
  if (!from || !into) throw new Error("No such subscription.");
  if (from.provider !== into.provider) throw new Error("Only cards for the same provider can be merged.");
  if (into.merged_into) throw new Error("That card was itself merged; merge into the card it points at.");
  const t = (v: unknown) => (v ? new Date(v as string).getTime() : 0);
  if (t(from.fetched_at) > t(into.fetched_at)) {
    await db`delete from usage_windows where subscription_id = ${intoId}`;
    await db`update usage_windows set subscription_id = ${intoId} where subscription_id = ${fromId}`;
    await db`update subscriptions set status = ${from.status}, message = ${from.message}, fetched_at = ${from.fetched_at},
      observed_at = greatest(observed_at, ${from.observed_at}), reported_by = ${from.reported_by}, plan = coalesce(${from.plan}, plan)
      where id = ${intoId}`;
  }
  await db`update subscriptions set monthly_cost_usd = coalesce(monthly_cost_usd, ${from.monthly_cost_usd}),
    label = coalesce(label, ${from.label}) where id = ${intoId}`;
  // The machines that read the old card read the survivor.
  await db`insert into usage_sources (subscription_id, node_id, status, fetched_at, observed_at)
    select ${intoId}, node_id, status, fetched_at, observed_at from usage_sources where subscription_id = ${fromId}
    on conflict (subscription_id, node_id) do update set
      status = case when excluded.observed_at > usage_sources.observed_at then excluded.status else usage_sources.status end,
      fetched_at = greatest(usage_sources.fetched_at, excluded.fetched_at), observed_at = greatest(usage_sources.observed_at, excluded.observed_at)`;
  await db`delete from usage_sources where subscription_id = ${fromId}`;
  await db`update subscriptions set hidden = true, merged_into = ${intoId} where id = ${fromId}`;
  // Anything already folded into the old card follows it.
  await db`update subscriptions set merged_into = ${intoId} where merged_into = ${fromId}`;
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
