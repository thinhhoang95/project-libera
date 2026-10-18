-- Phase 4: updates detached from a document's log by the admin CLI
-- (`doc quarantine`). Rows keep every column of doc_updates so a range can be
-- examined, exported or put back by hand. The server never reads this table:
-- quarantined updates are gone from sync, history and reconstruction.

create table quarantined_updates (
  doc_id text not null references documents (id) on delete cascade,
  subdoc text not null check (subdoc in ('content', 'annotations', 'meta', 'manifest')),
  server_seq bigint not null,
  account_id text references accounts (id),
  client_id text not null,
  client_seq bigint not null,
  actor jsonb,
  provenance jsonb,
  update bytea not null,
  size integer not null,
  received_at timestamptz not null,
  -- One id per quarantine run, so a run can be found and undone together.
  quarantine_id text not null,
  -- 'range' for the requested range, 'dependent' for later updates that could
  -- not be integrated without it.
  reason text not null check (reason in ('range', 'dependent')),
  quarantined_at timestamptz not null default now(),
  primary key (doc_id, server_seq)
);
create index quarantined_updates_run_idx on quarantined_updates (quarantine_id);
