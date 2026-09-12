-- The town's stores are a real place to put things (D-529, D-530, built D-580).
--
-- D-530 ruled that pooling goods at a facility is more potent than carrying
-- them, and never required — "it should not be *required* to store items
-- there... Items placed there, and 'used' from there should be more potent."
-- That needs somewhere for the goods to actually BE. Until now the storehouse
-- gave a bonus for eating beside it out of your own pack, which is the flavour
-- of the rule without the substance: nothing was ever pooled, so nothing could
-- be hoarded, denied, or spoiled.
--
-- A store is the THIRD owner an item can have, beside a character and a corpse.
-- Modelling it as an owner rather than as a list on the station is what keeps
-- the no-duplication invariant intact for free: an item is in exactly one
-- place, and depositing is a move, never a copy (D-114).
--
-- The key is `<areaId>:<stationType>` — the TOWN's stores, not one sack. Two
-- storehouses in one area would share a pool, which is the right reading of
-- "the common stores" and stops a cast splitting its goods across furniture.
alter table items add column owner_store text;
create index items_owner_store on items (owner_store) where owner_store is not null;

-- ⚠ The one-owner check is EXTENDED, not dropped and forgotten. It is the
-- constraint that makes "an item is in exactly one place" a database
-- guarantee rather than a habit of the gateway, and the gateway is not the
-- only writer (D-547).
alter table items drop constraint items_one_owner;
alter table items add constraint items_one_owner
  check (num_nonnulls(owner_character_id, owner_corpse_id, owner_store) = 1);
