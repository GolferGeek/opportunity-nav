-- The tree node a job was started from (an item, or the project itself). The job
-- still runs in its project (project_id); this says which item it's working on,
-- so an item with no live job shows as unattended. Null for jobs from before this.
alter table jobs add column item_id uuid references tree_nodes(id) on delete set null;
create index jobs_live_item on jobs(user_id, item_id) where item_id is not null and status in ('queued', 'running', 'waiting');
