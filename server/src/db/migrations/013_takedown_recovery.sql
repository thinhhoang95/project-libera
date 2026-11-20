-- What a taken-down project's former members may still download for a bounded
-- time: the final version of every binary it held. Without it a device that
-- had not yet received a file loses access to it the moment the project row
-- goes. The rows are keyed by project id with no foreign key (the project is
-- gone) and expire; blob-gc keeps the objects while a row names them.
create table takedown_recoveries (
  project_id text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table takedown_recovery_members (
  project_id text not null references takedown_recoveries (project_id) on delete cascade,
  account_id text not null,
  primary key (project_id, account_id)
);
create table takedown_recovery_blobs (
  project_id text not null references takedown_recoveries (project_id) on delete cascade,
  hash text not null,
  size bigint not null,
  mime text not null,
  primary key (project_id, hash)
);
create index takedown_recovery_blobs_hash on takedown_recovery_blobs (hash);
create index takedown_recoveries_expiry on takedown_recoveries (expires_at);
