// Seed sample data into the `readings` table for graph testing
// Usage (PowerShell):
//   cd ingest
//   node seed_readings.mjs --minutes 60 --step 30
//   (defaults: 60 minutes, 30s step)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const TABLE = (process.env.SUPABASE_READINGS && process.env.SUPABASE_READINGS.trim()) || 'readings';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE. Configure them in ingest/.env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
  global: { headers: { 'x-application-name': 'window-telemetry-seeder' } },
});

// Parse CLI args
function arg(name, def) {
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return def;
}

const minutes = Number(arg('minutes', '60')); // how much history
const stepSec = Number(arg('step', '30'));    // seconds between points

if (!Number.isFinite(minutes) || !Number.isFinite(stepSec) || minutes <= 0 || stepSec <= 0) {
  console.error('Invalid args. Use --minutes <positive> --step <positive>');
  process.exit(1);
}

const now = Date.now();
const startTs = now - minutes * 60 * 1000;
const count = Math.floor((minutes * 60) / stepSec);

// Generate smooth synthetic data (light daily rhythm + noise)
function generatePoint(i) {
  const ts = startTs + i * stepSec * 1000;
  const t = i / count; // 0..1
  const tempBase = 24 + 2 * Math.sin(2 * Math.PI * t); // oscillate ~24±2
  const humBase = 55 + 8 * Math.cos(2 * Math.PI * t);  // oscillate ~55±8
  const temp = +(tempBase + (Math.random() - 0.5) * 0.6).toFixed(2);
  const hum = +(humBase + (Math.random() - 0.5) * 2.0).toFixed(1);
  return { ts: new Date(ts).toISOString(), temperature: temp, humidity: hum };
}

const rows = Array.from({ length: count }, (_, i) => generatePoint(i));

// Insert in batches to avoid large payloads
async function insertBatches(data, batchSize = 500) {
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const { error } = await supabase.from(TABLE).insert(batch);
    if (error) {
      console.error(`Insert error at batch ${i / batchSize}:`, error.message);
      process.exit(1);
    }
    console.log(`Inserted ${Math.min(i + batchSize, data.length)} / ${data.length}`);
  }
}

(async () => {
  console.log(`Seeding ${rows.length} rows into ${TABLE} spanning last ${minutes} minutes, step ${stepSec}s ...`);
  await insertBatches(rows);
  console.log('Done.');
})();
