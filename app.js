// Gauge helpers: 270° track using stroke-dasharray
function initGauge(gaugeEl, defaultFraction = 0.5) {
  const bg = gaugeEl.querySelector('circle.gauge-bg');
  const prog = gaugeEl.querySelector('circle.gauge-progress');
  if (!bg || !prog) return;
  const r = parseFloat(prog.getAttribute('r'));
  const C = 2 * Math.PI * r;
  // 270° track on background (single dash + single gap)
  bg.style.strokeDasharray = `${0.75 * C} ${0.25 * C}`;
  // progress: from 0 to 270°
  setGaugeProgress(gaugeEl, defaultFraction);
}

function setGaugeProgress(gaugeEl, fraction) {
  const prog = gaugeEl.querySelector('circle.gauge-progress');
  if (!prog) return;
  const r = parseFloat(prog.getAttribute('r'));
  const C = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  const dash = f * 0.75 * C;           // visible portion (grows from start)
  // Start at same point as track start (no offset); group rotation sets visual orientation
  prog.style.strokeDasharray = `${dash} ${C}`;
  prog.style.strokeDashoffset = `0`;

  // position knob if present (on angle gauge)
  const knob = gaugeEl.querySelector('.gauge-knob');
  const knobHit = gaugeEl.querySelector('.gauge-knob-hit');
  const ring = gaugeEl.querySelector('.ring-rot');
  if (knob && ring) {
    // compute angle along the 270° arc (0°..270°) in group's local coordinates
    const angleDeg = 0 + (f * 270);
    // knob coordinates in unrotated space around center (cx,cy)
    const cx = parseFloat(knob.getAttribute('cx'));
    const cy = parseFloat(knob.getAttribute('cy'));
    const R = r; // radius same as progress circle
    const rad = angleDeg * Math.PI / 180;
    const x = cx + R * Math.cos(rad);
    const y = cy + R * Math.sin(rad);
    // we place a small transform on the knob to move it to (x,y)
    knob.setAttribute('transform', `translate(${x - cx}, ${y - cy})`);
    if (knobHit) {
      // Ensure hit radius is 2× visual knob radius
      const visualR = parseFloat(knob.getAttribute('r')) || 10;
      const hitR = Math.max(visualR * 2, visualR + 6);
      knobHit.setAttribute('r', String(hitR));
      knobHit.setAttribute('transform', `translate(${x - cx}, ${y - cy})`);
    }
  }
}

// MQTT connection: use window overrides if provided (else fallback to HiveMQ public broker)
// Debug/logging control: silence non-critical logs by default in production
const DEBUG_LOGS = !!window.DEBUG_LOGS; // set window.DEBUG_LOGS = true to enable verbose logs
const log = DEBUG_LOGS ? console.log.bind(console) : () => {};
const info = DEBUG_LOGS ? console.info?.bind(console) || console.log.bind(console) : () => {};
const warn = DEBUG_LOGS ? console.warn.bind(console) : () => {};
const DEFAULT_WSS = "wss://broker.hivemq.com:8884/mqtt";
function pickUrl(v) {
  const s = (v || '').trim();
  if (!s || s.includes('<') || s.includes('>')) return DEFAULT_WSS;
  try { const u = new URL(s); return (u.protocol === 'wss:' || u.protocol === 'ws:') ? u.toString() : DEFAULT_WSS; } catch { return DEFAULT_WSS; }
}
const MQTT_URL = pickUrl(window.MQTT_URL || DEFAULT_WSS);
// Optional username/password for HiveMQ Cloud or secured brokers
const MQTT_USERNAME = (window.MQTT_USERNAME || undefined);
const MQTT_PASSWORD = (window.MQTT_PASSWORD || undefined);
const CLIENT_PREFIX = (window.MQTT_CLIENT_ID_PREFIX || 'dashboard-');
const PERSIST_BASE_KEY = 'mqttClientIdBase';
const TAB_KEY = 'mqttTabId';
let clientId = null;
try {
  // Stable base across sessions/devices for this browser profile
  let base = localStorage.getItem(PERSIST_BASE_KEY);
  if (!base) { base = CLIENT_PREFIX + (crypto?.randomUUID?.() || Math.random().toString(16).slice(2)); localStorage.setItem(PERSIST_BASE_KEY, base); }
  // Unique suffix per tab to prevent clientId collisions between tabs
  let tab = sessionStorage.getItem(TAB_KEY);
  if (!tab) { tab = (Math.random().toString(36).slice(2, 8)); sessionStorage.setItem(TAB_KEY, tab); }
  clientId = `${base}-${tab}`;
} catch {}
let client = null;
if (typeof mqtt === 'undefined' || !mqtt?.connect) {
  console.error('mqtt.js failed to load');
} else {
  const RECONNECT_MS = 2000 + Math.floor(Math.random() * 500); // small jitter to avoid thundering herd
  client = mqtt.connect(MQTT_URL, {
    protocolVersion: 5,
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clientId: clientId || undefined,
    clean: false,
    keepalive: 20,
    reconnectPeriod: RECONNECT_MS,
    connectTimeout: 15000,
    resubscribe: true,
    properties: { sessionExpiryInterval: 3600 },
    will: { topic: 'home/dashboard/status', payload: 'offline', qos: 0, retain: true }
  });
}

// Device presence tracking (ESP32): show Offline until device availability says Online
let deviceOnline = false;

function updateStatusUI(stateHint) {
  const dot = document.getElementById('mqtt-status');
  const text = document.getElementById('mqtt-status-text');
  // If broker is disconnected, always show Offline
  if (!client || !client.connected) {
    if (dot) { dot.classList.remove('online'); dot.classList.add('offline'); dot.title = 'Offline'; dot.setAttribute('aria-label', 'MQTT Offline'); }
    if (text) { text.textContent = 'Offline'; }
    return;
  }
  // Broker connected: reflect device presence
  if (deviceOnline) {
    if (dot) { dot.classList.remove('offline'); dot.classList.add('online'); dot.title = 'Online'; dot.setAttribute('aria-label', 'Device Online'); }
    if (text) { text.textContent = 'Online'; }
  } else {
    if (dot) { dot.classList.remove('online'); dot.classList.add('offline'); dot.title = 'Offline'; dot.setAttribute('aria-label', 'Device Offline'); }
    if (text) { text.textContent = 'Offline'; }
  }
}

function markDeviceSeen(reason = '') {
  if (!deviceOnline) {
    deviceOnline = true;
    updateStatusUI('seen:' + reason);
  }
}

// Tiny toast helper
function showToast(msg, kind = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.className = `toast ${kind}`.trim();
  t.textContent = msg;
  requestAnimationFrame(() => {
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  });
}

if (client) client.on("connect", () => {
  log("Connected to MQTT broker");
  showToast(`MQTT connected`, 'success');
  // On broker connect, do not mark Online until device is seen
  deviceOnline = false;
  updateStatusUI('broker-connected');
  client.subscribe("home/dashboard/data");
  // also subscribe window/topic in case device publishes separate topics
  client.subscribe("home/dashboard/window");
  // subscribe to settings topics so changes in one tab reflect in others
  client.subscribe("home/dashboard/threshold");
  client.subscribe("home/dashboard/vent");
  client.subscribe("home/dashboard/auto");
  // dev-only max angle limit broadcast
  client.subscribe("home/dashboard/max_angle");
  // device availability topic (retained LWT or explicit publishes)
  client.subscribe("home/esp32/availability");
  // Force an initial bridge check right after connect (prior to first telemetry)
  checkBridgeNow(true);
});

