-- The backlog: jobs that wait for their turn, and machines pull the next one
-- themselves. A backlog job is an ordinary queued job with backlog = true; it
-- is handed out in the person's order (the app ranking, then its place in its
-- app) once nothing holds it back (held, waiting on another item, the local
-- model or its branch busy).
alter table jobs add column backlog boolean not null default false;
-- Which app it counts under for the ranking (free text, e.g. "Legal"); default the project's title.
alter table jobs add column app text;
-- Its place inside its app; lower goes first.
alter table jobs add column position double precision not null default 0;
-- A held job never starts until it's let go.
alter table jobs add column held boolean not null default false;
-- Start only once these have succeeded: another job's key or id, or a handoff brief's name.
alter table jobs add column after jsonb not null default '[]';
-- Uses the machine's own local models (Ollama): one such job per machine at a time.
alter table jobs add column local_model boolean not null default false;
-- Run from a checkout on this branch (default: the checkout the machine has for the repo).
alter table jobs add column branch text;
-- The branch of the checkout it was handed out with, so two pushing jobs never land on one branch at once.
alter table jobs add column checkout_branch text;
-- A name that's unique per person (a handoff brief's name), so importing twice can't add it twice.
alter table jobs add column key text;
create unique index jobs_user_key on jobs(user_id, lower(key)) where key is not null;
create index jobs_backlog on jobs(user_id, status) where backlog;

-- The app ranking: apps in the order their backlog items go. Apps not listed go after, in tree order.
create table backlog_apps (
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  position int not null,
  primary key (user_id, name)
);

-- A machine's owner can keep it below what its helper runs (e.g. 2 on a laptop). Null = the helper's capacity.
alter table nodes add column job_limit int check (job_limit is null or job_limit >= 0);
