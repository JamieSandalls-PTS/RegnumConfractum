-- D-645: how a character presents themselves when they speak.
--
-- One JSONB document: the name spoken under a hood, the name spoken in
-- disguise, and which of real or disguise is in use. The real name is the
-- character's own `name` and is never duplicated here.
--
-- NULL, and nullable: every character that exists speaks under their real
-- name, exactly as a fresh one does, until they set something.
ALTER TABLE characters ADD COLUMN IF NOT EXISTS identity JSONB;
