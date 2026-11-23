-- Which machine reads which subscription account. A card is one account, read
-- by every machine signed in to it; this records each machine's own reports,
-- so a machine's usage is the account it's signed in to, not another machine's.
create table usage_sources (
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  node_id uuid not null references nodes(id) on delete cascade,
  status text not null,
  fetched_at timestamptz,
  observed_at timestamptz not null,
  primary key (subscription_id, node_id)
);
create index usage_sources_node on usage_sources (node_id, observed_at desc);

-- Until now only the last machine to report was kept.
insert into usage_sources (subscription_id, node_id, status, fetched_at, observed_at)
  select id, reported_by, status, fetched_at, observed_at from subscriptions where reported_by is not null;
