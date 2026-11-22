-- Jobs can run through Cloudroom's cloud instead of directly on a machine.
alter table jobs add column runner text not null default 'direct' check (runner in ('direct', 'cloudroom'));
-- Which of our agents a machine can hand to Cloudroom (null = no Cloudroom there).
alter table nodes add column cloudroom jsonb;
