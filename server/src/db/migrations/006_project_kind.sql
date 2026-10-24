-- Shared albums: a project shares either a notebook (documents and files) or
-- a gallery album (a flat folder of photos). Existing projects are notebooks.

alter table projects add column kind text not null default 'notebook' check (kind in ('notebook', 'album'));