if (client) client.on("error", (err) => {
  console.error("MQTT error", err);
  showToast(`MQTT error: ${err?.message || err}`, 'error');
  deviceOnline = false;
  updateStatusUI('error');
});

if (client) client.on("reconnect", () => {
  deviceOnline = false;
  updateStatusUI('reconnect');
});

if (client) client.on("close", () => {
  deviceOnline = false;
  updateStatusUI('close');
  showToast('MQTT connection closed', 'error');
  // Broker offline -> we cannot assess bridge; hide banner to avoid stale warning
  bridgeSticky = false;
  setBridgeBanner(false);
});

if (client) client.on("offline", () => {
  deviceOnline = false;
  updateStatusUI('broker-offline');
  showToast('MQTT offline', 'error');
  bridgeSticky = false;
  setBridgeBanner(false);
});

// DOM refs
const tempEl = document.getElementById("temperature-value");
const humidEl = document.getElementById("humidity-value");
const angleEl = document.getElementById("window-angle");
const slider = document.getElementById("servo-slider");
const thDec = document.getElementById("th-dec");
const thInc = document.getElementById("th-inc");
const thValEl = document.getElementById("threshold-value");
const ventBtn = document.getElementById("vent-btn");
const motionStatus = document.getElementById("motion-status");
const autoToggle = document.getElementById("auto-toggle");

// initial state
let threshold = 23;
let ventActive = false;
// Max angle limit (dev-only setting broadcast via MQTT and optionally from Supabase)
let maxAngleLimit = 180;

// Angle smoothing state for passive tabs (animate toward remote updates)
const angleAnim = {
  active: false,
  current: null,
  target: null,
  rafId: null
};

function setAngleUI(deg) {
  const angleValue = angleEl.querySelector('.gauge-value');
  const clamped = Math.max(0, Math.min(maxAngleLimit, Math.round(deg)));
  if (angleValue) angleValue.innerHTML = `${clamped}<sup>°</sup>`;
  // Map full-scale to maxAngleLimit so the 270° arc always represents 0..max
  setGaugeProgress(angleEl, clamped / Math.max(1, maxAngleLimit));
  if (slider) slider.value = String(clamped);
}

function animateAngleStep() {
  if (angleAnim.target == null || angleAnim.current == null) { angleAnim.active = false; return; }
  const target = angleAnim.target;
  const current = angleAnim.current;
  const next = current + (target - current) * 0.28; // easing factor
  angleAnim.current = next;
  setAngleUI(next);
  if (Math.abs(target - next) < 0.6) {
    angleAnim.current = target;
    setAngleUI(target);
    angleAnim.active = false;
    angleAnim.rafId = null;
    return;
  }
  angleAnim.rafId = requestAnimationFrame(animateAngleStep);
}

function updateAngleSmooth(targetDeg, isLocal = false) {
  const target = Math.max(0, Math.min(maxAngleLimit, Math.round(targetDeg)));
  if (isLocal) {
    // Local interaction: set immediately and cancel smoothing
    if (angleAnim.rafId) cancelAnimationFrame(angleAnim.rafId);
    angleAnim.active = false;
    angleAnim.current = target;
    angleAnim.target = target;
    setAngleUI(target);
    return;
  }
  // Remote update: animate toward target
  if (angleAnim.current == null) angleAnim.current = target;
  angleAnim.target = target;
  if (!angleAnim.active) {
    angleAnim.active = true;
    angleAnim.rafId = requestAnimationFrame(animateAngleStep);
  }
}

// Initialize gauges and values to placeholders ("--") until data arrives
document.addEventListener('DOMContentLoaded', () => {
  // Set all gauges to 0 progress (start of arc)
  document.querySelectorAll('.gauge').forEach(g => initGauge(g, 0));
  // Show placeholders for values
  const tVal = document.querySelector('#temperature-value .gauge-value');
  if (tVal) tVal.innerHTML = '--';
  const hVal = document.querySelector('#humidity-value .gauge-value');
  if (hVal) hVal.innerHTML = '--';
  const aVal = document.querySelector('#window-angle .gauge-value');
  if (aVal) aVal.innerHTML = '--';
  if (thValEl) thValEl.innerHTML = '--';
  // Initialize slider to 0 and max to current limit (avoid defaulting to 50%)
  const sliderEl = document.getElementById('servo-slider');
  if (sliderEl) { sliderEl.value = '0'; sliderEl.max = String(maxAngleLimit); }
  // Reset angle smoothing state so first remote/local set snaps correctly
  angleAnim.current = null; angleAnim.target = null;
  // Early forced bridge check so banner can appear even before MQTT connect/telemetry
  checkBridgeNow(true);
  // Wire banner dismiss controls
  attachBannerDismiss();
});

// helpers
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function publish(topic, payload) {
  if (!client || !client.connected) return;
  try { client.publish(topic, JSON.stringify(payload)); }
  catch (e) { console.warn("Publish failed", e); }
}

// Apply incoming or preloaded max angle limit to UI and state
function applyMaxAngleLimit(limit) {
  // Accept any sane positive limit; no 180° cap
  const newLimit = Math.max(1, Math.round(Number(limit)));
  if (!Number.isFinite(newLimit)) return;
  maxAngleLimit = newLimit;
  if (slider) slider.max = String(maxAngleLimit);
  // Clamp current angle display if needed (do not publish; local-only correction)
  const valueEl = angleEl.querySelector('.gauge-value');
  const current = valueEl ? (parseInt(valueEl.textContent) || 0) : 0;
  if (current > maxAngleLimit) {
    setAngleUI(maxAngleLimit);
  }
}

// Self-suppression helpers to avoid UI flicker on our own MQTT echoes
function setSuppress(key, value, ms = 800) {
  window.__suppress = window.__suppress || {};
  window.__suppress[key] = { value, until: Date.now() + ms };
}
function shouldSuppress(key, incomingValue) {
  const s = (window.__suppress || {})[key];
  if (!s || Date.now() >= s.until) return false;
  if (key === 'angle') {
    return Math.abs(Number(incomingValue) - Number(s.value)) <= 1; // tolerant suppress within 1°
  }
  return s.value === incomingValue;
}
// Short guard window to ignore mismatched echoes (older values) after a local change
function beginGuard(key, value, ms = 600) {
  window.__guards = window.__guards || {};
  window.__guards[key] = { value, until: Date.now() + ms };
}
function isGuardedMismatch(key, incomingValue) {
  const g = (window.__guards || {})[key];
  if (!g || Date.now() >= g.until) return false;
  if (key === 'angle') {
    // Treat values within 1° as a match to avoid snapback
    return Math.abs(Number(incomingValue) - Number(g.value)) > 1;
  }
  return incomingValue !== g.value;
}
function clearGuardIfMatch(key, incomingValue) {
  const g = (window.__guards || {})[key];
  if (!g) return;
  if (key === 'angle') {
    if (Math.abs(Number(incomingValue) - Number(g.value)) <= 1) g.until = 0;
    return;
  }
  if (incomingValue === g.value) g.until = 0;
}
function publishAndSuppress(topic, payload, suppressKey, suppressValue, guardMs = 600) {
  setSuppress(suppressKey, suppressValue);
  beginGuard(suppressKey, suppressValue, guardMs);
  publish(topic, payload);
}

