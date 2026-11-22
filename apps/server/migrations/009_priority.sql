-- Every node gets a priority. Projects show and sort by it; everything starts
-- at medium so nothing moves until the person sets one.
alter table tree_nodes add column priority text not null default 'medium'
  check (priority in ('high', 'medium', 'low'));
