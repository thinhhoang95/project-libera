-- A command id is claimed (status null) before its handler runs, so a duplicate
-- submission cannot apply the effect twice. The receipt fills status and result.
alter table commands alter column status drop not null;
alter table commands add column claimed_at timestamptz not null default now();
