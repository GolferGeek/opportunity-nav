-- Jobs can run in Claude's cloud through the person's Claude Code routine.
alter table jobs drop constraint if exists jobs_runner_check;
alter table jobs add constraint jobs_runner_check check (runner in ('direct', 'cloudroom', 'claude-cloud'));
-- Whether a machine's routine is set up ({ ready, reason }); null = an older helper that doesn't say.
alter table nodes add column claude_cloud jsonb;
