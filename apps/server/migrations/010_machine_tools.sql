-- Machines report what they have beyond agents and repos (docker, database).
-- A job lists what it needs; it only goes to a machine that has all of it.
-- A project can set what its jobs need by default.
alter table nodes add column tools jsonb not null default '[]'::jsonb;
alter table jobs add column needs jsonb not null default '[]'::jsonb;
alter table tree_nodes add column default_needs jsonb not null default '[]'::jsonb;
