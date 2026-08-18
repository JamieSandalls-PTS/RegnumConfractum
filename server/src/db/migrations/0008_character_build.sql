-- Character creation build (D-208): skills allocated at creation, plus the
-- feats and spells chosen. Skills are a JSONB map so adding a skill is a
-- content change, not a migration.
--
-- The pre-existing bluff / insight / necromancy columns STAY: every mechanic
-- already written reads them (contests in D-218, the zombie cap in D-511).
-- Creation mirrors those three out of the skills map into their columns, so
-- there is exactly one source of truth per mechanic and no code that reads
-- them needs to change.

alter table characters
  add column if not exists skills jsonb not null default '{}'::jsonb,
  add column if not exists feats  jsonb not null default '[]'::jsonb,
  add column if not exists spells jsonb not null default '[]'::jsonb;
