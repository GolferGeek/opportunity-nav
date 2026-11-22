-- Drill-in detail for outside work (handoff tasks etc.).
alter table external_work add column started_at timestamptz, add column detail jsonb;
