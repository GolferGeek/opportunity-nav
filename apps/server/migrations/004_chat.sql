-- The Claude panel: saved conversations with the app's assistant.
create table chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null,
  claude_session_id text,
  running boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chat_threads_user on chat_threads(user_id, updated_at desc);

create table chat_messages (
  id bigserial primary key,
  thread_id uuid not null references chat_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'error')),
  text text not null,
  at timestamptz not null default now()
);
create index chat_messages_thread on chat_messages(thread_id, id);
