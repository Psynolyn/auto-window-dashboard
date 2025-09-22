# Supabase setup

Use this to create the database tables and safe access policies.

## Steps
1. Create a Supabase project at https://supabase.com/.
2. Open the SQL editor and paste/run `schema.sql` from this folder.
3. Get your Project URL and `service_role` key from Project Settings → API.
   - `service_role` is sensitive; never ship it to the frontend.
4. Verify RLS policies for `readings` and `settings` allow select for `anon`.

## Tables (recommended)
- `public.readings`: `ts, temperature, humidity`
- `public.settings`: `ts, threshold, vent, auto, angle`
Enable Realtime on these tables if you want push updates.

## Optional: Realtime
Enable Realtime on the tables you plan to stream to the frontend. Then use the anon key with supabase-js to subscribe.
