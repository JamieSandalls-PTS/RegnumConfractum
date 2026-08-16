-- M3b: DM-authored events (D-216) — documents the form editor produces,
-- interpreted by the EventEngine. Doubles as the template library: any
-- event can be duplicated.
create table dm_events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  doc jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