// Optional: Supabase client for settings/history (fill in anon key and URL)
// Configure these with your project values to enable settings preload on startup
const SUPABASE_URL = window.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
const sb = (window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// Bridge health detection: show a banner if MQTT telemetry flows but DB latest row doesn't advance
let lastDbTsMs = 0;
let lastMqttTelemetryAt = 0;
let bridgeChkTimer = null;
let bridgeNoAdvanceStreak = 0; // consecutive telemetry checks where DB ts didn't advance
let bridgeSticky = false; // keep banner visible until DB advances
const LIVE_TELEMETRY_WINDOW_MS = 5000; // consider MQTT live if within last 5s
const DB_LAG_THRESHOLD_MS = 2000;      // warn if DB latest row is older than 2s while MQTT is live

function setBridgeBanner(visible) {
  const el = document.getElementById('bridge-banner');
  if (!el) return;
  if (visible) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
}

// Dismiss logic for banners (X + swipe) with animated slide-out
function attachBannerDismiss() {
  if (window.__bannerDismissWired) return; // one-time wiring
  window.__bannerDismissWired = true;
  function animateBannerOut(banner, dir = 1) {
    if (!banner || !banner.parentNode) return;
    const width = banner.offsetWidth || 300;
    // Ensure transition is enabled
    banner.classList.remove('swiping');
    banner.style.transition = 'transform 200ms ease, opacity 200ms ease';
    banner.style.willChange = 'transform, opacity';
    // Kick off next frame for reliable transition
    requestAnimationFrame(() => {
      banner.style.transform = `translateX(${dir * (width + 80)}px)`;
      banner.style.opacity = '0';
    });
    banner.addEventListener('transitionend', () => {
      if (banner.remove) banner.remove(); else banner.parentNode && banner.parentNode.removeChild(banner);
    }, { once: true });
  }

  // Click on X -> animate out to the right
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.banner-close');
    if (!btn) return;
    const banner = btn.closest('.stale-banner');
    if (banner) {
      e.preventDefault();
      animateBannerOut(banner, +1);
    }
  });

  // Swipe-to-dismiss: drag follows finger, then animate off-screen on release
  let swipe = null; // { x, y, el }
  function startSwipe(x, y, target) {
    const banner = target?.closest && target.closest('.stale-banner');
    if (!banner) return;
    swipe = { x, y, el: banner };
    banner.classList.add('swiping');
    banner.style.transition = 'none';
  }
  function moveSwipe(x, y) {
    if (!swipe || !swipe.el?.isConnected) return;
    const dx = x - swipe.x;
    const dy = y - swipe.y;
    if (Math.abs(dx) < 2 || Math.abs(dx) < Math.abs(dy)) return;
    const banner = swipe.el;
    const w = banner.offsetWidth || 300;
    const fade = Math.min(0.6, Math.abs(dx) / w);
    banner.style.transform = `translateX(${dx}px)`;
    banner.style.opacity = String(1 - fade);
  }
  function endSwipe(x, y) {
    if (!swipe) return;
    const banner = swipe.el;
    const dx = x - swipe.x;
    const dy = y - swipe.y;
    const absdx = Math.abs(dx);
    const absdy = Math.abs(dy);
    if (banner) {
      banner.classList.remove('swiping');
      banner.style.transition = 'transform 200ms ease, opacity 200ms ease';
    }
    const width = banner?.offsetWidth || 300;
    const threshold = Math.max(40, Math.min(120, Math.round(width * 0.25)));
    if (banner && absdx > threshold && absdy < 60) {
      const dir = dx >= 0 ? +1 : -1;
      animateBannerOut(banner, dir);
    } else if (banner) {
      requestAnimationFrame(() => {
        banner.style.transform = 'translateX(0px)';
        banner.style.opacity = '1';
      });
      banner.addEventListener('transitionend', () => {
        banner.style.transition = '';
        banner.style.transform = '';
        banner.style.opacity = '';
      }, { once: true });
    }
    swipe = null;
  }

  // Pointer events
  document.addEventListener('pointerdown', (e) => startSwipe(e.clientX, e.clientY, e.target));
  document.addEventListener('pointermove', (e) => moveSwipe(e.clientX, e.clientY), { passive: true });
  document.addEventListener('pointerup', (e) => endSwipe(e.clientX, e.clientY));

  // Touch fallback
  document.addEventListener('touchstart', (e) => {
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    startSwipe(t.clientX, t.clientY, e.target);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    moveSwipe(t.clientX, t.clientY);
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    endSwipe(t.clientX, t.clientY);
  });

  // Mouse fallback
  let mouseDown = false;
  document.addEventListener('mousedown', (e) => { mouseDown = true; startSwipe(e.clientX, e.clientY, e.target); });
  document.addEventListener('mousemove', (e) => { if (mouseDown) moveSwipe(e.clientX, e.clientY); });
  document.addEventListener('mouseup', (e) => { if (mouseDown) endSwipe(e.clientX, e.clientY); mouseDown = false; });
}

// Ensure handlers are attached even if DOMContentLoaded already fired
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachBannerDismiss);
} else {
  attachBannerDismiss();
}

async function refreshLastDbTs() {
  if (!sb) return;
  try {
    const { data, error } = await sb
      .from('readings')
      .select('ts')
      .order('ts', { ascending: false })
      .limit(1);
    if (!error && data && data.length) {
      const ts = Date.parse(data[0].ts);
      if (Number.isFinite(ts)) lastDbTsMs = Math.max(lastDbTsMs, ts);
    } else {
      const { data: d2, error: e2 } = await sb
        .from('telemetry')
        .select('ts')
        .order('ts', { ascending: false })
        .limit(1);
      if (!e2 && d2 && d2.length) {
        const ts2 = Date.parse(d2[0].ts);
        if (Number.isFinite(ts2)) lastDbTsMs = Math.max(lastDbTsMs, ts2);
      }
    }
  } catch {}
}

async function checkBridgeNow(force = false) {
  log(`Bridge check called: force=${force}, sb=${!!sb}, SUPABASE_URL=${!!SUPABASE_URL}, SUPABASE_ANON_KEY=${!!SUPABASE_ANON_KEY}`);
  
  if (!sb) { 
  info('Supabase not configured - showing bridge warning by default');
    // Without DB visibility, show the banner so the user knows ingestion may be inactive
    setBridgeBanner(true);
    return; 
  }
  
  const live = (Date.now() - lastMqttTelemetryAt) <= LIVE_TELEMETRY_WINDOW_MS;
  const before = lastDbTsMs;
  await refreshLastDbTs();
  const advanced = lastDbTsMs > before;
  const lag = Date.now() - lastDbTsMs;
  
  log(`Bridge check: force=${force}, live=${live}, advanced=${advanced}, lag=${lag}ms, lastDbTs=${new Date(lastDbTsMs).toISOString()}`);

  // Forced checks: decide solely on staleness (avoid false negatives when baseline was 0)
  if (force) {
    if (advanced) bridgeNoAdvanceStreak = 0; else bridgeNoAdvanceStreak += 1;
    const shouldShow = lag > DB_LAG_THRESHOLD_MS;
    bridgeSticky = shouldShow;
    setBridgeBanner(bridgeSticky);
  if (shouldShow) log(`Bridge banner shown (forced): lag=${lag}`);
    return;
  }

  // Non-forced checks (triggered during telemetry): only consider if telemetry is live
  if (!live) { setBridgeBanner(bridgeSticky); return; }
  if (advanced) {
    bridgeNoAdvanceStreak = 0;
    bridgeSticky = false;
    setBridgeBanner(false);
  } else {
    bridgeNoAdvanceStreak += 1;
    bridgeSticky = true;
    setBridgeBanner(true);
  log(`Bridge banner shown (live no-advance): streak=${bridgeNoAdvanceStreak}`);
  }
}

