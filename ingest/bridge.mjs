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
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'telemetry'; // legacy single-table fallback
// Two-table mode defaults ON: if env vars omitted/blank we still use 'readings' and 'settings'
const SUPABASE_READINGS = (process.env.SUPABASE_READINGS === undefined)
  ? 'readings'
  : (process.env.SUPABASE_READINGS || 'readings');
const SUPABASE_SETTINGS = (process.env.SUPABASE_SETTINGS === undefined)
  ? 'settings'
  : (process.env.SUPABASE_SETTINGS || 'settings');
// Allow forcing legacy single-table mode explicitly
const LEGACY_SINGLE_TABLE = (process.env.LEGACY_SINGLE_TABLE || '').toLowerCase() === 'true';
const SETTINGS_CHANGE_DETECTION = (process.env.SETTINGS_CHANGE_DETECTION || 'true').toLowerCase() === 'true';
// Optional: log full inbound payload & full settings candidate each time (diagnostics)
const FULL_SETTINGS_LOG = (process.env.FULL_SETTINGS_LOG || 'false').toLowerCase() === 'true';
// Optional: publish a consolidated full settings snapshot (retained) whenever any setting changes
// Topic: home/dashboard/settings_snapshot
const PUBLISH_SETTINGS_SNAPSHOT = (process.env.PUBLISH_SETTINGS_SNAPSHOT || 'false').toLowerCase() === 'true';
// Debounce threshold DB writes: allow live MQTT updates but write after release (ms)
const THRESHOLD_DB_DEBOUNCE_MS = Number(process.env.THRESHOLD_DB_DEBOUNCE_MS || '2000');
// Optional: hide/suppress sensor flags payload logs (keep console clean)
const LOG_SENSOR_FLAGS = (process.env.LOG_SENSOR_FLAGS || 'false').toLowerCase() === 'true';
// Optional: publish per-flag topics for sensors, similar to other settings (retained)
// Topics: home/dashboard/dht11_enabled, home/dashboard/water_enabled, home/dashboard/hw416b_enabled
const PUBLISH_SENSOR_FLAGS_TOPICS = (process.env.PUBLISH_SENSOR_FLAGS_TOPICS || 'false').toLowerCase() === 'true';

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
let MQTT_TOPICS = (process.env.MQTT_TOPICS || 'home/dashboard/data,home/dashboard/window,home/dashboard/threshold,home/dashboard/vent,home/dashboard/auto,home/dashboard/graphRange,home/dashboard/sensors')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// Always ensure we subscribe to the settings/get topic for snapshot requests
if (!MQTT_TOPICS.includes('home/dashboard/settings/get')) MQTT_TOPICS.push('home/dashboard/settings/get');
// Helper: publish a consolidated settings snapshot (retained)
async function publishSettingsSnapshot(reason = 'change') {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_SETTINGS || 'settings')
      .select('*')
      .order('ts', { ascending: false })
      .limit(1);
    if (error) { console.error('Snapshot select error:', error.message); return; }
    const row = (data && data[0]) || {};
    // Coerce max_angle to a finite number when possible. Prefer DB value, fall back to lastSettings or 180.
    let computedMaxAngle;
    if (row.max_angle === null || row.max_angle === undefined) {
      computedMaxAngle = (typeof lastSettings.max_angle === 'number') ? lastSettings.max_angle : 180;
    } else {
      const n = Number(row.max_angle);
      computedMaxAngle = Number.isFinite(n) ? n : ((typeof lastSettings.max_angle === 'number') ? lastSettings.max_angle : 180);
    }
    // Refresh lastSettings from DB (max_angle is read-only and comes from DB)
    lastSettings = {
      threshold: row.threshold ?? null,
      vent: !!row.vent,
      auto: !!row.auto,
      angle: (row.angle === null || row.angle === undefined) ? null : Number(row.angle),
      max_angle: computedMaxAngle,
      graph_range: row.graph_range ?? 'live',
      dht11_enabled: row.dht11_enabled ?? true,
      water_enabled: row.water_enabled ?? true,
      hw416b_enabled: row.hw416b_enabled ?? true
    };
    const snapshot = {
      ...lastSettings,
      ts: new Date().toISOString(),
      source: 'bridge'
    };
    client.publish('home/dashboard/settings_snapshot', JSON.stringify(snapshot), { retain: true });
    client.publish('home/dashboard/settings', JSON.stringify(snapshot), { retain: false });
    // max_angle is read-only and only present in the snapshot; do not publish it as a separate topic
    console.log(`[snapshot] published (${reason}) and sent grouped settings to home/dashboard/settings`);
  } catch (e) {
    console.error('Snapshot publish error:', e.message || e);
  }
}

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
  reconnectPeriod: 2000,
  // Set Last Will Testament so bridge status goes to "offline" if bridge disconnects unexpectedly
  will: { topic: 'home/dashboard/bridge_status', payload: 'offline', qos: 0, retain: true }
});

