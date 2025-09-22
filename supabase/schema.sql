-- Supabase schema for dashboard telemetry
-- Run this in the Supabase SQL editor in your project

create table if not exists public.telemetry (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  temperature double precision,
  humidity double precision,
  angle double precision,
  motion boolean,
  threshold double precision,
  vent boolean,
  auto boolean,
  raw jsonb
);

-- If telemetry table existed before without ts, add and backfill it
alter table public.telemetry add column if not exists ts timestamptz;
alter table public.telemetry alter column ts set default now();
update public.telemetry set ts = now() where ts is null;
alter table public.telemetry alter column ts set not null;

-- Index for time-range queries
create index if not exists telemetry_ts_idx on public.telemetry (ts desc);

-- Enable Row Level Security
alter table public.telemetry enable row level security;

-- Policy: allow read-only for anon role (select only)
drop policy if exists "Anon can read telemetry" on public.telemetry;
create policy "Anon can read telemetry"
  on public.telemetry
  for select
  to anon
  using (true);

-- Policy: only service role can insert
-- In Supabase, service role bypasses RLS, so no explicit policy needed for inserts.
-- Optionally, allow authenticated users to insert (if you have auth), else keep restricted.

-- Commands table removed per current design (direct MQTT control + settings persistence)

-- Two-table design (optional): separate sensor readings and settings/state changes
create table if not exists public.readings (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  temperature double precision,
  humidity double precision
);
-- Ensure ts exists for pre-existing readings table, then backfill
alter table public.readings add column if not exists ts timestamptz;
alter table public.readings alter column ts set default now();
update public.readings set ts = now() where ts is null;
alter table public.readings alter column ts set not null;
create index if not exists readings_ts_idx on public.readings (ts desc);

create table if not exists public.settings (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  threshold double precision,
  vent boolean,
  auto boolean,
  angle double precision,
  max_angle double precision
);
-- Ensure ts exists for pre-existing settings table, then backfill
alter table public.settings add column if not exists ts timestamptz;
alter table public.settings alter column ts set default now();
update public.settings set ts = now() where ts is null;
alter table public.settings alter column ts set not null;
-- Ensure new dev-only setting column exists
alter table public.settings add column if not exists max_angle double precision;
create index if not exists settings_ts_idx on public.settings (ts desc);

alter table public.readings enable row level security;
alter table public.settings enable row level security;

drop policy if exists "Anon can read readings" on public.readings;
create policy "Anon can read readings"
  on public.readings
  for select
  to anon
  using (true);

drop policy if exists "Anon can read settings" on public.settings;
create policy "Anon can read settings"
  on public.settings
  for select
  to anon
  using (true);
