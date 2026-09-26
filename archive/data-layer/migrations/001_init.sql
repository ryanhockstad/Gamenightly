-- GameNightly MVP data model. See "GameNight/Archive/Game Night — MVP Data Model.md" (Drive).

create extension if not exists btree_gist;

create type session_status as enum ('collecting', 'confirmed', 'canceled');
create type notification_type as enum ('created', 'all_responded', 'confirmed', 'reminder', 'rescheduled', 'canceled');

create table sessions (
  id                    uuid primary key default gen_random_uuid(),
  public_slug           text unique not null,
  organizer_token_hash  text not null,
  title                 text not null,
  game                  text null,
  duration_minutes      smallint not null default 120 check (duration_minutes between 30 and 720),
  -- Organizer picks dates plus a daily "no earlier than" / "no later than" window (their zone).
  -- latest_minute <= earliest_minute means the window runs past midnight (equal = 24 hours).
  dates                 date[] not null check (cardinality(dates) between 1 and 14),
  earliest_minute       smallint not null default 1020 check (earliest_minute between 0 and 1439), -- 5:00 PM
  latest_minute         smallint not null default 120 check (latest_minute between 0 and 1439),    -- 2:00 AM
  -- Derived from the windows: start of the first, end of the last. Bounds matching and expiry.
  search_start_utc      timestamptz not null,
  search_end_utc        timestamptz not null,
  organizer_timezone    text not null,
  slot_step_minutes     smallint not null default 30 check (slot_step_minutes > 0),
  max_participants      smallint not null default 4 check (max_participants between 2 and 4),
  discord_webhook_url_enc bytea null,
  status                session_status not null default 'collecting',
  confirmed_start_utc   timestamptz null,
  confirmed_end_utc     timestamptz null,
  expires_at            timestamptz not null, -- set by trigger
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint search_range_valid check (
    search_end_utc > search_start_utc
    -- Dates span at most 14 calendar days (checked in app); windows past midnight and DST add up to a day.
    and search_end_utc - search_start_utc <= interval '15 days'
  ),
  constraint confirmed_times_match_status check (
    (status <> 'confirmed' or confirmed_start_utc is not null)
    and (status <> 'collecting' or confirmed_start_utc is null)
    and (confirmed_start_utc is null) = (confirmed_end_utc is null)
    and (confirmed_end_utc is null or confirmed_end_utc > confirmed_start_utc)
  )
);

-- expires_at = later of search_end_utc / confirmed_end_utc, plus 30 days.
-- Kept in a trigger so every write path maintains it.
create function sessions_before_write() returns trigger language plpgsql as $$
begin
  new.expires_at := greatest(new.search_end_utc, coalesce(new.confirmed_end_utc, new.search_end_utc)) + interval '720 hours'; -- exact 30 days; '30 days' shifts with the server TZ across DST
  new.updated_at := now();
  return new;
end $$;

create trigger sessions_before_write
  before insert or update on sessions
  for each row execute function sessions_before_write();

create table participants (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions on delete cascade,
  display_name    text not null check (char_length(display_name) between 1 and 32),
  timezone        text not null,
  edit_token_hash text not null,
  is_organizer    boolean not null default false,
  responded_at    timestamptz null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (session_id, id) -- target for the composite fk below
);

create unique index participants_session_name_uniq on participants (session_id, lower(display_name));
create unique index participants_one_organizer on participants (session_id) where is_organizer;

create table availability_blocks (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid not null,
  session_id     uuid not null references sessions on delete cascade,
  period         tstzrange not null check (not isempty(period) and lower_inc(period) and not upper_inc(period)),
  -- Composite fk keeps the denormalized session_id consistent with the participant's.
  foreign key (session_id, participant_id) references participants (session_id, id) on delete cascade,
  exclude using gist (participant_id with =, period with &&)
);

create index availability_blocks_session on availability_blocks (session_id);

create table notification_outbox (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions on delete cascade,
  type          notification_type not null,
  scheduled_for timestamptz not null,
  sent_at       timestamptz null,
  canceled_at   timestamptz null,
  attempts      smallint not null default 0,
  last_error    text null,
  unique (session_id, type, scheduled_for)
);

create index notification_outbox_pending on notification_outbox (scheduled_for)
  where sent_at is null and canceled_at is null;
