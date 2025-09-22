# MQTT → Supabase bridge

Node script that listens to your MQTT topics and stores messages into Supabase.

## Prereqs
- Node 18+
- A Supabase project (URL + service_role key)

## Install
```powershell
cd ingest
copy .env.example .env
npm install
```

Edit `.env` and set:
```env
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE=YOUR_SERVICE_ROLE
MQTT_URL=wss://broker.hivemq.com:8884/mqtt
MQTT_TOPICS=home/dashboard/data,home/dashboard/window,home/dashboard/threshold,home/dashboard/vent,home/dashboard/auto
```

## Run
```powershell
# In PowerShell
$env:SUPABASE_URL = "https://YOUR-PROJECT.supabase.co"; \
$env:SUPABASE_SERVICE_ROLE = "YOUR_SERVICE_ROLE"; \
$env:MQTT_URL = "wss://broker.hivemq.com:8884/mqtt"; \
$env:MQTT_TOPICS = "home/dashboard/data,home/dashboard/window"; \
node bridge.mjs
```

Or load from .env:
```powershell
node bridge.mjs
```

## What gets stored
Each message becomes a row in `public.telemetry` with normalized columns and the full `raw` JSON.

If you enable two-table mode (`readings` + `settings`):
- Temperature/humidity go to `public.readings`.
- `threshold`, `vent`, `auto`, `angle` go to `public.settings` (only when provided; with optional change detection).

Dev-only setting:
- `max_angle` can be published to `public.settings` to restrict the maximum angle used by devices. The frontend does not surface this; it is intended for developer use via MQTT and bridge persistence.

## Security notes
- Keep `service_role` only on the server/bridge. Do not expose it in the frontend.
- Frontend should use the `anon` key for read-only access.

<!-- Commands feature removed per current design -->

## Two-table mode
Set in `.env`:
```
SUPABASE_READINGS=readings
SUPABASE_SETTINGS=settings
SETTINGS_CHANGE_DETECTION=true
```

Example fetch (last hour) in SQL:
```
select ts, temperature, humidity
from public.readings
where ts >= now() - interval '60 minutes'
order by ts desc
limit 5000;
```

## Automated daily cleanup

You can automate trimming the `readings` table either server-side (recommended) or via the Node bridge (quick and simple):

Option A — Server-side (pg_cron) recommended
1) In Supabase SQL editor:
```sql
create extension if not exists pg_cron;

-- Option A1: Truncate daily (resets identity)
create or replace function public.truncate_readings_daily()
returns void language plpgsql as $$
begin
  truncate table public.readings restart identity;
  analyze public.readings;
end $$;

select cron.schedule(
  'daily_truncate_readings',
  '0 0 * * *',  -- midnight UTC
  $$select public.truncate_readings_daily();$$
);

-- Option A2: Purge older than 1 day (keeps last 24h)
create or replace function public.purge_readings_older_than_1d()
returns void language plpgsql as $$
begin
  delete from public.readings where ts < now() - interval '1 day';
  analyze public.readings;
end $$;

select cron.schedule(
  'daily_purge_readings_1d',
  '0 0 * * *',
  $$select public.purge_readings_older_than_1d();$$
);
```

Option B — Bridge-based scheduler (no DB cron required)
1) In `ingest/.env`, set:
```env
CLEANUP_ENABLED=true
# 'purge' Deletes older than CLEANUP_PURGE_DAYS; 'truncate' calls RPC truncate_readings_daily
CLEANUP_MODE=purge
CLEANUP_PURGE_DAYS=1
CLEANUP_TIME=00:00
# Optional timezone offset in minutes if your server time differs
CLEANUP_TZ_OFFSET_MINUTES=0
```
2) If using `truncate` mode, create the RPC first (Option A1 function above). The bridge will call `rpc('truncate_readings_daily')` once a day.

Notes
- TRUNCATE is fastest and resets identity; use only if you don’t need history.
- PURGE keeps a rolling 24h window by default; adjust `CLEANUP_PURGE_DAYS` as needed.
- For high churn, Postgres autovacuum handles index bloat; manual VACUUM/REINDEX is rarely necessary.

## Dev test publisher

You can publish a settings payload to validate the end-to-end path:

```powershell
# From ingest/
node publish_test_settings.mjs
```

To include a dev-only `max_angle` setting (not used by the frontend), set an env var:

```powershell
$env:TEST_MAX_ANGLE=120; node publish_test_settings.mjs
```

The bridge will persist `max_angle` to the `settings` table when provided.
