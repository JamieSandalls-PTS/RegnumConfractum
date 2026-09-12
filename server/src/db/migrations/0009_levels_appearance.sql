-- Authored appearance (D-539). A sparse JSONB override on top of the seed:
-- null means "exactly what the seed generates", which is what every
-- character created before the appearance step existed should keep looking
-- like. Storing the override rather than a whole appearance also means a
-- field added to Appearance later is inherited from the seed by everyone
-- rather than defaulting to something wrong.
--
-- No column for LEVEL (D-538). Level is derived from xp on read, so it can
-- never disagree with the xp that produced it — the classic dual-write bug
-- in every game that stores both.

alter table characters
  add column if not exists appearance jsonb;
