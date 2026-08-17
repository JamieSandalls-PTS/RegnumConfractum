-- Spirit interactions (D-204/D-224, limits ratified in D-511) and the class
-- roster (D-208/D-511).
--
-- Corpses are world objects that can hold a dead player's gear. Item
-- ownership therefore becomes one-of: a character OR a corpse. The corpse
-- row persists across restarts; ticks_left is the countdown remaining in the
-- current state at last write, and the server resumes it on boot (erring
-- long, never short — the one-clock rule keeps wall time out of game logic).

alter table characters add column class_id text;
alter table characters add column necromancy integer not null default 0;

create table corpses (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references characters (id),
  area_id text not null,
  x integer not null,
  y integer not null,
  -- corpse: lying where they fell        animated: walking (D-224)
  -- ground: decayed, gear on the floor   gone: cleaned up
  state text not null default 'corpse'
    check (state in ('corpse', 'animated', 'ground', 'gone')),
  ticks_left integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index corpses_active on corpses (state) where state <> 'gone';

alter table items alter column owner_character_id drop not null;
alter table items add column owner_corpse_id uuid references corpses (id);
create index items_owner_corpse on items (owner_corpse_id)
  where owner_corpse_id is not null;
alter table items add constraint items_one_owner
  check (num_nonnulls(owner_character_id, owner_corpse_id) = 1);
