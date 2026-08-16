-- M2: recognition and skill contests (D-218, D-219).

alter table characters add column bluff integer not null default 10;
alter table characters add column insight integer not null default 10;

-- What an observer knows about a subject in a given presentation state.
-- The unit of recognition is the OBSERVED IDENTITY (character × presentation),
-- not the character (D-219). Piercing a disguise later merges rows for the
-- same subject onto the 'normal' presentation.
create table identity_knowledge (
  observer_character_id uuid not null references characters (id) on delete cascade,
  subject_character_id uuid not null references characters (id) on delete cascade,
  presentation text not null default 'normal',
  known_name text,
  provenance text not null check (provenance in ('self_claimed', 'third_party', 'verified')),
  impression text check (impression in ('rings_false', 'certain_false')),
  updated_at timestamptz not null default now(),
  primary key (observer_character_id, subject_character_id, presentation)
);
create index identity_knowledge_subject on identity_knowledge (subject_character_id);
