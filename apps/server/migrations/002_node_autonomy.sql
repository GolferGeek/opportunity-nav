-- Each machine's worker autonomy, as its owner set it.
alter table nodes add column autonomy text not null default 'edit' check (autonomy in ('edit', 'full'));
