-- M0 schema (D-106). Postgres is the source of truth.

create table accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  pass_hash text not null,
  created_at timestamptz not null default now()
);
create unique index accounts_username_lower on accounts (lower(username));

create table sessions (
  token text primary key,
  account_id uuid not null references accounts (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table characters (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  name text not null,
  appearance_seed bigint not null,
  area_id text not null,
  x integer not null,
  y integer not null,
  coin bigint not null default 0 check (coin >= 0),
  created_at timestamptz not null default now()
);
create unique index characters_name_lower on characters (lower(name));
create index characters_account on characters (account_id);

create table items (
  id uuid primary key default gen_random_uuid(),
  template_id text not null,
  owner_character_id uuid not null references characters (id),
  qty integer not null default 1 check (qty > 0),
  created_at timestamptz not null default now()
);
create index items_owner on items (owner_character_id);

-- Append-only event log, from day one (D-106). Moderation is an evidence
-- problem before it is a policy problem; the trigger makes append-only a
-- database guarantee rather than a convention.
create table event_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  type text not null,
  data jsonb not null default '{}'::jsonb
);
create index event_log_type_at on event_log (type, at);

create function event_log_append_only() returns trigger as $$
begin
  raise exception 'event_log is append-only (D-106)';
end;
$$ language plpgsql;

create trigger event_log_no_mutation
  before update or delete on event_log
  for each row execute function event_log_append_only();
