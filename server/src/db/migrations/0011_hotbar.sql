-- The hotbar, saved to the CHARACTER (D-553).
--
-- It lived in localStorage, which meant one bar shared by every character on
-- the machine and none of it following the player to another browser. A
-- hotbar is part of how a character is played — a physician's bar and a
-- berserker's are not the same bar — so it belongs beside the build.
--
-- Nullable with no backfill: null means "the defaults", which is exactly what
-- an existing character had.
alter table characters
  add column if not exists hotbar jsonb;