client.on('connect', () => {
  console.log('MQTT connected');
  // Publish bridge online status (retained) so dashboards know bridge is running
  try {
    client.publish('home/dashboard/bridge_status', 'online', { qos: 0, retain: true });
    console.log('Published bridge status: online');
  } catch (e) {
    console.warn('Failed to publish bridge status', e?.message || e);
  }
  // Subscribe to ping topic for active liveness checks
  client.subscribe('home/dashboard/bridge_ping', (err) => {
    if (err) console.error('Subscribe error for bridge_ping', err.message || err);
    else console.log('Subscribed to home/dashboard/bridge_ping');
  });
  for (const t of MQTT_TOPICS) {
    client.subscribe(t, (err, granted) => {
      if (err) console.error('Subscribe error for', t, err.message || err);
      else console.log('Subscribed to', granted?.map?.(g => `${g.topic}@qos${g.qos}`).join(', ') || t);
    });
  }
  // Ensure sensors topic subscribed even if not present in env list
  if (!MQTT_TOPICS.includes('home/dashboard/sensors')) {
    client.subscribe('home/dashboard/sensors', (err) => {
      if (err) console.error('Subscribe error for sensors topic', err.message || err);
      else console.log('Subscribed to home/dashboard/sensors (explicit)');
    });
  }
});

client.on('reconnect', () => console.log('MQTT reconnecting...'));
client.on('error', (err) => console.error('MQTT error', err));
client.on('close', () => console.log('MQTT connection closed'));

