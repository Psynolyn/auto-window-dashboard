// MQTT → Supabase bridge (Node 18+)
// Usage (PowerShell):
//   cd ingest
//   copy .env.example .env  # then edit values
//   node bridge.mjs

import 'dotenv/config';
import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || 'public';
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'telemetry'; // legacy single-table
const SUPABASE_READINGS = process.env.SUPABASE_READINGS || '';
const SUPABASE_SETTINGS = process.env.SUPABASE_SETTINGS || '';
const SETTINGS_CHANGE_DETECTION = (process.env.SETTINGS_CHANGE_DETECTION || 'true').toLowerCase() === 'true';

// Optional automated cleanup
const CLEANUP_ENABLED = (process.env.CLEANUP_ENABLED || 'false').toLowerCase() === 'true';
const CLEANUP_MODE = (process.env.CLEANUP_MODE || 'purge').toLowerCase(); // 'purge' or 'truncate'
const CLEANUP_PURGE_DAYS = Number(process.env.CLEANUP_PURGE_DAYS || '1');
const CLEANUP_TIME = process.env.CLEANUP_TIME || '00:00'; // HH:mm in server local time
const CLEANUP_TZ_OFFSET_MINUTES = Number(process.env.CLEANUP_TZ_OFFSET_MINUTES || '0'); // optional offset

const MQTT_URL = process.env.MQTT_URL || 'wss://broker.hivemq.com:8884/mqtt';
// Treat blank strings as undefined so public HiveMQ can be used without creds
const MQTT_USERNAME = (process.env.MQTT_USERNAME && process.env.MQTT_USERNAME.trim() !== '') ? process.env.MQTT_USERNAME : undefined;
const MQTT_PASSWORD = (process.env.MQTT_PASSWORD && process.env.MQTT_PASSWORD.trim() !== '') ? process.env.MQTT_PASSWORD : undefined;
const MQTT_TOPICS = (process.env.MQTT_TOPICS || 'home/dashboard/data,home/dashboard/window,home/dashboard/threshold,home/dashboard/vent,home/dashboard/auto')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in environment');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
  global: { headers: { 'x-application-name': 'window-telemetry-bridge' } },
  db: { schema: SUPABASE_SCHEMA }
});

const client = mqtt.connect(MQTT_URL, {
  clientId: `bridge_${Math.random().toString(16).slice(2)}`,
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  clean: true,
  protocolVersion: 5,
  reconnectPeriod: 2000
});

client.on('connect', () => {
  console.log('MQTT connected');
  for (const t of MQTT_TOPICS) {
    client.subscribe(t, (err, granted) => {
      if (err) console.error('Subscribe error for', t, err.message || err);
      else console.log('Subscribed to', granted?.map?.(g => `${g.topic}@qos${g.qos}`).join(', ') || t);
    });
  }
});

client.on('reconnect', () => console.log('MQTT reconnecting...'));
client.on('error', (err) => console.error('MQTT error', err));
client.on('close', () => console.log('MQTT connection closed'));

// keep track of last settings to avoid duplicate rows if enabled
let lastSettings = { threshold: undefined, vent: undefined, auto: undefined, angle: undefined, max_angle: undefined };

