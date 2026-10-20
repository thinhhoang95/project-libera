-- Writer leases for synced notebook folders. Several Libera installations of
-- one account can see the same shared-notebook folder (OneDrive and the
-- like); only the installation holding the folder's lease writes it, the
-- others follow through the CRDT. A lease expires unless renewed, so the
-- writing role moves on when its holder goes offline.

create table folder_leases (
  project_id text not null references projects (id) on delete cascade,
  account_id text not null references accounts (id) on delete cascade,
  -- The folder's identity: a random id kept in its marker file.
  folder_id text not null,
  -- The installation that writes the folder.
  holder text not null,
  expires_at timestamptz not null,
  -- When another installation last asked for the lease while it was held:
  -- the folder is seen by more than one installation.
  contended_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (project_id, account_id, folder_id)
);
