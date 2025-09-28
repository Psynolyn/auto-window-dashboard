#!/usr/bin/env node
// Generate a config.js from environment variables for static hosting (e.g., Vercel)
const fs = require('fs');
const path = require('path');
let dotenv;
try { dotenv = require('dotenv'); } catch { /* optional: Vercel may omit dev deps */ }

// Load .env.local then .env if present
const root = process.cwd();
const envLocal = path.join(root, '.env.local');
const envFile = path.join(root, '.env');
if (dotenv) {
  if (fs.existsSync(envLocal)) dotenv.config({ path: envLocal });
  if (fs.existsSync(envFile)) dotenv.config({ path: envFile });
  // Also load from ingest/.env if present
  const ingestEnv = path.join(root, 'ingest', '.env');
  if (fs.existsSync(ingestEnv)) dotenv.config({ path: ingestEnv });
}

function val(name, fallback = '') {
  return process.env[name] ?? fallback;
}

const DEFAULT_WSS = 'wss://broker.hivemq.com:8884/mqtt';

function sanitizeMqttUrl(raw) {
  const v = (raw || '').trim();
  if (!v || v.includes('<') || v.includes('>') || v.toLowerCase().includes('%3c') || v.toLowerCase().includes('%3e')) return DEFAULT_WSS;
  try {
    const u = new URL(v);
    if (u.protocol === 'wss:' || u.protocol === 'ws:') return u.toString();
  } catch {}
  return DEFAULT_WSS;
}

const cfg = {
  // Supabase: prefer NEXT_PUBLIC/VITE build-time names, but fall back to unprefixed names
  SUPABASE_URL: val('NEXT_PUBLIC_SUPABASE_URL') || val('VITE_SUPABASE_URL') || val('SUPABASE_URL') || '',
  SUPABASE_ANON_KEY: val('NEXT_PUBLIC_SUPABASE_ANON_KEY') || val('VITE_SUPABASE_ANON_KEY') || val('SUPABASE_ANON_KEY') || '',
  // MQTT: prefer NEXT_PUBLIC/VITE names, fall back to MQTT_*
  MQTT_URL: sanitizeMqttUrl(val('NEXT_PUBLIC_MQTT_URL') || val('VITE_MQTT_URL') || val('MQTT_URL') || DEFAULT_WSS),
  MQTT_USERNAME: val('NEXT_PUBLIC_MQTT_USERNAME') || val('VITE_MQTT_USERNAME') || val('MQTT_USERNAME') || '',
  MQTT_PASSWORD: val('NEXT_PUBLIC_MQTT_PASSWORD') || val('VITE_MQTT_PASSWORD') || val('MQTT_PASSWORD') || '',
  MQTT_CLIENT_ID_PREFIX: (val('NEXT_PUBLIC_MQTT_CLIENT_ID_PREFIX') || val('VITE_MQTT_CLIENT_ID_PREFIX') || val('MQTT_CLIENT_ID_PREFIX') || 'dashboard-')
};

const js = `window.__APP_CONFIG__ = ${JSON.stringify(cfg, null, 2)};\n`;
const out = path.join(process.cwd(), 'config.js');
fs.writeFileSync(out, js, 'utf8');
console.log('[gen-config] Wrote', out);
