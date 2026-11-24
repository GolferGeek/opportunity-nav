-- Cloud jobs (any runner but direct) have their own slots on a machine, on top of
-- capacity: what its helper says it runs at once. Null = an older helper, whose
-- cloud jobs count against capacity.
alter table nodes add column cloud_capacity integer;
