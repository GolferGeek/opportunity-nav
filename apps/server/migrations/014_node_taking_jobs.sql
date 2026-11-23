-- Whether a machine takes new jobs. Off = it finishes the jobs it has and claims
-- nothing more (before restarting or updating its helper). Its owner sets it.
alter table nodes add column taking_jobs boolean not null default true;
