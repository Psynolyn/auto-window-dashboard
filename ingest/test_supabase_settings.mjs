// One-off test: insert a settings row into Supabase
// Usage (PowerShell):
//   cd ingest
//   node test_supabase_settings.mjs

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || 'public';
const SUPABASE_SETTINGS = process.env.SUPABASE_SETTINGS || 'settings';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in environment');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
  global: { headers: { 'x-application-name': 'window-telemetry-test' } },
  db: { schema: SUPABASE_SCHEMA }
});

// Compose a sample settings row
// Adjust these values if you want to test different inputs
const sample = {
  ts: new Date().toISOString(),
  threshold: 42, // percent open-at
  vent: true,
  auto: true,
  angle: 33 // degrees
};

try {
  const { data, error } = await supabase
    .from(SUPABASE_SETTINGS)
    .insert(sample)
    .select('*')
    .limit(1);

  if (error) {
    console.error('Insert failed:', error.message);
    process.exit(1);
  }

  console.log('Insert OK into', `${SUPABASE_SCHEMA}.${SUPABASE_SETTINGS}`);
  console.log('Row:', data?.[0] || sample);
  console.log('\nVerify in Supabase > Table Editor > settings (latest row)');
  process.exit(0);
} catch (e) {
  console.error('Unexpected error:', e);
  process.exit(1);
}