function startBridgeMonitor() {
  if (bridgeChkTimer) clearInterval(bridgeChkTimer);
  bridgeChkTimer = setInterval(() => { checkBridgeNow(); }, 2000);
}

// Load latest settings (from two-table mode 'settings' first, else fall back to 'telemetry')
async function fetchLatestSettings() {
  if (!sb) return null;
  // Read from settings table only
  let { data, error } = await sb
    .from('settings')
    .select('threshold, vent, auto, angle, max_angle, ts')
    .order('ts', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('Supabase settings fetch error', error.message);
  }
  return (data && data.length) ? data[0] : null;
}

// Apply settings to UI
function applySettingsToUI(s) {
  if (!s) return;
  if (typeof s.max_angle === 'number') {
    applyMaxAngleLimit(s.max_angle);
  }
  if (typeof s.threshold === 'number') {
    threshold = clamp(s.threshold, 0, 100);
    thValEl.innerHTML = `${threshold}<sup>°C</sup>`;
  }
  if (typeof s.angle === 'number') {
    const angleDeg = clamp(Math.round(s.angle), 0, maxAngleLimit);
    const angleValue = angleEl.querySelector('.gauge-value');
    if (angleValue) angleValue.innerHTML = `${angleDeg}<sup>°</sup>`;
    setGaugeProgress(angleEl, angleDeg / Math.max(1, maxAngleLimit));
    if (slider) slider.value = String(angleDeg);
  }
  if (typeof s.vent === 'boolean') {
    ventActive = !!s.vent;
    ventBtn.classList.toggle("active", ventActive);
    ventBtn.setAttribute("aria-pressed", String(ventActive));
  }
  if (typeof s.auto === 'boolean') {
    const isActive = !!s.auto;
    autoToggle.classList.toggle("active", isActive);
    autoToggle.setAttribute("aria-pressed", String(isActive));
  }
}

let pendingSettingsToSend = null;

// Preload settings on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  if (sb) {
    const latest = await fetchLatestSettings();
    if (latest) {
      applySettingsToUI(latest);
      pendingSettingsToSend = latest; // remember to send to ESP after MQTT connect
    }
    // Refresh DB newest ts once so we have a baseline, then start monitoring
    await refreshLastDbTs();
    startBridgeMonitor();
  }
});

// After MQTT connects, publish pending settings to ESP
if (client) client.on("connect", () => {
  // ...existing code...
  if (pendingSettingsToSend) {
    const s = pendingSettingsToSend;
    if (typeof s.threshold === 'number') publish("home/dashboard/threshold", { threshold: clamp(s.threshold, 0, 100) });
    if (typeof s.angle === 'number') publish("home/dashboard/window", { angle: clamp(Math.round(s.angle), 0, maxAngleLimit) });
    if (typeof s.vent === 'boolean') publish("home/dashboard/vent", { vent: !!s.vent });
    if (typeof s.auto === 'boolean') publish("home/dashboard/auto", { auto: !!s.auto });
  if (typeof s.max_angle === 'number') publish("home/dashboard/max_angle", { max_angle: Math.max(1, Math.round(s.max_angle)) });
    pendingSettingsToSend = null;
  }
});

// Example history fetch (commented)
// async function fetchRecentTelemetry(rangeMinutes = 60) {
//   if (!sb) return [];
//   const since = new Date(Date.now() - rangeMinutes * 60_000).toISOString();
//   // If using two-table mode, read from 'readings'; otherwise fallback to 'telemetry'
//   const table = 'readings';
//   const { data, error } = await sb
//     .from(table)
//     .select('ts, temperature, humidity')
//     .gte('ts', since)
//     .order('ts', { ascending: false })
//     .limit(5000);
//   if (error) { console.warn('Supabase fetch error', error); return []; }
//   return data ?? [];
// }

// Graph time-range controls will be wired after the graph initializes
(function initGraphControls() {
  const ctrl = document.getElementById('graph-controls');
  if (!ctrl) return;
  const buttons = Array.from(ctrl.querySelectorAll('.time-btn'));
  buttons.forEach(b => b.addEventListener('click', () => {
    const range = b.dataset.range;
    // call graph controller if ready
    if (window.THGraph && typeof window.THGraph.setRange === 'function') {
      window.THGraph.setRange(range);
    }
  }));
})();

