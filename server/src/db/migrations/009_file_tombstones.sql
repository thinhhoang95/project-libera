-- Stable file identities remain retired independently of document kind or path.
create table file_tombstones (
  project_id text not null references projects(id) on delete cascade,
  file_id text not null,
  deleted_at timestamptz not null default now(),
  primary key (project_id, file_id)
);
