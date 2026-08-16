-- M2: languages and in-world writing.

alter table characters add column languages text[] not null default '{common}';

-- Written items carry their words with them (title, text). Coordinates as a
-- physical item (D-213) will ride the same column later.
alter table items add column data jsonb;
