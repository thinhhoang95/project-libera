-- Registration codes: issued only by the server admin (`admin signup-code
-- create`). While sign-up is invitation-only (ALLOW_OPEN_SIGNUP off, the
-- default) a new account needs one. Only the hash is stored; the code is
-- printed once when it is created. Notebook invitations are separate and
-- never create accounts on their own.

create table registration_codes (
  id text primary key,
  code_hash text not null unique,
  note text,
  max_uses integer not null default 1 check (max_uses > 0),
  uses integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