// Simple canvas graph for Temperature and Humidity
(function setupTHGraph() {
  const canvas = document.getElementById('th-graph');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const tempColor = getComputedStyle(document.documentElement).getPropertyValue('--temp-color') || '#ff6b35';
  const humidColor = getComputedStyle(document.documentElement).getPropertyValue('--humid-color') || '#4fc3f7';
  // Fallback to CSS classes colors (read from DOM styles of gauges)
  // We'll just hardcode based on our stylesheet for reliability
  const TEMP_COLOR = '#ff6b35';
  const HUMID_COLOR = '#4fc3f7';

  // Ranges and timing
  const LIVE_INTERVAL_MS = 1000; // 1s live update cadence
  const LIVE_MAX_POINTS = 480;   // ~8 minutes at 1s
  const RANGE_MS = {
    live: LIVE_INTERVAL_MS * LIVE_MAX_POINTS, // window equals live buffer span
    '15m': 15 * 60_000,
    '30m': 30 * 60_000,
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '1d': 24 * 60 * 60_000,
  };
  const HISTORY_REFRESH_MS = 60_000; // refresh history ranges once per minute

  // Resize canvas to device pixels for crisp lines
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(10, Math.floor(rect.width * dpr));
    canvas.height = Math.max(10, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Graph state
  const state = {
    range: 'live',
    liveData: [], // {t,h,ts}
    histData: [], // {t,h,ts}
    liveTimer: null,
    historyTimer: null,
    lastLiveAt: 0,   // last time a point was pushed to liveData
    lastMqttAt: 0,   // last time an MQTT reading arrived (any range)
    liveStartAt: 0,
    viewStartAt: 0,  // when current range was selected (for initial-stale checks)
  };

  function setButtonsActive(range) {
    const ctrl = document.getElementById('graph-controls');
    if (!ctrl) return;
    const buttons = Array.from(ctrl.querySelectorAll('.time-btn'));
    buttons.forEach(b => b.classList.toggle('active', b.dataset.range === range));
  }

  function pushLivePoint(t, h, ts = Date.now()) {
    state.liveData.push({ t, h, ts });
    // Drop anything older than the live window
    const minTs = Date.now() - RANGE_MS.live;
    while (state.liveData.length && state.liveData[0].ts < minTs) state.liveData.shift();
    // Cap to max points
    if (state.liveData.length > LIVE_MAX_POINTS) state.liveData.splice(0, state.liveData.length - LIVE_MAX_POINTS);
    state.lastLiveAt = ts;
    const banner = document.getElementById('live-stale-banner');
    if (banner && !banner.hasAttribute('hidden')) banner.setAttribute('hidden', '');
  }

  // Drawing function
  function draw() {
    const w = canvas.clientWidth;
    const hpx = canvas.clientHeight;
    ctx.clearRect(0, 0, w, hpx);

  // padding and a small legend row above the graph
  const basePadT = 8;      // top margin of canvas
  const legendH = 24;      // space reserved for legend above axes
  const padT = basePadT + legendH; // top of plotting area
  const padL = 52;         // extra left padding to fit vertical title
  const padR = 10;
  const padB = 28;
  const gw = w - padL - padR;     // graph width
  const gh = hpx - padT - padB;   // graph height

  // axes
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + gh);
    ctx.lineTo(padL + gw, padT + gh);
    ctx.stroke();

  // Axis labels/ticks (simple): humidity scale on left (0..100), x is time
    ctx.fillStyle = 'rgba(220,220,220,0.85)';
    ctx.font = '12px system-ui, Arial';
    ctx.fillText('0', padL - 18, padT + gh);
    ctx.fillText('100', padL - 28, padT + 10);
    // dynamic x-axis ticks
    const nowTs = Date.now();
    let xMin = nowTs - RANGE_MS[state.range] || (state.range === 'live' ? (nowTs - RANGE_MS.live) : nowTs - 60_000);
    let xMax = nowTs;
    let points = (state.range === 'live') ? state.liveData : state.histData;
    if (points.length) {
      // constrain to data domain for history ranges to avoid empty space
      if (state.range !== 'live') {
        xMin = Math.min(xMin, points[0].ts);
        xMax = Math.max(xMax, points[points.length - 1].ts);
      }
    }
    function xAtTs(ts) {
      const f = (ts - xMin) / Math.max(1, (xMax - xMin));
      return padL + f * gw;
    }
    // ticks at start, 1/3, 2/3, end
    const ticks = [xMin, xMin + (xMax - xMin) / 3, xMin + 2 * (xMax - xMin) / 3, xMax];
    function fmtTick(ts) {
      const d = new Date(ts);
      const spanMs = xMax - xMin;
      const dayMs = 24 * 60 * 60_000;
      if (spanMs <= 10 * 60_000) {
        // ≤10 minutes: mm:ss
        return d.toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
      } else if (spanMs <= dayMs) {
        // ≤1 day: HH:mm
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else {
        // >1 day: M/D
        return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
      }
    }
    ctx.fillText(fmtTick(ticks[0]), padL, padT + gh + 16);
    ctx.textAlign = 'center';
    ctx.fillText(fmtTick(ticks[1]), padL + gw / 3, padT + gh + 16);
    ctx.fillText(fmtTick(ticks[2]), padL + (2 * gw) / 3, padT + gh + 16);
    ctx.textAlign = 'right';
    ctx.fillText(state.range === 'live' ? 'now' : fmtTick(ticks[3]), padL + gw, padT + gh + 16);
    ctx.textAlign = 'left';

  // Axis titles (crisp vertical title: integer-aligned and middle baseline)
  ctx.save();
  ctx.fillStyle = 'rgba(230,230,230,0.92)';
  ctx.font = '12px system-ui, Arial';
  const tX = Math.round(padL - 38);
  const tY = Math.round(padT + gh / 2);
  ctx.translate(tX, tY);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Humidity %   /   Temp °C', 0, 0);
  ctx.restore();

  // Legend above plotting area (no background)
  const legendY = basePadT + 14; // centered in legend row
  let lx = padL; // start near left
  ctx.lineWidth = 2.5;
  ctx.font = '12px system-ui, Arial';
  ctx.textBaseline = 'middle';
  // Humidity entry
  ctx.strokeStyle = HUMID_COLOR;
  ctx.beginPath(); ctx.moveTo(lx, legendY); ctx.lineTo(lx + 24, legendY); ctx.stroke();
  ctx.fillStyle = 'rgba(230,230,230,0.95)';
  ctx.fillText('Humidity', lx + 30, legendY);
  lx += 30 + ctx.measureText('Humidity').width + 18;
  // Temperature entry
  ctx.strokeStyle = TEMP_COLOR;
  ctx.beginPath(); ctx.moveTo(lx, legendY); ctx.lineTo(lx + 24, legendY); ctx.stroke();
  ctx.fillStyle = 'rgba(230,230,230,0.95)';
  ctx.fillText('Temperature', lx + 30, legendY);

    const plot = points;
    if (!plot.length) return;

    // Y mappers
    function yTemp(v) {
      const clamped = Math.max(0, Math.min(50, v));
      const f = clamped / 50; // 0..1
      return padT + gh - f * gh;
    }
    function yHumid(v) {
      const clamped = Math.max(0, Math.min(100, v));
      const f = clamped / 100; // 0..1
      return padT + gh - f * gh;
    }

    // Draw humidity first (under), then temperature
    ctx.lineWidth = 2;
    ctx.strokeStyle = HUMID_COLOR;
    ctx.beginPath();
    plot.forEach((p, i) => {
      const x = xAtTs(p.ts);
      const y = yHumid(p.h);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.strokeStyle = TEMP_COLOR;
    ctx.beginPath();
    plot.forEach((p, i) => {
      const x = xAtTs(p.ts);
      const y = yTemp(p.t);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Hook into MQTT telemetry (always record lastMqttAt; push to graph only in live)
  if (client) client.on('message', (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.temperature !== undefined || payload.humidity !== undefined) {
        state.lastMqttAt = Date.now();
        if (state.range === 'live') {
          const last = state.liveData.length ? state.liveData[state.liveData.length - 1] : { t: 24, h: 55 };
          const t = typeof payload.temperature === 'number' ? payload.temperature : last.t;
          const h = typeof payload.humidity === 'number' ? payload.humidity : last.h;
          pushLivePoint(t, h);
        }
      }
    } catch { /* ignore non-JSON */ }
  });

  // History loading via Supabase
  async function loadHistory(rangeKey) {
    if (!sb) {
      showToast('Supabase not configured for history', 'error');
      return [];
    }
    const span = RANGE_MS[rangeKey] || RANGE_MS['15m'];
    const sinceIso = new Date(Date.now() - span).toISOString();
    // Try readings first; fall back to telemetry if not in two-table mode
    async function fetchFrom(tableName) {
      const { data, error } = await sb
        .from(tableName)
        .select('ts, temperature, humidity')
        .gte('ts', sinceIso)
        .order('ts', { ascending: true })
        .limit(20000);
      return { data, error };
    }
    let resp = await fetchFrom('readings');
    if (resp.error) {
      console.warn('Supabase readings fetch error', resp.error.message);
    }
    if (resp.error || !resp.data || resp.data.length === 0) {
      // fallback to legacy telemetry table
      const tele = await fetchFrom('telemetry');
      if (tele.error) {
        console.warn('Supabase telemetry fetch error', tele.error.message);
      }
      resp = tele;
    }
    if (resp.error) {
      showToast('History fetch failed', 'error');
      return [];
    }
    const points = (resp.data || []).map(row => ({
      ts: new Date(row.ts).getTime(),
      t: typeof row.temperature === 'number' ? row.temperature : null,
      h: typeof row.humidity === 'number' ? row.humidity : null,
    })).filter(p => p.t !== null || p.h !== null).map(p => ({ ts: p.ts, t: p.t ?? (state.histData.length ? state.histData[state.histData.length-1].t : 24), h: p.h ?? (state.histData.length ? state.histData[state.histData.length-1].h : 55) }));
    // Downsample if too dense for rendering
    const MAX_DRAW_POINTS = 2000;
    if (points.length > MAX_DRAW_POINTS) {
      const stride = Math.ceil(points.length / MAX_DRAW_POINTS);
      const reduced = [];
      for (let i = 0; i < points.length; i += stride) reduced.push(points[i]);
      return reduced;
    }
    return points;
  }

  function startLive() {
    if (state.historyTimer) { clearInterval(state.historyTimer); state.historyTimer = null; }
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
    // Maintain a 1s cadence by repeating the last known value when the ESP32 is quiet
    state.liveTimer = setInterval(() => {
      if (state.range !== 'live') return;
      const last = state.liveData[state.liveData.length - 1];
      if (!last) {
        return;
      }
      const now = Date.now();
      if (now - last.ts >= LIVE_INTERVAL_MS) {
        pushLivePoint(last.t, last.h, now);
      }
    }, LIVE_INTERVAL_MS);
    // If we have no points yet, try seeding from DB (latest row)
    seedLiveFromDBOnce();
  }

  // Seed Live from DB if we haven't received any MQTT yet
  let liveSeeded = false;
  async function seedLiveFromDBOnce() {
    if (liveSeeded) return;
    if (!sb) return; // Supabase not configured on frontend
    try {
      const { data, error } = await sb
        .from('readings')
        .select('ts, temperature, humidity')
        .order('ts', { ascending: false })
        .limit(1);
      if (!error && data && data.length) {
        const row = data[0];
        const t = (typeof row.temperature === 'number') ? row.temperature : null;
        const h = (typeof row.humidity === 'number') ? row.humidity : null;
        if (t !== null || h !== null) {
          pushLivePoint(t ?? (state.liveData.at(-1)?.t ?? 24), h ?? (state.liveData.at(-1)?.h ?? 55), Date.parse(row.ts) || Date.now());
          liveSeeded = true;
        } else {
          // fallback to telemetry table
          const { data: d2, error: e2 } = await sb
            .from('telemetry')
            .select('ts, temperature, humidity')
            .order('ts', { ascending: false })
            .limit(1);
          if (!e2 && d2 && d2.length) {
            const r2 = d2[0];
            const t2 = (typeof r2.temperature === 'number') ? r2.temperature : null;
            const h2 = (typeof r2.humidity === 'number') ? r2.humidity : null;
            if (t2 !== null || h2 !== null) {
              pushLivePoint(t2 ?? (state.liveData.at(-1)?.t ?? 24), h2 ?? (state.liveData.at(-1)?.h ?? 55), Date.parse(r2.ts) || Date.now());
              liveSeeded = true;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Live seed fetch failed', e?.message || e);
    }
  }

  async function startHistory(rangeKey) {
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
    async function refreshOnce() {
      const pts = await loadHistory(rangeKey);
      state.histData = pts;
    }
    await refreshOnce();
    if (state.historyTimer) { clearInterval(state.historyTimer); state.historyTimer = null; }
    state.historyTimer = setInterval(() => {
      if (state.range === rangeKey) refreshOnce();
    }, HISTORY_REFRESH_MS);
  }

  // Expose controller
  window.THGraph = {
    setRange: async (rangeKey) => {
      if (!RANGE_MS[rangeKey]) rangeKey = 'live';
      state.range = rangeKey;
      state.viewStartAt = Date.now();
      setButtonsActive(rangeKey);
      publish('home/dashboard/graphRange', { range: rangeKey });
      if (rangeKey === 'live') {
        state.liveStartAt = Date.now();
        startLive();
      } else {
        await startHistory(rangeKey);
      }
    }
  };

  // Global stale-data monitor: runs regardless of range selection
  setInterval(() => {
    const banner = document.getElementById('live-stale-banner');
    if (!banner) return;
    const now = Date.now();
    const last = state.lastMqttAt || 0;
    const anchor = last || state.viewStartAt || 0;
    if (anchor && (now - anchor > 5000)) banner.removeAttribute('hidden');
    else banner.setAttribute('hidden', '');
  }, 1000);

  // Render loop
  function loop() {
    // draw every frame for smoothness; points are pushed by MQTT or history refresh
    draw();
    requestAnimationFrame(loop);
  }
  loop();

  // Default range
  window.THGraph.setRange('live');
})();

// threshold buttons with press-and-hold behavior
function changeThreshold(delta) {
  threshold = clamp(threshold + delta, 0, 100);
    thValEl.innerHTML = `${threshold}<sup>°C</sup>`;
  publishAndSuppress("home/dashboard/threshold", { threshold }, 'threshold', threshold);
  beginGuard('threshold', threshold, 600);
}

function makePressAndHold(btn, delta) {
  let holdTimer = null;
  let repeatTimer = null;
  let held = false;

  const START_DELAY = 350; // ms before repeating starts
  const REPEAT_MS = 90;    // repeat rate while holding

  function clearTimers() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
  }

  function startHold(e) {
    e.preventDefault();
    held = false;
    changeThreshold(delta); // single step immediately on press
    holdTimer = setTimeout(() => {
      held = true;
      repeatTimer = setInterval(() => changeThreshold(delta), REPEAT_MS);
    }, START_DELAY);
  }

  function endHold() {
    clearTimers();
  }

  // Pointer events support mouse and touch
  btn.addEventListener('pointerdown', startHold);
  btn.addEventListener('pointerup', endHold);
  btn.addEventListener('pointerleave', endHold);
  btn.addEventListener('pointercancel', endHold);

  // Prevent an extra click after a hold
  btn.addEventListener('click', (e) => { if (held) e.preventDefault(); });
}

makePressAndHold(thDec, -1);
makePressAndHold(thInc, +1);

// vent toggle
ventBtn.addEventListener("click", toggleVent);
function toggleVent() {
  ventActive = !ventActive;
  ventBtn.classList.toggle("active", ventActive);
  ventBtn.setAttribute("aria-pressed", String(ventActive));
  publishAndSuppress("home/dashboard/vent", { vent: ventActive }, 'vent', ventActive);
}

// servo slider - live update & publish
let sliderPublishTimer = null;
slider.addEventListener("input", (e) => {
  let a = Number(e.target.value);
  if (!Number.isFinite(a)) a = 0;
  if (a > maxAngleLimit) { a = maxAngleLimit; e.target.value = String(a); }
  const angleValue = angleEl.querySelector('.gauge-value');
  angleValue.innerHTML = `${Math.round(a)}<sup>°</sup>`;
  // Update 270° arc (0–maxAngleLimit maps to 0–1)
  setGaugeProgress(angleEl, a / Math.max(1, maxAngleLimit));
  // Debounce publish so servo moves during slide, not just on release
  if (sliderPublishTimer) clearTimeout(sliderPublishTimer);
  sliderPublishTimer = setTimeout(() => {
    const val = Math.round(Math.max(0, Math.min(maxAngleLimit, a)));
    // During sliding, treat as transient (final: false)
    publishAndSuppress("home/dashboard/window", { angle: val, final: false, source: 'slider' }, 'angle', val);
  }, 150);
});

slider.addEventListener("change", (e) => {
  let a = Number(e.target.value);
  if (!Number.isFinite(a)) a = 0;
  if (a > maxAngleLimit) { a = maxAngleLimit; e.target.value = String(a); }
  // Slider release -> final write
  const finalInt = Math.round(Math.max(0, Math.min(maxAngleLimit, a)));
  publishAndSuppress("home/dashboard/window", { angle: finalInt, final: true, source: 'slider' }, 'angle', finalInt);
  beginGuard('angle', finalInt, 700);
});

// allow auto toggle visual (no server action here unless you want)
autoToggle.addEventListener("click", () => {
  // Determine next state from current UI class
  const next = !autoToggle.classList.contains("active");
  // Optimistically update UI
  autoToggle.classList.toggle("active", next);
  autoToggle.setAttribute("aria-pressed", String(next));
  // Immediately reflect slider disabled state
  if (next) slider.classList.add("disabled"); else slider.classList.remove("disabled");
  // Self-suppress echo handling for a short window
  window.__autoSelf = { value: next, until: Date.now() + 800 };
  // publish auto toggle change
  publish("home/dashboard/auto", { auto: next });
});

// message handler - robust parse
if (client) client.on("message", (topic, message) => {
  // Device availability topic may be string payload (online/offline)
  if (topic === 'home/esp32/availability') {
    const payload = message.toString().trim().toLowerCase();
    if (payload === 'online' || payload === '1') {
      markDeviceSeen('availability');
      // Force a bridge check when device comes online, even if telemetry hasn't arrived yet
      checkBridgeNow(true);
    } else if (payload === 'offline' || payload === '0') {
      deviceOnline = false; updateStatusUI('availability-offline');
    }
    return; // handled
  }
  let data;
  try {
    data = JSON.parse(message.toString());
  } catch (e) {
    console.warn("Received non-JSON or invalid JSON message", topic, message.toString());
    return;
  }

  // flexible payload handling
  if (data.temperature !== undefined) {
    const tempValue = tempEl.querySelector('.gauge-value');
      tempValue.innerHTML = `${data.temperature}<sup>°C</sup>`;
    // 0–50°C -> 0–1
    setGaugeProgress(tempEl, Math.max(0, Math.min(50, data.temperature)) / 50);
    lastMqttTelemetryAt = Date.now();
    // Immediate DB bridge check on telemetry
    checkBridgeNow();
  }
  if (data.humidity !== undefined) {
    const humidValue = humidEl.querySelector('.gauge-value');
      humidValue.innerHTML = `${data.humidity}<sup>%</sup>`;
    // 0–100% -> 0–1
    setGaugeProgress(humidEl, Math.max(0, Math.min(100, data.humidity)) / 100);
    lastMqttTelemetryAt = Date.now();
    // Immediate DB bridge check on telemetry
    checkBridgeNow();
  }
  if (data.motion !== undefined) motionStatus.innerText = data.motion ? "Detected" : "Calm";
  // Do not infer Online from telemetry; rely strictly on availability
  if (data.windowAngle !== undefined) {
    const angleValue = angleEl.querySelector('.gauge-value');
    const incoming = Math.round(Math.max(0, Math.min(maxAngleLimit, data.windowAngle)));
    const adjusting = window.__angleDragging || (window.__angleAdjustingUntil && Date.now() < window.__angleAdjustingUntil);
    if (isGuardedMismatch('angle', incoming)) {
      return; // ignore older/mismatched echoes during guard window
    }
    if (!shouldSuppress('angle', incoming) && !adjusting) {
      updateAngleSmooth(incoming, false);
    }
  }
  if (data.angle !== undefined) {
    const angleValue = angleEl.querySelector('.gauge-value');
    const incoming = Math.round(Math.max(0, Math.min(maxAngleLimit, data.angle)));
    const adjusting = window.__angleDragging || (window.__angleAdjustingUntil && Date.now() < window.__angleAdjustingUntil);
    // If we have a guard and the incoming doesn't match the target, ignore
    if (isGuardedMismatch('angle', incoming)) {
      return;
    }
    // Special handling for final angle messages - apply immediately
    if (data.final === true) {
      // If we're still adjusting locally, ignore foreign finals to prevent snapback
      if (adjusting && !shouldSuppress('angle', incoming)) {
        return;
      }
      updateAngleSmooth(incoming, true); // snap immediately
      clearGuardIfMatch('angle', incoming);
    } else if (!shouldSuppress('angle', incoming) && !adjusting) {
      updateAngleSmooth(incoming, false);
    }
  }

  // Handle max angle limit broadcast
  if (data.max_angle !== undefined) {
    const lim = Math.max(1, Math.round(Number(data.max_angle)));
    applyMaxAngleLimit(lim);
  }

  // if payload carries 'auto' flag -> disable slider (greyed out) when auto true
  if (data.auto !== undefined) {
    // Suppress handling if this matches a very recent self change
    const self = window.__autoSelf;
    const ignore = self && Date.now() < self.until && self.value === data.auto;
    if (!ignore) {
      autoToggle.classList.toggle("active", !!data.auto);
      autoToggle.setAttribute("aria-pressed", String(!!data.auto));
    }
    // Disable/enable slider in auto mode regardless of suppression
    if (data.auto) slider.classList.add("disabled"); else slider.classList.remove("disabled");
  }

  // if payload carries threshold/vent states, update UI accordingly
  if (data.threshold !== undefined) {
    const incoming = clamp(Number(data.threshold), 0, 100);
    if (isGuardedMismatch('threshold', incoming)) {
      return; // ignore older/mismatched echoes during guard window
    }
    if (!shouldSuppress('threshold', incoming)) {
      threshold = incoming;
      thValEl.innerHTML = `${threshold}<sup>°C</sup>`;
    }
  }
  if (data.vent !== undefined) {
    const incoming = !!data.vent;
    if (!shouldSuppress('vent', incoming)) {
      ventActive = incoming;
      ventBtn.classList.toggle("active", ventActive);
      ventBtn.setAttribute("aria-pressed", String(ventActive));
    }
  }

  // example: grey out temp/humidity card if too hot
  const tempHumidityCard = document.querySelector(".row-2 .card");
  if (data.temperature !== undefined && data.temperature > 35) {
    tempHumidityCard.classList.add("disabled");
  } else {
    tempHumidityCard.classList.remove("disabled");
  }
});

// Angle gauge interactive dragging
(function enableAngleDrag() {
  const gauge = document.getElementById('window-angle');
  if (!gauge || !gauge.dataset.interactive) return;
  const svg = gauge.querySelector('svg');
  const knob = gauge.querySelector('.gauge-knob');
  const knobHit = gauge.querySelector('.gauge-knob-hit');
  const valueEl = gauge.querySelector('.gauge-value');
  const prog = gauge.querySelector('.gauge-progress');
  if (!svg || !knob || !valueEl || !prog) return;

  const cx = parseFloat(prog.getAttribute('cx'));
  const cy = parseFloat(prog.getAttribute('cy'));
  const r = parseFloat(prog.getAttribute('r'));

  // Optional snapping on release for nicer feel
  const SNAP_ENABLED = true;
  const SNAP_DEGREES = [0, 90, 180];
  const SNAP_DEADZONE = 6; // degrees

  let dragging = false;
  const PUBLISH_THROTTLE_MS = 120;
  let lastPublishAt = 0;
  let lastPublishedAngle = null;
  let trailingTimer = null;
  let currentAngleInt = 90; // track the UI's last rounded angle during drag

  // Track global dragging state to suppress incoming angle echoes
  window.__angleDragging = false;

  // Convert pointer client coords to SVG coordinate space to avoid jitter due to scaling
  const pt = svg.createSVGPoint ? svg.createSVGPoint() : null;
  function toSvgCoords(clientX, clientY) {
    if (!pt || !svg.getScreenCTM) return { x: clientX, y: clientY };
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm || !ctm.inverse) return { x: clientX, y: clientY };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function pointToFraction(clientX, clientY) {
    const p = toSvgCoords(clientX, clientY);
    // Convert to SVG coordinates relative to center
    const vx = p.x - cx;
    const vy = p.y - cy;
    let theta = Math.atan2(vy, vx); // [-PI, PI], 0 at +X, CCW positive
    let deg = theta * 180 / Math.PI; // [-180, 180]
    // Undo group rotation (+135°) so 0° is the start of the 270° track
    deg -= 135;
    // Normalize to [0, 360)
    while (deg < 0) deg += 360;
    while (deg >= 360) deg -= 360;
    // The track covers [0,270]; the gap is (270,360).
    // If pointer is in the gap, snap to nearest end. Prefer 0 over 270 to avoid jump to max.
    if (deg > 270) {
      deg = 0; // snap into start of arc, not to 270
    } else if (deg < 0) {
      deg = 0;
    }
    // Clamp to [0, 270]
    deg = Math.max(0, Math.min(270, deg));
    // Convert to fraction [0,1]
    return deg / 270;
  }

  function applyFraction(f, publishMQTT) {
    // Compute desired angle from fraction of current maxAngleLimit
    let angle = Math.round(f * Math.max(1, maxAngleLimit));
    if (angle > maxAngleLimit) angle = maxAngleLimit;
    const fractionUsed = angle / Math.max(1, maxAngleLimit);
    setGaugeProgress(gauge, fractionUsed);
    valueEl.innerHTML = `${angle}<sup>°</sup>`;
    currentAngleInt = angle;
    if (publishMQTT) {
      // Pointer up (release) path uses publishMQTT=true -> final
      publishAndSuppress('home/dashboard/window', { angle, final: true, source: 'knob' }, 'angle', angle);
      beginGuard('angle', angle, 700);
      // Update the slider to match exactly what we published
      if (slider) slider.value = String(angle);
    }
  }

  function onPointerDown(e) { dragging = true; window.__angleDragging = true; knob.setPointerCapture?.(e.pointerId); onPointerMove(e); }
  function onPointerMove(e) {
    if (!dragging) return;
    const f = pointToFraction(e.clientX, e.clientY);
    applyFraction(f, false);
    // Throttled live publish while dragging
  let angle = Math.round(f * Math.max(1, maxAngleLimit));
    if (angle > maxAngleLimit) angle = maxAngleLimit;
    const now = Date.now();
    const shouldPub = (now - lastPublishAt) >= PUBLISH_THROTTLE_MS && angle !== lastPublishedAngle;
    if (shouldPub) {
      // Transient publish during drag
      publishAndSuppress('home/dashboard/window', { angle, final: false, source: 'knob' }, 'angle', angle);
      lastPublishAt = now;
      lastPublishedAngle = angle;
    } else {
      // Schedule a trailing publish to send the latest if we haven't recently
      if (!trailingTimer) {
        trailingTimer = setTimeout(() => {
          let latest = Math.round((pointToFraction(e.clientX, e.clientY)) * Math.max(1, maxAngleLimit));
          if (latest > maxAngleLimit) latest = maxAngleLimit;
          // Still transient during drag
          publishAndSuppress('home/dashboard/window', { angle: latest, final: false, source: 'knob' }, 'angle', latest);
          lastPublishAt = Date.now();
          lastPublishedAngle = latest;
          trailingTimer = null;
        }, PUBLISH_THROTTLE_MS);
      }
    }
  }
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    window.__angleDragging = false;
    // Use the last displayed integer angle to avoid off-by-one due to resampling
    let finalAngle = currentAngleInt;
    if (SNAP_ENABLED) {
      let snapped = finalAngle;
      let bestDiff = Infinity;
      for (const s of SNAP_DEGREES) {
        const diff = Math.abs(finalAngle - s);
        if (diff < bestDiff) { bestDiff = diff; snapped = s; }
      }
      if (bestDiff <= SNAP_DEADZONE) {
        finalAngle = snapped;
      }
    }
  if (finalAngle > maxAngleLimit) finalAngle = maxAngleLimit;
  let f = finalAngle / Math.max(1, maxAngleLimit);
    // Clear any trailing timer
    if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
    applyFraction(f, true);
  }

  // Attach handlers to both the visual knob and the larger invisible hit area
  if (knobHit) knobHit.addEventListener('pointerdown', onPointerDown);
  knob.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  // Do not force an initial knob position; wait for data or user input
})();

// Angle gauge: mouse wheel – low-latency with light throttle
(function enableAngleWheelAdjust() {
  const gauge = document.getElementById('window-angle');
  if (!gauge) return;
  const valueEl = gauge.querySelector('.gauge-value');
  const sliderEl = document.getElementById('servo-slider');
  let wheelPublishTimer = null;
  let lastWheelApplyAt = 0; // throttle UI updates to ~60fps
  let currentWheelAngle = null; // local source of truth during wheel adjustments
  const FRAME_MS = 16;
  const PUBLISH_MS = 150;

  function applyAngleUI(angleDeg) {
    const clamped = Math.max(0, Math.min(maxAngleLimit, Math.round(angleDeg)));
    currentWheelAngle = clamped;
    if (valueEl) valueEl.innerHTML = `${clamped}<sup>°</sup>`;
    setGaugeProgress(gauge, clamped / Math.max(1, maxAngleLimit));
    if (sliderEl) sliderEl.value = String(clamped);
  }

  function publishFinal(angleDeg) {
    const clamped = Math.max(0, Math.min(maxAngleLimit, Math.round(angleDeg)));
    publishAndSuppress('home/dashboard/window', { angle: clamped, final: true, source: 'wheel' }, 'angle', clamped);
    beginGuard('angle', clamped, 700);
  }

  function readAngleFromUI() {
    // Prefer the displayed number; fallback to slider; else 0
    let uiVal = NaN;
    if (valueEl) {
      const t = valueEl.textContent;
      uiVal = parseInt(t);
    }
    if (!Number.isFinite(uiVal) && sliderEl) {
      const s = Number(sliderEl.value);
      if (Number.isFinite(s)) uiVal = s;
    }
    if (!Number.isFinite(uiVal)) uiVal = 0;
    return Math.max(0, Math.min(maxAngleLimit, Math.round(uiVal)));
  }

  function onWheel(e) {
    // Only act when hovering over the gauge; prevent page scroll while adjusting
    e.preventDefault();
    if (window.__angleDragging) return; // ignore while dragging knob
  // Mark a brief self-adjust window to ignore angle echoes (extend a bit)
  window.__angleAdjustingUntil = Date.now() + 600;
    // Cancel any remote smoothing while we adjust locally
    if (angleAnim.rafId) { cancelAnimationFrame(angleAnim.rafId); angleAnim.active = false; }
    // Always sync to the latest UI value so wheel starts from current angle
    currentWheelAngle = readAngleFromUI();
    // Step: small per notch; Ctrl for larger jumps
    const baseStep = e.ctrlKey ? 3 : 1;
    const dir = (e.deltaY > 0 ? -1 : 1); // wheel up increases angle
  const next = Math.max(0, Math.min(maxAngleLimit, currentWheelAngle + dir * baseStep));
  currentWheelAngle = next;
  // Refresh a short guard with the latest local angle to ignore older echoes
  beginGuard('angle', currentWheelAngle, 600);
    // Light throttle: update UI at most once per animation frame
    const now = Date.now();
    if (now - lastWheelApplyAt >= FRAME_MS) {
      applyAngleUI(currentWheelAngle);
      lastWheelApplyAt = now;
    }

    // Debounce MQTT publish to avoid spamming while scrolling
    if (wheelPublishTimer) clearTimeout(wheelPublishTimer);
    wheelPublishTimer = setTimeout(() => {
      // Ensure UI shows the final value we will publish
      if (currentWheelAngle != null) applyAngleUI(currentWheelAngle);
      publishFinal(currentWheelAngle != null ? currentWheelAngle : (valueEl ? parseInt(valueEl.textContent) || 0 : 0));
    }, PUBLISH_MS);
  }

  gauge.addEventListener('wheel', onWheel, { passive: false });
})();
