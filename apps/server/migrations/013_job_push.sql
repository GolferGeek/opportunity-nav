-- A job can land its work on the branch its checkout was on and push it
-- (a handoff brief with push: true). Default false: commit on the job's branch only.
alter table jobs add column push boolean not null default false;
