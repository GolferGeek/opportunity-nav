-- Opportunity Nav: initial schema. Everything is per user; nothing is hard-coded.

create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Bearer tokens. Only a SHA-256 of the token is stored.
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('ui', 'node', 'agent')),
  label text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- The tree: areas, projects, and items inside projects.
create table tree_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  parent_id uuid references tree_nodes(id) on delete cascade,
  kind text not null check (kind in ('area', 'project', 'item')),
  title text not null,
  notes text,
  position double precision not null default 0,
  favorite_position double precision, -- null = not a favorite
  repo_remote text,                    -- normalised, e.g. github.com/owner/repo
  default_provider text,
  default_model text,
  default_location text check (default_location in ('local', 'cloud')),
  status_line text,                    -- set by the person or an agent; shown on the dashboard
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tree_nodes_parent on tree_nodes(user_id, parent_id, position);

-- Machines running the helper. One per node token.
create table nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_id uuid not null unique references api_tokens(id) on delete cascade,
  hostname text not null,
  name text not null,
  platform text not null,
  arch text not null,
  helper_version text not null,
  providers jsonb not null default '[]',
  checkouts jsonb not null default '[]',
  handoff jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid not null references tree_nodes(id) on delete cascade,
  title text not null,
  prompt text not null,
  provider text not null,
  model text,
  location text not null check (location in ('local', 'cloud')),
  effort text,
  status text not null check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  node_id uuid references nodes(id) on delete set null,
  pinned boolean not null default false, -- the person chose the machine
  checkout_path text,
  issue_url text,
  provider_session_id text,
  last_progress text,
  summary text,
  cancel_requested boolean not null default false,
  attempts int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_user_status on jobs(user_id, status);

-- One claim = one turn.
create table turns (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  kind text not null check (kind in ('start', 'continue')),
  status text not null check (status in ('queued', 'running', 'done', 'expired', 'cancelled')),
  node_id uuid references nodes(id) on delete set null,
  lease_id uuid,
  lease_expires_at timestamptz,
  answer_id uuid,
  last_seq int not null default -1,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);
create unique index turns_one_open on turns(job_id) where status in ('queued', 'running');

create table job_events (
  turn_id uuid not null references turns(id) on delete cascade,
  seq int not null,
  job_id uuid not null references jobs(id) on delete cascade,
  type text not null,
  payload jsonb not null,
  at timestamptz not null,
  primary key (turn_id, seq)
);
create index job_events_job on job_events(job_id, at);

create table external_work (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  node_id uuid references nodes(id) on delete set null,
  source text not null,
  external_id text not null,
  project_id uuid references tree_nodes(id) on delete set null,
  title text not null,
  status text not null,
  repo text,
  url text,
  summary text,
  updated_at timestamptz not null,
  gone_at timestamptz,
  unique (user_id, source, external_id)
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid references tree_nodes(id) on delete cascade,
  job_id uuid references jobs(id) on delete cascade,
  external_work_id uuid references external_work(id) on delete cascade,
  body text not null,
  options jsonb,
  context text,
  status text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create unique index questions_external_body on questions(external_work_id, body) where external_work_id is not null;

create table answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null unique references questions(id) on delete cascade,
  text text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table roadblocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid references tree_nodes(id) on delete cascade,
  job_id uuid references jobs(id) on delete cascade,
  body text not null,
  status text not null default 'open' check (status in ('open', 'cleared')),
  created_at timestamptz not null default now(),
  cleared_at timestamptz
);

-- One row per subscription account (deduplicated across machines by account_key).
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  account_key text not null,
  label text,
  plan text,
  status text not null,
  message text,
  fetched_at timestamptz,
  observed_at timestamptz not null,
  reported_by uuid references nodes(id) on delete set null,
  monthly_cost_usd numeric,
  hidden boolean not null default false,
  unique (user_id, provider, account_key)
);

create table usage_windows (
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  window_id text not null,
  label text not null,
  kind text not null,
  unit text not null,
  used double precision not null,
  lim double precision,
  resets_at timestamptz,
  model text,
  fetched_at timestamptz,
  primary key (subscription_id, window_id)
);
