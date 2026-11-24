-- When the server let a running turn start publishing (pushing its work). Once set,
-- publishing wins: a cancel is refused for that turn. Null = it hasn't asked (or can't push).
alter table turns add column publishing_at timestamptz;
