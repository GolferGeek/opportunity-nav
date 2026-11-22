-- "Check now" on the dashboard: machines read usage at their next heartbeat.
alter table nodes add column usage_requested_at timestamptz;
