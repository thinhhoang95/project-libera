-- Creation attempts outlive project deletion, so a delayed retry cannot
-- recreate a taken-down project or select another project's audience.
create table project_creations (
  account_id text not null references accounts (id) on delete cascade,
  operation_id text not null,
  project_id text not null,
  name text not null,
  kind text not null check (kind in ('notebook', 'album')),
  created_at timestamptz not null default now(),
  primary key (account_id, operation_id)
);