client.on('message', async (topic, message) => {
  console.log(`Received message on ${topic}:`, message.toString());
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) {
    console.warn('Non-JSON payload on', topic);
    return;
  }
  console.log('Parsed payload:', payload);

  // Normalize known fields
  const temperature = payload.temperature ?? undefined;
  const humidity = payload.humidity ?? undefined;
  const angleRaw = (payload.windowAngle ?? payload.angle);
  const isFinal = (payload.final === true);
  const threshold = payload.threshold;
  const vent = payload.vent;
  const auto = payload.auto;
  const max_angle = payload.max_angle; // dev-only setting
  const fromBridge = payload.source === 'bridge';

  // Clamp angle against last known max_angle if provided
  const currentMax = (typeof lastSettings.max_angle === 'number') ? lastSettings.max_angle : undefined;
  const angle = (angleRaw !== undefined)
    ? (currentMax !== undefined ? Math.min(Number(angleRaw), Number(currentMax)) : Number(angleRaw))
    : undefined;

  // Two-table mode: write readings and settings separately if configured
  if (SUPABASE_READINGS || SUPABASE_SETTINGS) {
    // readings
    if (temperature !== undefined || humidity !== undefined) {
      const { error } = await supabase
        .from(SUPABASE_READINGS || 'readings')
        .insert({ ts: new Date().toISOString(), temperature: temperature ?? null, humidity: humidity ?? null });
      if (error) console.error('Insert readings error:', error.message);
    }
    // settings (only when present, and optionally only on change)
    const settingsCandidate = {
      threshold: threshold ?? undefined,
      vent: vent ?? undefined,
      auto: auto ?? undefined,
      max_angle: max_angle ?? undefined,
      // Only persist angle when final=true to limit DB writes
      angle: (angle !== undefined && isFinal) ? angle : undefined
    };
    // If this is an angle-only transient message (final=false), skip DB entirely
    if (angle !== undefined && !isFinal && threshold === undefined && vent === undefined && auto === undefined) {
      return;
    }
    const hasAny = Object.values(settingsCandidate).some(v => v !== undefined);
    if (hasAny) {
      let shouldWrite = true;
      if (SETTINGS_CHANGE_DETECTION) {
        shouldWrite = ['threshold','vent','auto','angle','max_angle'].some(k => settingsCandidate[k] !== undefined && settingsCandidate[k] !== lastSettings[k]);
      }
      if (shouldWrite) {
        console.log('Writing settings to DB:', settingsCandidate);
        const table = SUPABASE_SETTINGS || 'settings';
        // Only include provided fields to avoid overwriting others with nulls
        const updates = { ts: new Date().toISOString() };
        if (threshold !== undefined) updates.threshold = threshold ?? null;
        if (vent !== undefined) updates.vent = vent ?? null;
        if (auto !== undefined) updates.auto = auto ?? null;
        if (max_angle !== undefined) updates.max_angle = max_angle ?? null;
        // Only include angle when it's a final publish
        if (settingsCandidate.angle !== undefined) updates.angle = settingsCandidate.angle ?? null;
        console.log('Updates to apply:', updates);

        // Update the latest settings row; if none exists, insert once
        const { data: existing, error: selErr } = await supabase
          .from(table)
          .select('id')
          .order('ts', { ascending: false })
          .limit(1);
        if (selErr) {
          console.error('Select settings error:', selErr.message);
        }
        if (existing && existing.length) {
          const id = existing[0].id;
          const { error: updErr } = await supabase
            .from(table)
            .update(updates)
            .eq('id', id);
          if (updErr) console.error('Update settings error:', updErr.message);
          else console.log('Updated settings row id', id);
        } else {
          const { error: insErr } = await supabase
            .from(table)
            .insert(updates);
          if (insErr) console.error('Insert settings error:', insErr.message);
          else console.log('Inserted new settings row');
        }
  lastSettings = { ...lastSettings, ...settingsCandidate };
      }

      // If a dev publishes max_angle, also broadcast it to a dedicated topic for devices
      if (max_angle !== undefined) {
        try {
          client.publish('home/dashboard/max_angle', JSON.stringify({ max_angle, source: 'bridge' }));
          console.log('Published max_angle to MQTT:', max_angle);
        } catch (e) {
          console.warn('Failed to publish max_angle', e?.message || e);
        }
      }
    }
  } else {
    // Legacy single-table mode
    const row = {
      ts: new Date().toISOString(),
      temperature: temperature ?? null,
      humidity: humidity ?? null,
      angle: angle ?? null,
      motion: payload.motion ?? null,
      threshold: threshold ?? null,
      vent: vent ?? null,
      auto: auto ?? null,
      raw: payload
    };
  const { error } = await supabase.from(SUPABASE_TABLE).insert(row);
    if (error) console.error('Supabase insert error:', error.message);
  }

  // If angle was clamped and this message did not originate from the bridge, publish corrected angle
  if (angleRaw !== undefined && angle !== undefined && angle < Number(angleRaw) && !fromBridge) {
    const corrected = { angle, final: isFinal, source: 'bridge', clamped: true };
    try {
      client.publish('home/dashboard/window', JSON.stringify(corrected));
      console.log('Published clamped angle to MQTT:', corrected);
    } catch (e) {
      console.warn('Failed to publish clamped angle', e?.message || e);
    }
  }
});

