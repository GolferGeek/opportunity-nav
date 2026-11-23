-- How many jobs a machine's helper runs at once. The server counts the jobs it
-- has running against this to tell whether the machine has a free slot now.
alter table nodes add column capacity int not null default 1;
