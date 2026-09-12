-- The starting kit is granted once per character per round (D-547), and until
-- now that was remembered in a Set in the gateway's memory.
--
-- A server restart forgot it, so the next login granted a second kit -- and a
-- third, and a fourth. That is item duplication, which invariant 2 and D-114
-- both forbid, and it was invisible: the only symptom was a character
-- accumulating gear across restarts, plus a constraint violation the first
-- time two kits tried to claim the same equipment slot.
--
-- Cleared for everybody when a round resets, which is also where gear is
-- stripped (D-522) -- the two belong together and now happen together.
alter table characters
  add column if not exists kit_granted boolean not null default false;
