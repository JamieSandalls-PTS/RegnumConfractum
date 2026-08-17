-- M4b: voluntary permadeath and Legacy Points (D-207, D-222).
-- Points live on the ACCOUNT — they buy access and flavour for future
-- characters, never raw power.

alter table accounts add column legacy_points bigint not null default 0;
alter table characters add column retired_at timestamptz;
-- Meaningful actions, not wall-clock: the anti-idle measure of a life lived.
alter table characters add column deeds bigint not null default 0;
