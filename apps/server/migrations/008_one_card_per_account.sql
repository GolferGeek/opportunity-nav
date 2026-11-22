-- A card that turned out to be the same subscription as another is folded into
-- it: hidden, pointing at the card that carries on. Nothing is deleted, and a
-- report that still arrives under the old key lands on the right card.
alter table subscriptions add column merged_into uuid references subscriptions(id) on delete set null;

-- A tool the agent was refused mid-run used to open a roadblock even when the
-- job then succeeded. A job that succeeded needs nothing from the person.
update roadblocks r set status = 'cleared', cleared_at = now()
  from jobs j where j.id = r.job_id and j.status = 'succeeded' and r.status = 'open';
