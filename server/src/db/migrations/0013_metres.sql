-- D-567: positions are metres, not tile indices.
--
-- The world moved from an integer grid to a continuous coordinate system, so
-- every stored position is now a real number. Left as `integer`, Postgres
-- rounds on write: a character logs out at 12.4 and wakes at 12, and a corpse
-- drifts half a metre every time it is persisted. Silent, and impossible to
-- spot in play.
--
-- Widening is lossless in the other direction -- every existing row holds a
-- whole number and keeps it -- so there is nothing to backfill.
alter table characters alter column x type double precision;
alter table characters alter column y type double precision;

alter table corpses alter column x type double precision;
alter table corpses alter column y type double precision;
