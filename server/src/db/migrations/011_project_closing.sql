-- Set while the owner takes a project down: the project stops accepting
-- document updates and comment writes, so the owner's final export of text,
-- PDF marks and comments cannot miss a late change. Cleared if the takedown is
-- abandoned; the project row disappears with a completed one.
alter table projects add column closing_at timestamptz;
