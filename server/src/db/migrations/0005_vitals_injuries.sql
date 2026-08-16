-- M4: vitals, death debt (D-203), and located/typed injuries (D-205).

alter table characters add column hp integer not null default 20;
alter table characters add column max_hp integer not null default 20;
alter table characters add column xp bigint not null default 0;
alter table characters add column death_debt bigint not null default 0 check (death_debt >= 0);

create table injuries (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references characters (id) on delete cascade,
  location text not null check (location in ('head', 'torso', 'arms', 'legs')),
  kind text not null check (kind in ('cut', 'pierce', 'blunt')),
  severity text not null check (severity in ('minor', 'major')),
  created_at timestamptz not null default now()
);
create index injuries_character on injuries (character_id);
