-- Blob objects no project references any more (the last project holding one
-- was taken down). The blob-gc job deletes the object after a recovery grace
-- period, unless a project has referenced the hash again meanwhile.
create table blob_orphans (
  hash text primary key,
  orphaned_at timestamptz not null default now()
);
