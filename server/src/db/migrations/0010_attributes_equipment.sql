-- Attributes, level-up spending, and the paperdoll (D-546, D-547).
--
-- Every column here is NULLABLE with no backfill, and that is the design
-- rather than laziness. `resolveAttributes` reads a null as a straight
-- 10/10/10/10 and `equipped_slot` null means "in the pack", so every
-- character and every item written before this migration reads back as
-- exactly the character and item the previous code produced. There is no
-- moment where an existing save is half-converted.
--
-- No column for MANA or MAX HP, for the same reason there is no column for
-- LEVEL (D-538): both are derived from attributes and worn gear on read, so
-- they cannot drift from the numbers that produced them. Current hp is
-- stored, because that is a fact about the character rather than a
-- calculation; the ceiling it is clamped against is not.

alter table characters
  -- Attribute TOTALS allocated at creation: {"strength": 14, ...}.
  add column if not exists attributes jsonb,
  -- What the player spent on the level-up screen: attributes, skills, feats,
  -- spells. Choices, not derivations — nothing can recompute these.
  add column if not exists advances jsonb;

alter table items
  -- Which paperdoll slot the item is worn in, or null for the pack. On the
  -- ITEM rather than a list on the character, so the two can never disagree
  -- about where a thing is. Every move (transfer, corpse, loot) clears it.
  add column if not exists equipped_slot text;

-- A character may not wear two things in one slot. Enforced in the database
-- rather than only in the gateway because the gateway is not the only writer:
-- looting, corpse moves and the round's strip all touch these rows, and a
-- duplicate slot would show up as a paperdoll with two swords in one hand
-- long before anyone found the code path that allowed it.
create unique index if not exists items_one_per_slot
  on items (owner_character_id, equipped_slot)
  where equipped_slot is not null and owner_character_id is not null;
