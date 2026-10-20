-- Device sign-in grants: let another computer of the same person start its
-- own session without the password. The desktop app keeps the grant in a
-- file in the person's synced data folder, encrypted with their Libera master
-- password. A grant is not a refresh token: it never rotates, so several
-- computers can hold copies, and each exchange starts a new refresh family.
-- Only the hash is stored. Changing the password revokes every grant.

create table device_grants (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  token_hash text not null unique,
  device_name text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index device_grants_account on device_grants (account_id) where revoked_at is null;