// Commands feature removed per current design

// -----------------------------
// Optional: Daily cleanup job
// -----------------------------
async function runCleanupIfDue() {
  if (!CLEANUP_ENABLED) return;
  try {
    const now = new Date();
    // Apply optional timezone offset (minutes) for scheduling
    const sched = new Date(now.getTime() + CLEANUP_TZ_OFFSET_MINUTES * 60_000);
    const [hh, mm] = CLEANUP_TIME.split(':').map(s => Number(s));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return;
    const key = sched.toISOString().slice(0, 10); // YYYY-MM-DD (in offset-adjusted day)
    global.__cleanupLastRunKey = global.__cleanupLastRunKey || null;
    // Only run once per effective day and only after the scheduled time has passed
    const hasPassed = (sched.getHours() > hh) || (sched.getHours() === hh && sched.getMinutes() >= mm);
    if (!hasPassed) return;
    if (global.__cleanupLastRunKey === key) return;

    console.log(`[cleanup] Running daily cleanup (${CLEANUP_MODE}) at ${now.toISOString()} (sched key ${key})`);
    if (CLEANUP_MODE === 'truncate') {
      // Prefer a database function that performs TRUNCATE (resets identity and indexes efficiently)
      try {
        const { error } = await supabase.rpc('truncate_readings_daily');
        if (error) {
          console.warn('[cleanup] RPC truncate_readings_daily failed:', error.message);
          console.warn('[cleanup] Falling back to purge delete of all rows. Consider creating the SQL function and using pg_cron.');
          // Fallback: delete all rows (won't reset identity)
          if (SUPABASE_READINGS) {
            await supabase.from(SUPABASE_READINGS).delete().neq('id', null);
          } else {
            await supabase.from('readings').delete().neq('id', null);
          }
        }
      } catch (e) {
        console.warn('[cleanup] RPC truncate exception:', e?.message || e);
      }
    } else {
      // Purge older than N days from readings (two-table) or telemetry as a fallback
      const cutoffIso = new Date(Date.now() - CLEANUP_PURGE_DAYS * 24 * 60 * 60_000).toISOString();
      try {
        if (SUPABASE_READINGS) {
          const { error } = await supabase.from(SUPABASE_READINGS).delete().lt('ts', cutoffIso);
          if (error) console.warn('[cleanup] readings purge error:', error.message);
        } else {
          // Try readings table by name anyway
          const { error: e1 } = await supabase.from('readings').delete().lt('ts', cutoffIso);
          if (e1) {
            // fallback to telemetry
            const { error: e2 } = await supabase.from(SUPABASE_TABLE).delete().lt('ts', cutoffIso);
            if (e2) console.warn('[cleanup] telemetry purge error:', e2.message);
          }
        }
      } catch (e) {
        console.warn('[cleanup] purge exception:', e?.message || e);
      }
    }
    // mark run for this day-key
    global.__cleanupLastRunKey = key;
  } catch (e) {
    console.warn('[cleanup] scheduler exception:', e?.message || e);
  }
}

if (CLEANUP_ENABLED) {
  console.log(`[cleanup] Daily cleanup enabled: mode=${CLEANUP_MODE}, time=${CLEANUP_TIME}, purgeDays=${CLEANUP_PURGE_DAYS}`);
  // Check every 30 seconds
  setInterval(runCleanupIfDue, 30_000);
}