// Gracefully publish offline status when bridge shuts down
process.on('SIGINT', () => {
  console.log('Bridge shutting down...');
  try {
    client.publish('home/dashboard/bridge_status', 'offline', { qos: 0, retain: true }, () => {
      client.end();
      process.exit(0);
    });
    // Fallback timeout in case publish doesn't complete
    setTimeout(() => {
      client.end();
      process.exit(0);
    }, 1000);
  } catch (e) {
    client.end();
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  console.log('Bridge terminating...');
  try {
    client.publish('home/dashboard/bridge_status', 'offline', { qos: 0, retain: true }, () => {
      client.end();
      process.exit(0);
    });
    setTimeout(() => {
      client.end();
      process.exit(0);
    }, 1000);
  } catch (e) {
    client.end();
    process.exit(0);
  }
});

// keep track of last settings to avoid duplicate rows if enabled
let lastSettings = { threshold: undefined, vent: undefined, auto: undefined, angle: undefined, max_angle: undefined, graph_range: undefined, dht11_enabled: undefined, water_enabled: undefined, hw416b_enabled: undefined };

// Threshold debounce state
let pendingThresholdTimer = null;
let pendingThresholdValue = undefined;

async function flushPendingThresholdUpdate() {
  if (pendingThresholdTimer) {
    clearTimeout(pendingThresholdTimer);
    pendingThresholdTimer = null;
  }
  if (pendingThresholdValue === undefined) return;
  const val = pendingThresholdValue;
  pendingThresholdValue = undefined;
  try {
    const table = SUPABASE_SETTINGS || 'settings';
    const updates = { ts: new Date().toISOString(), threshold: val ?? null };
    // Fetch existing row id
    const { data: existing, error: selErr } = await supabase
      .from(table)
      .select('id')
      .order('ts', { ascending: false })
      .limit(1);
    if (selErr) { console.error('Select settings error (flushThreshold):', selErr.message); return; }
    if (existing && existing.length) {
      const id = existing[0].id;
      const { error: updErr } = await supabase.from(table).update(updates).eq('id', id);
      if (updErr) console.error('Update settings error (flushThreshold):', updErr.message);
      else console.log('Updated settings row id (threshold flush)', id, 'threshold=', val);
    } else {
      const { error: insErr } = await supabase.from(table).insert(updates);
      if (insErr) console.error('Insert settings error (flushThreshold):', insErr.message);
      else console.log('Inserted new settings row (threshold flush) threshold=', val);
    }
    // Merge into lastSettings and publish snapshot
    lastSettings.threshold = val;
    if (PUBLISH_SETTINGS_SNAPSHOT) {
      try {
        const snapshot = {
          threshold: lastSettings.threshold,
          vent: lastSettings.vent,
          auto: lastSettings.auto,
          angle: lastSettings.angle,
          max_angle: lastSettings.max_angle,
          graph_range: lastSettings.graph_range,
          dht11_enabled: lastSettings.dht11_enabled,
          water_enabled: lastSettings.water_enabled,
          hw416b_enabled: lastSettings.hw416b_enabled,
          ts: updates.ts,
          source: 'bridge'
        };
        client.publish('home/dashboard/settings_snapshot', JSON.stringify(snapshot), { retain: true });
        client.publish('home/dashboard/settings', JSON.stringify(snapshot), { retain: false });
        console.log('[snapshot] published (threshold flush)');
      } catch (e) {
        console.warn('[snapshot] publish failed (threshold flush)', e?.message || e);
      }
    }
  } catch (e) {
    console.error('flushPendingThresholdUpdate error', e?.message || e);
  }
}

client.on('message', async (topic, message) => {
  // Respond to explicit settings snapshot requests from devices
  if (topic === 'home/dashboard/settings/get') {
    await publishSettingsSnapshot('request');
    return;
  }
  console.log(`Received message on ${topic}:`, message.toString());
  // Handle ping/pong for active liveness probing
  if (topic === 'home/dashboard/bridge_ping') {
    try {
      const req = JSON.parse(message.toString());
      const id = req?.id ?? null;
      const resp = { pong: true, id, ts: new Date().toISOString() };
      client.publish('home/dashboard/bridge_pong', JSON.stringify(resp));
      console.log('Replied bridge_pong', resp);
    } catch (e) {
      // If non-JSON, still reply
      const resp = { pong: true, ts: new Date().toISOString() };
      client.publish('home/dashboard/bridge_pong', JSON.stringify(resp));
      console.log('Replied bridge_pong (no id)');
    }
    return;
  }
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) {
    console.warn('Non-JSON payload on', topic);
    return;
  }
  if (FULL_SETTINGS_LOG) console.log('[verbose] Parsed payload:', payload);
  // Special-case threshold topic: accept live updates but debounce DB writes until user releases
  if (topic === 'home/dashboard/threshold') {
    const val = (payload && (payload.threshold ?? payload.value ?? payload.t)) ?? undefined;
    if (val !== undefined) {
      // Update in-memory state immediately so other logic uses the live value
      lastSettings.threshold = val;
      // If UI signals final=true (release), flush immediately; otherwise debounce
      pendingThresholdValue = val;
      const isFinal = payload?.final === true;
      if (isFinal) {
        if (pendingThresholdTimer) { clearTimeout(pendingThresholdTimer); pendingThresholdTimer = null; }
        // Flush immediately on release
        flushPendingThresholdUpdate().catch(e => console.error('flush error', e));
        if (FULL_SETTINGS_LOG) console.log('[threshold] flush on final release of', val);
      } else {
        // Schedule debounced DB write
        if (pendingThresholdTimer) clearTimeout(pendingThresholdTimer);
        pendingThresholdTimer = setTimeout(() => { flushPendingThresholdUpdate().catch(e => console.error('flush error', e)); }, THRESHOLD_DB_DEBOUNCE_MS);
        if (FULL_SETTINGS_LOG) console.log('[threshold] scheduled flush of', val);
      }
    }
    // Do not proceed with the normal DB/write flow for this message (we'll flush later)
    return;
  }
  if (FULL_SETTINGS_LOG) {
    try { console.log('[verbose] raw payload object keys:', Object.keys(payload)); } catch {}
  }

  // Normalize known fields
  const temperature = payload.temperature ?? undefined;
  const humidity = payload.humidity ?? undefined;
  const angleRaw = (payload.windowAngle ?? payload.angle);
  const isFinal = (payload.final === true);
  const threshold = payload.threshold;
  const vent = payload.vent;
  const auto = payload.auto;
  // Sensor enable flags (may arrive via sensors topic or bundled elsewhere)
  const dht11_enabled = (payload.dht11_enabled !== undefined) ? !!payload.dht11_enabled : undefined;
  const water_enabled = (payload.water_enabled !== undefined) ? !!payload.water_enabled : undefined;
  const hw416b_enabled = (payload.hw416b_enabled !== undefined) ? !!payload.hw416b_enabled : undefined;
  // max_angle is read-only and must come from the DB; ignore any incoming max_angle in payloads
  const max_angle = undefined;
  const graph_range = payload.range || payload.graph_range; // 'live','15m','30m','1h','6h','1d'
  const fromBridge = payload.source === 'bridge';
  if (dht11_enabled !== undefined || water_enabled !== undefined || hw416b_enabled !== undefined) {
    if (LOG_SENSOR_FLAGS) {
      const shown = {};
      if (dht11_enabled !== undefined) shown.dht11_enabled = dht11_enabled;
      if (water_enabled !== undefined) shown.water_enabled = water_enabled;
      if (hw416b_enabled !== undefined) shown.hw416b_enabled = hw416b_enabled;
      console.log('Received sensor flags (changed only):', shown);
    }
  }

  // Clamp angle against last known max_angle if provided
  const currentMax = (typeof lastSettings.max_angle === 'number') ? lastSettings.max_angle : undefined;
  const angle = (angleRaw !== undefined)
    ? (currentMax !== undefined ? Math.min(Number(angleRaw), Number(currentMax)) : Number(angleRaw))
    : undefined;

  // Two-table mode (default) unless explicitly disabled
  if (!LEGACY_SINGLE_TABLE) {
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
      angle: (angle !== undefined && isFinal) ? angle : undefined,
      graph_range: (typeof graph_range === 'string') ? graph_range : undefined,
      dht11_enabled,
      water_enabled,
      hw416b_enabled
    };
    if (FULL_SETTINGS_LOG) {
      // Show a full snapshot of the candidate (including undefined entries) for diagnostics
      console.log('[verbose] settingsCandidate snapshot:', settingsCandidate);
      console.log('[verbose] lastSettings snapshot:', lastSettings);
    }
    // If this is an angle-only transient message (final=false), skip DB entirely
    if (angle !== undefined && !isFinal && threshold === undefined && vent === undefined && auto === undefined) {
      return;
    }
    const hasAny = Object.values(settingsCandidate).some(v => v !== undefined);
    if (hasAny) {
      // Determine individual changed keys (ignore undefined & unchanged)
  const candidateKeys = ['threshold','vent','auto','angle','graph_range','dht11_enabled','water_enabled','hw416b_enabled'];
      const changed = candidateKeys.filter(k => settingsCandidate[k] !== undefined && settingsCandidate[k] !== lastSettings[k]);
      if (changed.length) {
        if (FULL_SETTINGS_LOG) console.log('[verbose] changed keys (detailed):', changed);
        const table = SUPABASE_SETTINGS || 'settings';
        // Fetch / ensure a current row id
        const { data: existing, error: selErr } = await supabase
          .from(table)
          .select('id')
          .order('ts', { ascending: false })
          .limit(1);
        if (selErr) {
          console.error('Select settings error:', selErr.message);
          return;
        }
        const updates = { ts: new Date().toISOString() };
        for (const k of changed) {
          if (k === 'angle') updates.angle = settingsCandidate.angle ?? null;
          else if (k === 'graph_range') updates.graph_range = settingsCandidate.graph_range ?? null;
          else if (k === 'threshold') updates.threshold = threshold ?? null;
          else if (k === 'vent') updates.vent = vent ?? null;
          else if (k === 'auto') updates.auto = auto ?? null;
          else if (k === 'dht11_enabled') updates.dht11_enabled = dht11_enabled;
          else if (k === 'water_enabled') updates.water_enabled = water_enabled;
          else if (k === 'hw416b_enabled') updates.hw416b_enabled = hw416b_enabled;
        }
        console.log('Changed keys:', changed, 'Updates to apply:', updates);
        if (FULL_SETTINGS_LOG) {
          // Construct a full merged view to mirror older full-update logs without writing unchanged columns
          const mergedView = { ...lastSettings };
          for (const k of changed) mergedView[k] = settingsCandidate[k];
          console.log('[verbose] merged post-update view (not all persisted this cycle):', mergedView);
        }
        // Publish snapshot after updating DB & merging local state (retained)
        if (PUBLISH_SETTINGS_SNAPSHOT) {
          try {
            const snapshot = {
              threshold: lastSettings.threshold,
              vent: lastSettings.vent,
              auto: lastSettings.auto,
              angle: lastSettings.angle,
              max_angle: lastSettings.max_angle,
              graph_range: lastSettings.graph_range,
              dht11_enabled: lastSettings.dht11_enabled,
              water_enabled: lastSettings.water_enabled,
              hw416b_enabled: lastSettings.hw416b_enabled,
              ts: updates.ts,
              source: 'bridge'
            };
            client.publish('home/dashboard/settings_snapshot', JSON.stringify(snapshot), { retain: true });
            client.publish('home/dashboard/settings', JSON.stringify(snapshot), { retain: false });
              // max_angle is read-only; snapshot contains the authoritative value from DB
            if (FULL_SETTINGS_LOG) console.log('[snapshot] published full settings snapshot and sent grouped settings to home/dashboard/settings', snapshot);
          } catch (e) {
            console.warn('[snapshot] publish failed', e?.message || e);
          }
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
        // Merge changed values to lastSettings reference
        for (const k of changed) {
          lastSettings[k] = settingsCandidate[k];
        }

        // Optional: publish sensor flags on dedicated topics like other settings
        if (PUBLISH_SENSOR_FLAGS_TOPICS) {
          const flagKeys = ['dht11_enabled','water_enabled','hw416b_enabled'];
          for (const k of changed) {
            if (!flagKeys.includes(k)) continue;
            try {
              const val = lastSettings[k];
              client.publish(`home/dashboard/${k}`, JSON.stringify({ [k]: val, source: 'bridge' }), { retain: true });
              if (FULL_SETTINGS_LOG) console.log('[sensor-topic] published', k, val);
            } catch (e) {
              console.warn('[sensor-topic] publish failed for', k, e?.message || e);
            }
          }
        }
      } else {
        if (dht11_enabled !== undefined || water_enabled !== undefined || hw416b_enabled !== undefined) {
          console.log('Sensor flags unchanged; no per-field update needed');
        }
      }

      // max_angle is read-only and not published as a per-field topic
    }
  } else {
    // Explicit legacy path (LEGACY_SINGLE_TABLE=true)
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
