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
console.log = console.warn = console.info = console.debug = () => {};
const DEBUG_LOGS = !!window.DEBUG_LOGS; // set window.DEBUG_LOGS = true to enable verbose logs
const log = DEBUG_LOGS ? console.log.bind(console) : () => {};
const info = DEBUG_LOGS ? console.info?.bind(console) || console.log.bind(console) : () => {};
const warn = DEBUG_LOGS ? console.warn.bind(console) : () => {};
// Runtime toggle: set window.SHOW_BRIDGE_BANNER = true (before this script loads)
// to allow the MQTT→DB bridge offline banner to appear. Default is false to
// keep the UI clean without removing banner code.
const SHOW_BRIDGE_BANNER = (typeof window.SHOW_BRIDGE_BANNER !== 'undefined') ? !!window.SHOW_BRIDGE_BANNER : false;
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

// Global live data arrays for graph
window.liveData = (() => {
  try {
    const stored = localStorage.getItem('liveData');
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.warn('Failed to load liveData from localStorage', e);
    return [];
  }
})();
window.histData = [];
// Last save timestamp for liveData persistence
let lastLiveDataSave = 0;
// Save liveData on page unload
window.addEventListener('beforeunload', () => {
  try {
    localStorage.setItem('liveData', JSON.stringify(window.liveData));
  } catch (e) {
    console.warn('Failed to save liveData on unload', e);
  }
});
// Global graph state
window.graphState = { range: 'live' };

// Device presence tracking (ESP32): show Offline until device availability says Online
let deviceOnline = false; // Amber early-warning removed (reverted to immediate offline model)
// Bridge offline banner state
let bridgeOnline = null; // null = unknown, true/false when known
let bridgeDismissed = false; // user dismissed while offline; reset when online
let bridgeFallbackTimer = null;
let wasBridgeOnline = false; // track previous state to detect transitions
// Startup health tracking
let startupHealthy = false; // becomes true on a healthy signal (settings row present, successful write, or bridge_status online)
let startupPresenceTimer = null; // delayed presence check timer
let startupFallbackTimer = null;  // fallback timer
// Device heartbeat / availability enhancements
// Updated to match ESP32 firmware topics; keep old topic for backward compatibility
const DEVICE_AVAILABILITY_TOPIC = 'home/window/status';
const LEGACY_DEVICE_AVAILABILITY_TOPIC = 'home/esp32/availability';
const DEVICE_HEARTBEAT_TOPIC = 'home/window/heartbeat';
const HEARTBEAT_EXPECTED_INTERVAL_MS = 30000; // default/fallback expected device heartbeat interval
// Dynamic expected interval (updated from heartbeat payload if it includes interval_ms)
let heartbeatExpectedMs = HEARTBEAT_EXPECTED_INTERVAL_MS;
// Factor for declaring device offline due to heartbeat silence (was 2.2 → now faster)
let HEARTBEAT_STALE_FACTOR = 1.5; // offline if no heartbeat after ~1.5 × expected
const PRESENCE_OFFLINE_HARD_MS  = 6500;   // hard cap for offline (retained)
// Runtime overrides for tuning (set before script loads or inject via console):
//   window.HEARTBEAT_EXPECTED_MS = 10000; window.HEARTBEAT_STALE_FACTOR = 1.2;
try {
  if (typeof window !== 'undefined') {
    if (Number.isFinite(Number(window.HEARTBEAT_EXPECTED_MS))) {
      const v = Number(window.HEARTBEAT_EXPECTED_MS);
      if (v >= 1000 && v <= 300000) { heartbeatExpectedMs = v; }
    }
    if (Number.isFinite(Number(window.HEARTBEAT_STALE_FACTOR))) {
      const f = Number(window.HEARTBEAT_STALE_FACTOR);
      if (f >= 1.05 && f <= 3) { HEARTBEAT_STALE_FACTOR = f; }
    }
    // Probable / amber overrides removed
  }
} catch {}
// Faster offline reaction debounce (was 1500ms). Keeps brief reconnect blips filtered but feels snappier.
const OFFLINE_DEBOUNCE_MS = 600;
let lastHeartbeatAt = 0;
let heartbeatCheckTimer = null;
let deviceOfflineDebounceTimer = null;
// Track whether we've ever received at least one heartbeat; prevents false offline
// transitions when the device firmware doesn't publish heartbeat messages. Without
// this, the absence of heartbeats (lastHeartbeatAt = 0) could cause the UI to
// consider the device offline purely due to timer logic once we add generic
// monitoring. We only allow heartbeat-based offline determination AFTER at least
// one heartbeat has been seen in the current session.
let heartbeatSeen = false;
// Fast bridge ping/pong probe config
const BRIDGE_PING_FAST_MS = 100;          // rapid probe interval on startup
const BRIDGE_PING_FAST_BURST = 10;        // number of fast probes before backing off (~1s)
const BRIDGE_PING_SLOW_MS = 1500;         // slow probe interval after burst
const BRIDGE_STARTUP_FALLBACK_MS = 750;   // show banner quickly if no healthy signal
let bridgePingTimer = null;               // interval timer for pings
let bridgePingAttempts = 0;               // attempts in current burst
const bridgeBanner = document.getElementById('bridge-banner');
// Wire dismiss (X) and swipe-to-dismiss for bridge banner
if (bridgeBanner) {
  const closeBtn = bridgeBanner.querySelector('.close');
  function animateDismissRandomBridge() {
    const dir = Math.random() < 0.5 ? -1 : 1;
    bridgeDismissed = true;
    bridgeBanner.classList.add('transitioning');
    bridgeBanner.style.opacity = '0';
    bridgeBanner.style.transform = `translateX(${dir * 160}px)`;
    setTimeout(() => {
      bridgeBanner.classList.remove('show');
      bridgeBanner.setAttribute('aria-hidden', 'true');
      bridgeBanner.classList.remove('transitioning');
      bridgeBanner.style.transform = '';
      bridgeBanner.style.opacity = '';
    }, 150);
  }
  if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); animateDismissRandomBridge(); });
  let startX = null; let swiping = false; let currentDx = 0;
  function endSwipeBridge(shouldDismiss) {
    if (shouldDismiss) {
      bridgeDismissed = true;
      bridgeBanner.classList.add('transitioning');
      bridgeBanner.style.opacity = '0';
      bridgeBanner.style.transform = `translateX(${currentDx > 0 ? 160 : -160}px)`;
      setTimeout(() => {
        bridgeBanner.classList.remove('show');
        bridgeBanner.setAttribute('aria-hidden', 'true');
        bridgeBanner.classList.remove('transitioning');
        bridgeBanner.style.transform = '';
        bridgeBanner.style.opacity = '';
      }, 150);
    } else {
      bridgeBanner.classList.add('transitioning');
      bridgeBanner.style.transform = 'translateX(0)';
      setTimeout(() => { bridgeBanner.classList.remove('transitioning'); }, 300);
    }
    swiping = false; startX = null; currentDx = 0; bridgeBanner.classList.remove('swiping');
  }
  bridgeBanner.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.close')) return;
    startX = e.clientX; swiping = true; currentDx = 0; bridgeBanner.classList.add('swiping');
    bridgeBanner.setPointerCapture?.(e.pointerId);
  });
  bridgeBanner.addEventListener('pointermove', (e) => {
    if (!swiping || startX == null) return;
    currentDx = e.clientX - startX;
    bridgeBanner.style.transform = `translateX(${currentDx}px)`;
  });
  bridgeBanner.addEventListener('pointerup', () => {
    if (!swiping) return;
    const threshold = 48;
    const shouldDismiss = Math.abs(currentDx) > threshold;
    endSwipeBridge(shouldDismiss);
  });
}

function setBridgeBannerVisible(visible) {
  // Respect runtime toggle: if showing the banner is disabled, do nothing.
  if (!SHOW_BRIDGE_BANNER) return;
  if (!bridgeBanner) return;
  if (visible && !bridgeDismissed) {
    bridgeBanner.classList.add('show');
    bridgeBanner.setAttribute('aria-hidden', 'false');
  } else {
    bridgeBanner.classList.remove('show');
    bridgeBanner.setAttribute('aria-hidden', 'true');
  }
}

// Hide banner due to successful DB interaction; also reset dismissal so future offline can show again
function noteDbSuccess() {
  setBridgeBannerVisible(false);
  bridgeDismissed = false;
  startupHealthy = true;
}

// Push accumulated liveData to DB when bridge comes online
async function pushLiveDataToDb() {
  if (!sb || !window.liveData.length) return;
  const rows = window.liveData.map(p => ({
    ts: new Date(p.ts).toISOString(),
    temperature: p.t,
    humidity: p.h
  }));
  try {
    const { error } = await sb.from('readings').insert(rows);
    if (error) {
      console.warn('Failed to push liveData to DB:', error.message);
    } else {
      console.log(`Pushed ${rows.length} liveData points to DB`);
      // Optionally clear localStorage after successful push
      localStorage.removeItem('liveData');
    }
  } catch (e) {
    console.warn('Error pushing liveData to DB:', e);
  }
}

// Only show bridge banner for network/service outages, not for empty data, schema, or permission errors
function maybeShowBridgeBannerForDbError(err) {
  try {
    const status = err?.status;
    const code = (err?.code || '').toString();
    const msg = (err?.message || String(err) || '').toLowerCase();
    // Treat as network/outage if status is 0/undefined with fetch failure, or 408/5xx, or message mentions network/timeout
    const isNetwork = (
      status === 0 || status === undefined || status === null ||
      status === 408 || (typeof status === 'number' && status >= 500) ||
      msg.includes('failed to fetch') || msg.includes('network') || msg.includes('timeout') || msg.includes('fetch')
    );
    if (isNetwork) { setBridgeBannerVisible(true); return true; }
    // Schema missing or permission denied -> do not equate to bridge offline
    // Common Postgres code: 42P01 (relation does not exist); ignore for banner
    if (code === '42P01' || msg.includes('relation') && msg.includes('does not exist')) return false;
  } catch {}
  return false;
}

function updateStatusUI(stateHint) {
  const dot = document.getElementById('mqtt-status');
  const text = document.getElementById('mqtt-status-text');
  // If broker is disconnected, always show Offline
  if (!client || !client.connected) {
    if (dot) { dot.className = 'status-dot offline'; dot.title = 'Window Offline'; dot.setAttribute('aria-label', 'MQTT Offline'); }
    if (text) { text.textContent = 'Window Offline'; }
    return;
  }
  const now = Date.now();
  const age = lastHeartbeatAt ? now - lastHeartbeatAt : Infinity;
  if (!deviceOnline) {
    const label = 'Window Offline';
    if (dot) {
      const ageTxt = lastHeartbeatAt ? ((Date.now() - lastHeartbeatAt)/1000).toFixed(1)+'s ago' : 'never';
      dot.className = 'status-dot offline';
      dot.title = `${label}\nLast heartbeat: ${ageTxt}`;
      dot.setAttribute('aria-label', label);
    }
    if (text) { text.textContent = label; }
    return;
  }
  if (dot) {
    const ageTxt = lastHeartbeatAt ? ((Date.now() - lastHeartbeatAt)/1000).toFixed(1)+'s ago' : 'n/a';
    dot.className = 'status-dot online';
    dot.title = `Window Online\nLast heartbeat: ${ageTxt} (expected ~${Math.round(heartbeatExpectedMs/1000)}s)`;
    dot.setAttribute('aria-label', 'Device Online');
  }
  if (text) { text.textContent = 'Window Online'; }
  if (dot) {
    const fresh = lastHeartbeatAt && age < heartbeatExpectedMs * 1.2;
    if (fresh) dot.classList.add('pulse'); else dot.classList.remove('pulse');
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
  console.log("Connected to MQTT broker");
  showToast(`MQTT connected`, 'success');
  // On broker connect, do not mark Online until device is seen
  mqttConnected = true;
  // Initialize per-sensor last-seen timestamps
  const nowInitial = Date.now();
  lastDhtAt = nowInitial;
  hideBanner(dhtBanner);
  deviceOnline = false;
  updateStatusUI('broker-connected');
  client.subscribe("home/dashboard/data");
  // also subscribe window/topic in case device publishes separate topics
  client.subscribe("home/dashboard/window");
  // subscribe to settings topics so changes in one tab reflect in others
  client.subscribe("home/dashboard/threshold");
  client.subscribe("home/dashboard/vent");
  client.subscribe("home/dashboard/auto");
  client.subscribe("home/dashboard/angle_special");
  // graph range (for cross-tab sync)
  try { client.subscribe("home/dashboard/graphRange", { rh: 2 }); } catch { client.subscribe("home/dashboard/graphRange"); }
  // Bridge status (retained) for red banner
  try { client.subscribe('home/dashboard/bridge_status'); } catch { client.subscribe('home/dashboard/bridge_status'); }
  // If no retained bridge_status message is received within 5 seconds, assume offline
  setTimeout(() => {
    if (bridgeOnline === null) {
      if (DEBUG_LOGS) console.debug('[bridge-banner] No bridge_status received within 5s, assuming offline');
      bridgeOnline = false;
      setBridgeBannerVisible(true);
    }
  }, 5000);
  // Do not assume offline on startup; rely on explicit retained/live status or write failures
  bridgeOnline = null;
  bridgeDismissed = false;
  if (bridgeFallbackTimer) { clearTimeout(bridgeFallbackTimer); bridgeFallbackTimer = null; }
  // Active ping to detect live bridge even without retained status
  try { client.subscribe('home/dashboard/bridge_pong', { rh: 0 }); } catch { client.subscribe('home/dashboard/bridge_pong'); }
  // Start rapid ping probe loop with backoff
  bridgePingAttempts = 0;
  if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
  const sendBridgePing = () => {
    if (startupHealthy || bridgeOnline === true) {
      if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
      return;
    }
    const id = Math.random().toString(36).slice(2);
    try { client.publish('home/dashboard/bridge_ping', JSON.stringify({ id })); } catch {}
    bridgePingAttempts++;
    if (bridgePingAttempts === BRIDGE_PING_FAST_BURST) {
      // Switch to slow interval to avoid spamming broker
      if (bridgePingTimer) { clearInterval(bridgePingTimer); }
      bridgePingTimer = setInterval(sendBridgePing, BRIDGE_PING_SLOW_MS);
    }
  };
  bridgePingTimer = setInterval(sendBridgePing, BRIDGE_PING_FAST_MS);
  // Fire an immediate ping
  sendBridgePing();
  // Quick fallback after connect; if still not healthy, show banner
  if (startupFallbackTimer) { clearTimeout(startupFallbackTimer); }
  startupFallbackTimer = setTimeout(() => {
    if (!startupHealthy) {
      setBridgeBannerVisible(true);
    }
  }, BRIDGE_STARTUP_FALLBACK_MS);
  // Optionally run presence check after connect (doesn't affect banner now)
  if (startupPresenceTimer) { clearTimeout(startupPresenceTimer); }
  startupPresenceTimer = setTimeout(() => { checkSettingsPresenceOnce(); }, 2000);
  // dev-only max angle limit broadcast
  client.subscribe("home/dashboard/max_angle");
  // device availability topic (retained LWT or explicit publishes)
  // Subscribe new + legacy availability topics
  try { client.subscribe(DEVICE_AVAILABILITY_TOPIC, { rh: 2 }); } catch { client.subscribe(DEVICE_AVAILABILITY_TOPIC); }
  try { client.subscribe(LEGACY_DEVICE_AVAILABILITY_TOPIC, { rh: 2 }); } catch { client.subscribe(LEGACY_DEVICE_AVAILABILITY_TOPIC); }
  try { client.subscribe(DEVICE_HEARTBEAT_TOPIC, { rh: 0 }); } catch { client.subscribe(DEVICE_HEARTBEAT_TOPIC); }
  // Start / restart heartbeat stale monitor
  if (heartbeatCheckTimer) { clearInterval(heartbeatCheckTimer); }
  const startHeartbeatMonitor = () => {
    if (heartbeatCheckTimer) { clearInterval(heartbeatCheckTimer); }
    const interval = Math.max(2000, Math.min(heartbeatExpectedMs / 2, 10000));
    heartbeatCheckTimer = setInterval(() => {
      if (!deviceOnline) return;
      if (!lastHeartbeatAt) return;
      const age = Date.now() - lastHeartbeatAt;
      const staleThresh = heartbeatExpectedMs * HEARTBEAT_STALE_FACTOR;
      const hardOffline = age > PRESENCE_OFFLINE_HARD_MS;
      if (age > Math.min(staleThresh, PRESENCE_OFFLINE_HARD_MS) || age > PRESENCE_OFFLINE_HARD_MS) {
        deviceOnline = false;
        updateStatusUI('heartbeat-timeout');
      }
    }, interval);
  };
  startHeartbeatMonitor();
  // (Bridge DB check removed)
});

if (client) client.on("error", (err) => {
  console.error("MQTT error", err);
  showToast(`MQTT error: ${err?.message || err}`, 'error');
  mqttConnected = false;
  deviceOnline = false;
  updateStatusUI('error');
  // Hide bridge banner while broker is errored/disconnected
  setBridgeBannerVisible(false);
  if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
  if (startupFallbackTimer) { clearTimeout(startupFallbackTimer); startupFallbackTimer = null; }
});

if (client) client.on("reconnect", () => {
  mqttConnected = false;
  deviceOnline = false;
  updateStatusUI('reconnect');
  setBridgeBannerVisible(false);
  if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
  if (startupFallbackTimer) { clearTimeout(startupFallbackTimer); startupFallbackTimer = null; }
});

if (client) client.on("close", () => {
  mqttConnected = false;
  deviceOnline = false;
  updateStatusUI('close');
  showToast('MQTT connection closed', 'error');
  setBridgeBannerVisible(false);
});

if (client) client.on("offline", () => {
  mqttConnected = false;
  deviceOnline = false;
  updateStatusUI('broker-offline');
  showToast('MQTT offline', 'error');
  setBridgeBannerVisible(false);
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

// Per-sensor no data banners
let mqttConnected = false;
const NO_DATA_MS = 10000;
let lastDhtAt = 0;      // temperature/humidity
const dhtBanner = document.getElementById('dht-banner');
function initBannerSwipe(el,key){ if(!el) return; let sx=null,sw=false,dx=0; const btn=el.querySelector('.close'); function dismiss(anim=true){ if(anim){ const dir=Math.random()<0.5?-1:1; el.classList.add('transitioning'); el.style.opacity='0'; el.style.transform=`translateX(${dir*160}px)`; setTimeout(()=>{ el.classList.remove('show'); el.setAttribute('aria-hidden','true'); el.classList.remove('transitioning'); el.style.opacity=''; el.style.transform=''; },150);} else { el.classList.remove('show'); el.setAttribute('aria-hidden','true'); } window.__bannerDismissed=window.__bannerDismissed||{}; window.__bannerDismissed[key]=true; }
 if(btn) btn.addEventListener('click',e=>{e.stopPropagation();dismiss(true);});
 el.addEventListener('pointerdown',e=>{ if(e.button!==0) return; if(e.target.closest && e.target.closest('.close')) return; sx=e.clientX; sw=true; dx=0; el.classList.add('swiping'); el.setPointerCapture?.(e.pointerId); });
 el.addEventListener('pointermove',e=>{ if(!sw||sx==null) return; dx=e.clientX-sx; el.style.transform=`translateX(${dx}px)`; });
 el.addEventListener('pointerup',()=>{ if(!sw) return; const should=Math.abs(dx)>48; if(should) dismiss(true); else { el.classList.add('transitioning'); el.style.transform='translateX(0)'; setTimeout(()=>el.classList.remove('transitioning'),300);} sw=false; sx=null; dx=0; el.classList.remove('swiping'); }); }
initBannerSwipe(dhtBanner,'dht');
function showBanner(el,key){ if(!el) return; window.__bannerDismissed=window.__bannerDismissed||{}; if(window.__bannerDismissed[key]) return; el.classList.add('show'); el.setAttribute('aria-hidden','false'); }
function hideBanner(el){ if(!el) return; el.classList.remove('show'); el.setAttribute('aria-hidden','true'); }
setInterval(()=>{ if(!mqttConnected || !window.__sensorFlagsSnapshot?.dht11_enabled){ hideBanner(dhtBanner); return; } const now=Date.now(); if(lastDhtAt && now-lastDhtAt>NO_DATA_MS) showBanner(dhtBanner,'dht'); else if(lastDhtAt && now-lastDhtAt<=NO_DATA_MS) hideBanner(dhtBanner); },1000);

// initial state
let threshold = 23;
let ventActive = false;
let espOverrideEnabled = !!(window.ESP_OVERRIDE_ENABLED !== false); // default true, set window.ESP_OVERRIDE_ENABLED = false to disable
// When true, the angle knob/slider are disabled and user interactions ignored
let knobDisabled = false;
// Max angle limit (dev-only setting broadcast via MQTT and optionally from Supabase)
let maxAngleLimit = 180;
// Last-seen max_angle value from MQTT (if any)
let lastMaxAngleSeen = null;
// Bridge-provided max_angle tracking
let bridgeHasMaxAngle = false;
let lastBridgeMaxAngle = null;
let pendingBridgeMaxAngleRequest = false;

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

function setKnobDisabled(disabled) {
  knobDisabled = !!disabled;
  // UI: grey out slider and disable pointer interactions
  try {
    const sliderEl = document.getElementById('servo-slider');
    const gauge = document.getElementById('window-angle');
    if (sliderEl) {
      if (knobDisabled) {
        sliderEl.classList.add('disabled');
        sliderEl.setAttribute('disabled', 'true');
      } else {
        sliderEl.classList.remove('disabled');
        sliderEl.removeAttribute('disabled');
      }
    }
    if (gauge) {
      if (knobDisabled) {
        // Use a specific class so the global .disabled rule doesn't grey the whole gauge
        gauge.classList.add('knob-disabled');
      } else {
        gauge.classList.remove('knob-disabled');
      }
    }
  } catch (e) { /* non-fatal UI update failure */ }
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
  // (Banners removed; no dismiss wiring)
  // Sensor gear/menu (informational only for now)
  const gear = document.getElementById('sensor-gear');
  const menu = document.getElementById('sensor-menu');
  if (gear && menu) {
    function closeMenu(){ gear.setAttribute('aria-expanded','false'); menu.classList.remove('show'); menu.setAttribute('aria-hidden','true'); }
    function openMenu(){ gear.setAttribute('aria-expanded','true'); menu.classList.add('show'); menu.setAttribute('aria-hidden','false'); }
    gear.addEventListener('click', (e)=>{ e.stopPropagation(); const expanded = gear.getAttribute('aria-expanded') === 'true'; if(expanded) closeMenu(); else openMenu(); });
    document.addEventListener('click',(e)=>{ if(!menu.contains(e.target) && e.target!==gear) closeMenu(); });
    // No change handlers yet - future logic will hook here.
  }
});

// helpers
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function publish(topic, payload) {
  if (!client || !client.connected) return;
  try { client.publish(topic, JSON.stringify(payload)); }
  catch (e) { console.warn("Publish failed", e); }
}

// Stream publishing helper: frontend publishes continuous transient angle updates
// to `home/dashboard/window/stream`. By default this is enabled unless the host
// explicitly sets window.FRONTEND_PUBLISH_WINDOW_STREAM = false before loading.
const FRONTEND_PUBLISH_WINDOW_STREAM = (typeof window.FRONTEND_PUBLISH_WINDOW_STREAM === 'boolean') ? window.FRONTEND_PUBLISH_WINDOW_STREAM : true;
function publishWindowStream(payload) {
  try {
    if (!FRONTEND_PUBLISH_WINDOW_STREAM) return;
    if (!client) {
      if (DEBUG_LOGS) console.debug('[stream] no mqtt client, skipping', payload);
      return;
    }
    if (!client.connected) {
      if (DEBUG_LOGS) console.debug('[stream] mqtt not connected, skipping', payload);
      return;
    }
    // Ensure transient messages carry final: false unless explicitly set
    if (payload.final === undefined) payload.final = false;
    client.publish('home/dashboard/window/stream', JSON.stringify(payload));
    if (DEBUG_LOGS) console.debug('[stream] published', payload);
  } catch (e) {
    console.warn('[stream] publish failed', e?.message || e);
  }
}

// Optional: set window.FRONTEND_PUBLISH_WINDOW_STREAM = true in the console or
// injected config to have the frontend publish transient angle updates directly
// to `home/dashboard/window/stream`. Devices can subscribe there for low-latency
// continuous updates while the user moves knob/slider. Default: disabled.

// --- Grouped settings publish (frontend -> MQTT topic independent of bridge) ---
// Publishes a snapshot of current settings to `home/dashboard/settings` (non-retained).
// If MQTT isn't connected, attempts a best-effort fallback to POST /api/publish-settings (Vercel endpoint) if available.
let __groupedPublishTimer = null;
function buildGroupedSettingsPayload() {
  const angleText = angleEl?.querySelector('.gauge-value')?.textContent || '';
  const angleVal = parseInt(angleText) || (slider ? Number(slider.value) : undefined);
  const payload = {
    threshold: Number.isFinite(Number(threshold)) ? threshold : undefined,
    vent: typeof ventActive === 'boolean' ? ventActive : undefined,
    auto: autoToggle ? autoToggle.classList.contains('active') : undefined,
    angle: Number.isFinite(Number(angleVal)) ? angleVal : undefined,
    max_angle: Number.isFinite(Number(maxAngleLimit)) ? maxAngleLimit : undefined,
    esp_override_enabled: espOverrideEnabled,
    knob_disabled: knobDisabled,
    graph_range: (window.__initialGraphRangeKey || undefined)
  };
  // Sensor flags snapshot if available
  if (window.__sensorFlagsSnapshot) {
    payload.dht11_enabled = window.__sensorFlagsSnapshot.dht11_enabled;
    payload.water_enabled = window.__sensorFlagsSnapshot.water_enabled;
    payload.hw416b_enabled = window.__sensorFlagsSnapshot.hw416b_enabled;
  }
  // Clean undefineds
  Object.keys(payload).forEach(k => { if (payload[k] === undefined) delete payload[k]; });
  payload.source = 'dashboard';
  return payload;
}

async function publishGroupedSettings(payload, alwaysOverride = false) {
  // Auto-suppression: if the bridge is known to be online, avoid duplicating grouped publishes
  // unless explicitly overridden by window.FRONTEND_ALWAYS_PUBLISH_SETTINGS = true
  try {
    const always = alwaysOverride || !!(window && window.FRONTEND_ALWAYS_PUBLISH_SETTINGS);
    if (!always && typeof bridgeOnline !== 'undefined' && bridgeOnline === true) {
      // Bridge is online -> skip frontend grouped snapshot to avoid duplicates
      if (DEBUG_LOGS) console.debug('[settings] suppressed frontend grouped publish because bridgeOnline=true');
      return { ok: false, via: 'suppressed' };
    }
  } catch (e) { /* ignore */ }
  // Try MQTT first (non-retained)
  try {
    if (client && client.connected) {
      client.publish('home/dashboard/settings', JSON.stringify(payload), { retain: false });
      return { ok: true, via: 'mqtt' };
    }
  } catch (e) {
    console.warn('[settings] MQTT publish failed', e?.message || e);
  }
  // Fallback: attempt server endpoint
  try {
    const res = await fetch('/api/publish-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) return { ok: true, via: 'http' };
    const txt = await res.text().catch(() => '');
    console.warn('[settings] HTTP publish failed', res.status, txt);
    return { ok: false, error: `http ${res.status}` };
  } catch (e) {
    console.warn('[settings] HTTP publish attempt failed', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

function scheduleGroupedPublish(delay = 250) {
  if (__groupedPublishTimer) clearTimeout(__groupedPublishTimer);
  __groupedPublishTimer = setTimeout(async () => {
    __groupedPublishTimer = null;
    const payload = buildGroupedSettingsPayload();
    if (!payload || Object.keys(payload).length === 0) return;
    // If max_angle not present, try to populate it from last-seen MQTT or Supabase
    if (payload.max_angle === undefined) {
      if (Number.isFinite(Number(lastMaxAngleSeen))) {
        payload.max_angle = lastMaxAngleSeen;
      } else if (typeof fetchLatestSettings === 'function' && sb) {
        try {
          const s = await fetchLatestSettings();
          if (s && typeof s.max_angle === 'number') payload.max_angle = s.max_angle;
        } catch (e) { /* ignore */ }
      }
    }
    await publishGroupedSettings(payload);
  }, delay);
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

// (Banners removed)

// (Bridge DB lag check removed)

// Load latest settings (from two-table mode 'settings' first, else fall back to 'telemetry')
async function fetchLatestSettings() {
  if (!sb) return null;
  // Read from settings table only
  let { data, error } = await sb
    .from('settings')
    .select('threshold, vent, auto, angle, max_angle, graph_range, dht11_enabled, water_enabled, hw416b_enabled, ts')
    .order('ts', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('Supabase settings fetch error', error.message);
    // Do not show bridge banner on read errors at startup
  }
  // Do not mark healthy on read success; liveness will be determined by ping/status or writes
  return (data && data.length) ? data[0] : null;
}

// One-time presence check: on first load/refresh, if settings table has no rows, show banner
let __settingsPresenceChecked = false;
async function checkSettingsPresenceOnce() {
  if (__settingsPresenceChecked || !sb) return;
  __settingsPresenceChecked = true;
  try {
    const { data, error } = await sb
      .from('settings')
      .select('id')
      .limit(1);
    // Presence check no longer drives banner; reserved for future diagnostics
    if (error) { /* ignore */ }
    else { /* ignore count result */ }
  } catch (e) {
    /* ignore */
  }
}

// Dev helper: trigger the presence check manually from the console
// Usage: runStartupPresenceCheckNow() or runStartupPresenceCheckNow(true) to force re-check
window.runStartupPresenceCheckNow = function(force = false) {
  try {
    if (force) __settingsPresenceChecked = false;
    checkSettingsPresenceOnce();
  } catch (e) {
    console.warn('runStartupPresenceCheckNow error:', e?.message || e);
  }
};

// Apply settings to UI
function applySettingsToUI(s) {
  if (!s) return;
  if (typeof s.max_angle === 'number') {
    applyMaxAngleLimit(s.max_angle);
  }
  if (typeof s.threshold === 'number') {
    threshold = clamp(s.threshold, 0, 100);
    thValEl.textContent = String(threshold);
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
  // Apply graph range if provided
  if (typeof s.graph_range === 'string') {
    const key = s.graph_range;
    const allowed = new Set(['live','15m','30m','1h','6h','1d']);
    if (allowed.has(key)) {
      if (window.THGraph && typeof window.THGraph.setRange === 'function') {
        // Apply without publishing or persisting again (origin = DB)
        try { window.THGraph.setRange(key, { publish: false, persist: false }); } catch {}
      } else {
        // Stash to apply once graph is initialized
        window.__initialGraphRangeKey = key;
      }
    }
  }
  // Apply sensor enable flags to checkboxes if present
  try {
    const map = {
      dht11_enabled: 'dht11',
      water_enabled: 'water',
      hw416b_enabled: 'hw416b'
    };
    Object.entries(map).forEach(([col, key]) => {
      if (s[col] !== undefined) {
        const box = document.querySelector(`#sensor-menu input[type=checkbox][data-sensor="${key}"]`);
        if (box) box.checked = !!s[col];
      }
    });
    // Snapshot for initial publish suppression
    window.__sensorFlagsSnapshot = {
      dht11_enabled: s.dht11_enabled ?? null,
      water_enabled: s.water_enabled ?? null,
      hw416b_enabled: s.hw416b_enabled ?? null
    };
  } catch {}
}

let pendingSettingsToSend = null;

// Preload settings on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  if (sb) {
    // No timers on DOM load; defer to MQTT connect + ping logic
    const latest = await fetchLatestSettings();
    if (latest) {
      applySettingsToUI(latest);
      pendingSettingsToSend = latest; // remember to send to ESP after MQTT connect
    }
  }
  // Wire sensor enable checkbox change handlers
  const sensorMenu = document.getElementById('sensor-menu');
  if (sensorMenu) {
    const map = { dht11: 'dht11_enabled', water: 'water_enabled', hw416b: 'hw416b_enabled' };
    sensorMenu.querySelectorAll('input[type=checkbox][data-sensor]').forEach(cb => {
      cb.addEventListener('change', () => {
        const sensor = cb.getAttribute('data-sensor');
        const col = map[sensor];
        if (col) publishSingleSensorFlag(col, cb.checked);
      });
    });
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
  // Flush pending sensor flag publishes (queued while offline) before subscribing
  const queued = Object.keys(__pendingSensorFlagPublish || {});
  if (queued.length) {
    queued.forEach(k => {
      const v = __pendingSensorFlagPublish[k];
      try {
        client.publish('home/dashboard/sensors', JSON.stringify({ [k]: v, source: 'dashboard' }), { retain: true });
        console.debug('[sensors] flushed queued flag', k, v);
      } catch (e) {
        console.warn('[sensors] failed to flush queued flag', k, e?.message || e);
      }
    });
    __pendingSensorFlagPublish = {};
  }
  try { client.subscribe('home/dashboard/sensors', { rh: 2 }); } catch { client.subscribe('home/dashboard/sensors'); }
});

// Sensor flags single-field retained publish with offline queue
let __sensorSelfSuppressUntil = 0;
let __lastSensorSent = {};
let __pendingSensorFlagPublish = {};
function publishSingleSensorFlag(sensorKey, value) {
  if (!sensorKey) return;
  const obj = { source: 'dashboard' };
  obj[sensorKey] = !!value;
  // Longer suppression in auto mode to prevent device overrides
  const isAuto = autoToggle && autoToggle.classList.contains('active');
  __sensorSelfSuppressUntil = Date.now() + (isAuto ? 10000 : 800); // 10s in auto, 800ms otherwise
  __lastSensorSent[sensorKey] = !!value;
  if (!client || !client.connected) {
    __pendingSensorFlagPublish[sensorKey] = !!value;
    console.debug('[sensors] queued (offline)', sensorKey, value);
    return;
  }
  try {
    client.publish('home/dashboard/sensors', JSON.stringify(obj), { retain: true });
    console.debug('[sensors] published', obj);
    // Update grouped snapshot after sensor flag change
    scheduleGroupedPublish();
  } catch (e) {
    console.warn('[sensors] publish failed, queueing', e?.message || e);
    __pendingSensorFlagPublish[sensorKey] = !!value;
  }
}

// Listen for sensor flags updates via MQTT
if (client) client.on('message', (topic, message) => {
  if (topic !== 'home/dashboard/sensors') return;
  let obj; try { obj = JSON.parse(message.toString()); } catch { return; }
  if (!obj || typeof obj !== 'object') return;
  if (obj.source === 'dashboard' && Date.now() < __sensorSelfSuppressUntil) return; // suppress echo of our own publish
  const keys = ['dht11_enabled','water_enabled','hw416b_enabled'];
  let any = false;
  keys.forEach(k => {
    if (obj[k] !== undefined) {
      const map = { dht11_enabled: 'dht11', water_enabled: 'water', hw416b_enabled: 'hw416b' };
      const sensorKey = map[k];
      const box = document.querySelector(`#sensor-menu input[type=checkbox][data-sensor="${sensorKey}"]`);
      if (box && box.checked !== !!obj[k]) { box.checked = !!obj[k]; any = true; }
    }
  });
  // No further snapshot tracking required; UI is updated in place.
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
  const pageLoadAt = Date.now();
  const tempColor = getComputedStyle(document.documentElement).getPropertyValue('--temp-color') || '#ff6b35';
  const humidColor = getComputedStyle(document.documentElement).getPropertyValue('--humid-color') || '#4fc3f7';
  // Fallback to CSS classes colors (read from DOM styles of gauges)
  // We'll just hardcode based on our stylesheet for reliability
  const TEMP_COLOR = '#ff6b35';
  const HUMID_COLOR = '#4fc3f7';

  // Ranges and timing
  const LIVE_INTERVAL_MS = 1000; // 1s live update cadence
  const LIVE_MAX_POINTS = 86400; // ~1 day at 1s
  const RANGE_MS = {
    live: 10 * 60 * 1000, // 10 minutes for live mode
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

  // Sensor visibility logic disabled for now (always show both)
  const tempEnabled = true;
  const humidEnabled = true;

  // Graph state
  const state = window.graphState;
  state.liveData = window.liveData;
  state.histData = window.histData;
  state.liveTimer = null;
  state.historyTimer = null;
  state.lastLiveAt = 0;
  state.lastMqttAt = 0;
  state.liveStartAt = 0;
  state.viewStartAt = 0;

  function setButtonsActive(range) {
    const ctrl = document.getElementById('graph-controls');
    if (!ctrl) return;
    const buttons = Array.from(ctrl.querySelectorAll('.time-btn'));
    buttons.forEach(b => b.classList.toggle('active', b.dataset.range === range));
  }

  const ctrl = document.getElementById('graph-controls');
  if (ctrl) {
    ctrl.addEventListener('click', (e) => {
      if (e.target.matches('.time-btn')) {
        const range = e.target.dataset.range;
        state.range = range;
        setButtonsActive(range);
        if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
        if (range === 'live') {
          state.liveTimer = setInterval(() => { draw(); }, LIVE_INTERVAL_MS);
        } else {
          // For other ranges, update every 1 minute to show new data
          state.liveTimer = setInterval(() => { draw(); }, 60000);
        }
        draw();
      }
    });
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

  // Pixel-snapping helpers to avoid subpixel jitter when scrolling on mobile.
  // Use integer positions for text and 0.5 offsets for 1px strokes where appropriate.
  function snap(px) { return Math.round(px); }
  function crisp(px) { return Math.round(px) + 0.5; }

  // axes (use crisp coords for 1px-aligned strokes)
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(crisp(padL), crisp(padT));
    ctx.lineTo(crisp(padL), crisp(padT + gh));
    ctx.lineTo(crisp(padL + gw), crisp(padT + gh));
    ctx.stroke();

  // Axis labels/ticks (simple): humidity scale on left (0..100), x is time
  ctx.fillStyle = 'rgba(220,220,220,0.85)';
  ctx.font = '12px system-ui, Arial';
  ctx.fillText('0', snap(padL - 18), snap(padT + gh));
  ctx.fillText('100', snap(padL - 28), snap(padT + 10));
    // dynamic x-axis ticks
  const nowRaw = Date.now();
  // Quantize time window to reduce jitter when scrolling/settling
  const quant = 1000; // 1s quantization for stability
  const nowTs = Math.floor(nowRaw / quant) * quant;
  let span = RANGE_MS[state.range] || (state.range === 'live' ? RANGE_MS.live : 60_000);
  // For live, keep window end anchored to quantized now, start at now - span
  let xMin = nowTs - span;
  let xMax = nowTs;
    let points = state.liveData;
    if (state.range === 'live') {
      if (bridgeOnline === true && state.histData.length > 0) {
        points = state.histData;
      } // else use liveData
    } else {
      if (bridgeOnline === true && state.histData.length > 0) {
        points = state.histData;
      } // else use liveData (local storage fallback)
    }
    if (points.length) {
    }
    function xAtTs(ts) {
      const f = (ts - xMin) / Math.max(1, (xMax - xMin));
      return padL + f * gw;
    }
  // ticks at start, 1/3, 2/3, end (quantized to nearest second to prevent text jitter)
  const spanMs = (xMax - xMin);
  const q = 1000;
  const t0 = Math.floor(xMin / q) * q;
  const t1 = Math.floor((xMin + spanMs / 3) / q) * q;
  const t2 = Math.floor((xMin + 2 * spanMs / 3) / q) * q;
  const t3 = Math.floor(xMax / q) * q;
  const ticks = [t0, t1, t2, t3];
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
  ctx.fillText(fmtTick(ticks[0]), snap(padL), snap(padT + gh + 16));
  ctx.textAlign = 'center';
  ctx.fillText(fmtTick(ticks[1]), snap(padL + gw / 3), snap(padT + gh + 16));
  ctx.fillText(fmtTick(ticks[2]), snap(padL + (2 * gw) / 3), snap(padT + gh + 16));
  ctx.textAlign = 'right';
  ctx.fillText(state.range === 'live' ? 'now' : fmtTick(ticks[3]), snap(padL + gw), snap(padT + gh + 16));
  ctx.textAlign = 'left';

  // Axis titles (crisp vertical title: integer-aligned and middle baseline)
  ctx.save();
  ctx.fillStyle = 'rgba(230,230,230,0.92)';
  ctx.font = '12px system-ui, Arial';
  // Position the vertical axis title using snapped coordinates to prevent jitter
  const tX = snap(padL - 38);
  const tY = snap(padT + gh / 2);
  ctx.translate(tX, tY);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Humidity %   /   Temp °C', 0, 0);
  ctx.restore();

  // Legend above plotting area (conditional on visibility)
  const legendY = snap(basePadT + 14); // centered in legend row (snapped)
  let lx = snap(padL); // start near left
  ctx.lineWidth = 2.5;
  ctx.font = '12px system-ui, Arial';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(230,230,230,0.95)';
  if (humidEnabled) {
    ctx.strokeStyle = HUMID_COLOR;
    ctx.beginPath(); ctx.moveTo(crisp(lx), crisp(legendY)); ctx.lineTo(crisp(lx + 24), crisp(legendY)); ctx.stroke();
    ctx.fillText('Humidity', snap(lx + 30), legendY);
    lx = snap(lx + 30 + ctx.measureText('Humidity').width + 18);
  }
  if (tempEnabled) {
    ctx.strokeStyle = TEMP_COLOR;
    ctx.beginPath(); ctx.moveTo(crisp(lx), crisp(legendY)); ctx.lineTo(crisp(lx + 24), crisp(legendY)); ctx.stroke();
    ctx.fillText('Temperature', snap(lx + 30), legendY);
    lx = snap(lx + 30 + ctx.measureText('Temperature').width + 18);
  }

  const plot = points;
    if (!plot.length) return;

    // Y mappers
    function yTemp(v) {
      const clamped = Math.max(0, Math.min(80, v));
      const f = clamped / 80; // 0..1
      return padT + gh - f * gh;
    }
    function yHumid(v) {
      const clamped = Math.max(0, Math.min(100, v));
      const f = clamped / 100; // 0..1
      return padT + gh - f * gh;
    }

    // Draw lines
    ctx.lineWidth = 2;
    if (humidEnabled && points.some(p => p.h !== null)) {
      ctx.strokeStyle = HUMID_COLOR;
      ctx.beginPath();
      points.forEach((p, i) => {
        if (p.h === null) return;
        const x = Math.max(padL, Math.min(padL + gw, xAtTs(p.ts)));
        const y = yHumid(p.h);
        if (i === 0 || points[i-1].h === null) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    if (tempEnabled && points.some(p => p.t !== null)) {
      ctx.strokeStyle = TEMP_COLOR;
      ctx.beginPath();
      points.forEach((p, i) => {
        if (p.t === null) return;
        const x = Math.max(padL, Math.min(padL + gw, xAtTs(p.ts)));
        const y = yTemp(p.t);
        if (i === 0 || points[i-1].t === null) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Redraw axes on top to ensure they are visible over the data lines (all modes)
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + gh);
    ctx.lineTo(padL + gw, padT + gh);
    ctx.stroke();
  }

  // Initial setup for live
  state.range = 'live';
  setButtonsActive('live');
  state.liveTimer = setInterval(() => { draw(); }, LIVE_INTERVAL_MS);
  draw();

  // Periodic activity to prevent browser tab discard or misclassification
  // Updates localStorage every 10 minutes to simulate user activity
  const updateActivity = () => {
    try {
      localStorage.setItem('lastAppActivity', Date.now().toString());
    } catch (e) {
      // Ignore if localStorage is unavailable
    }
  };
  setInterval(updateActivity, 10 * 60 * 1000); // 10 minutes
  // Also update on visibility change to mark as active when user returns
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      updateActivity();
    }
  });

  // Helper: interpolate points between two data points for gap filling
  function interpolatePoints(startPoint, endPoint, intervalMs = 60000) { // 1 min intervals
    const points = [];
    const startTs = startPoint.ts;
    const endTs = endPoint.ts;
    const duration = endTs - startTs;
    if (duration <= intervalMs) return points;
    const numPoints = Math.floor(duration / intervalMs) - 1;
    for (let i = 1; i <= numPoints; i++) {
      const ts = startTs + i * intervalMs;
      const fraction = (ts - startTs) / duration;
      const t = startPoint.t + fraction * (endPoint.t - startPoint.t);
      const h = startPoint.h + fraction * (endPoint.h - startPoint.h);
      points.push({ ts, t, h });
    }
    return points;
  }

  // History loading via Supabase
  async function loadHistory(rangeKey) {
    if (!sb) {
      showToast('Supabase not configured for history', 'error');
      return [];
    }
    const span = RANGE_MS[rangeKey] || RANGE_MS['15m'];
    if (span > 8 * 60 * 1000 && bridgeOnline !== true) return [];
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
      // Do not show bridge banner on read errors; may simply be empty history
      return [];
    }
    // Success path
    noteDbSuccess();
    const points = (resp.data || []).map(row => ({
      ts: new Date(row.ts).getTime(),
      t: typeof row.temperature === 'number' ? row.temperature : null,
      h: typeof row.humidity === 'number' ? row.humidity : null,
    })).filter(p => p.t !== null || p.h !== null).map(p => ({ ts: p.ts, t: p.t ?? (state.histData.length ? state.histData[state.histData.length-1].t : 24), h: p.h ?? (state.histData.length ? state.histData[state.histData.length-1].h : 55) }));
    // Fill gaps between history and live data with interpolated points
    if (points.length > 0 && window.liveData.length > 0) {
      const lastHist = points[points.length - 1];
      const firstLive = window.liveData[0];
      const gapMs = firstLive.ts - lastHist.ts;
      const GAP_THRESHOLD_MS = 1000; // 1 second
      if (gapMs > GAP_THRESHOLD_MS) {
        const interpolated = interpolatePoints(lastHist, firstLive);
        if (interpolated.length > 0) {
          // Insert interpolated points into DB
          const rows = interpolated.map(p => ({ ts: new Date(p.ts).toISOString(), temperature: p.t, humidity: p.h }));
          try {
            const { error } = await sb.from('readings').insert(rows);
            if (error) {
              console.warn('Failed to insert interpolated points:', error.message);
            } else {
              console.log(`Inserted ${interpolated.length} interpolated points to fill gap`);
              // Add to points array
              points.push(...interpolated);
              // Sort by timestamp
              points.sort((a, b) => a.ts - b.ts);
            }
          } catch (e) {
            console.warn('Error inserting interpolated points:', e);
          }
        }
      }
    }
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

  function pushLivePoint(t, h, ts, isFromMqtt) {
    state.liveData.push({ t, h, ts });
    const minTs = Date.now() - 86400000; // 1 day
    while (state.liveData.length && state.liveData[0].ts < minTs) state.liveData.shift();
    if (state.liveData.length > 86400) state.liveData.splice(0, state.liveData.length - 86400);
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
        pushLivePoint(last.t, last.h, now, false);
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
  if (error) { /* skip banner on read errors */ }
      if (!error && data && data.length) {
        const row = data[0];
        const t = (typeof row.temperature === 'number') ? row.temperature : null;
        const h = (typeof row.humidity === 'number') ? row.humidity : null;
        if (t !== null || h !== null) {
          pushLivePoint(t ?? (state.liveData.at(-1)?.t ?? 24), h ?? (state.liveData.at(-1)?.h ?? 55), Date.parse(row.ts) || Date.now(), false);
          liveSeeded = true;
          noteDbSuccess();
        } else {
          // fallback to telemetry table
          const { data: d2, error: e2 } = await sb
            .from('telemetry')
            .select('ts, temperature, humidity')
            .order('ts', { ascending: false })
            .limit(1);
          if (e2) { /* skip banner on read errors */ }
          if (!e2 && d2 && d2.length) {
            const r2 = d2[0];
            const t2 = (typeof r2.temperature === 'number') ? r2.temperature : null;
            const h2 = (typeof r2.humidity === 'number') ? r2.humidity : null;
            if (t2 !== null || h2 !== null) {
              pushLivePoint(t2 ?? (state.liveData.at(-1)?.t ?? 24), h2 ?? (state.liveData.at(-1)?.h ?? 55), Date.parse(r2.ts) || Date.now(), false);
              liveSeeded = true;
              noteDbSuccess();
            }
          }
        }
      }
    } catch (e) {
      console.warn('Live seed fetch failed', e?.message || e);
      // Do not show bridge banner on read exceptions at startup
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

  // Helper: persist selected graph range directly to Supabase settings (best-effort)
  async function persistGraphRange(rangeKey) {
    if (!sb) return;
    try {
      // Locate latest settings row id (two-table mode)
      const { data: existing, error: selErr } = await sb
        .from('settings')
        .select('id')
        .order('ts', { ascending: false })
        .limit(1);
      if (selErr) { return; }
      const existingId = (existing && existing.length) ? existing[0].id : null;
      const nowIso = new Date().toISOString();
      if (existingId) {
        await sb
          .from('settings')
          .update({ graph_range: rangeKey, ts: nowIso })
          .eq('id', existingId);
      } else {
        await sb
          .from('settings')
          .insert({ graph_range: rangeKey, ts: nowIso });
      }
    } catch (e) {
      console.warn('Persist graph_range failed:', e?.message || e);
      maybeShowBridgeBannerForDbError(e);
    }
  }

  // Expose controller
  window.THGraph = {
    setRange: async (rangeKey, opts = {}) => {
      const publishChange = (opts.publish !== false);
      const persistChange = (opts.persist !== false);
      if (!RANGE_MS[rangeKey]) rangeKey = 'live';
      state.range = rangeKey;
      state.viewStartAt = Date.now();
      setButtonsActive(rangeKey);
      // Persist selection directly to DB before any history fetch (best-effort)
      if (persistChange) {
        await persistGraphRange(rangeKey);
      }
      if (publishChange) {
        publish('home/dashboard/graphRange', { range: rangeKey });
        // grouped snapshot too
        scheduleGroupedPublish();
      }
      // Start appropriate mode
      if (rangeKey === 'live') {
        state.liveStartAt = Date.now();
        startLive();
        if (bridgeOnline === true) {
          await startHistory(rangeKey);
        }
      } else if (bridgeOnline === true) {
        await startHistory(rangeKey);
      } // else use liveData for history
    }
  };

  // (Stale-data banner removed)

  // Render loop
  function loop() {
    // draw every frame for smoothness; points are pushed by MQTT or history refresh
    draw();
    requestAnimationFrame(loop);
  }
  loop();

  // Default range
  // If a range was requested via settings/MQTT before graph initialized, apply it first
  const initialKey = window.__initialGraphRangeKey;
  if (typeof initialKey === 'string') {
    try { window.THGraph.setRange(initialKey, { publish: false, persist: false }); } catch { window.THGraph.setRange('live'); }
    window.__initialGraphRangeKey = undefined;
  } else {
    window.THGraph.setRange('live');
  }
})();

// threshold buttons with press-and-hold behavior
function changeThreshold(delta) {
  threshold = clamp(threshold + delta, 0, 100);
    thValEl.textContent = String(threshold);
  publishAndSuppress("home/dashboard/threshold", { threshold }, 'threshold', threshold);
  beginGuard('threshold', threshold, 600);
  // Publish grouped settings immediately for threshold changes
  publishGroupedSettings(buildGroupedSettingsPayload(), true);
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
  // Publish grouped snapshot (debounced)
  scheduleGroupedPublish();
}

// servo slider - live update & publish
let sliderPublishTimer = null;
slider.addEventListener("input", (e) => {
  if (knobDisabled) return;
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
    publishWindowStream({ angle: val, source: 'slider' });
    // Schedule grouped snapshot (non-final while sliding)
    scheduleGroupedPublish();
  }, 80);
});

slider.addEventListener("change", (e) => {
  if (knobDisabled) return;
  let a = Number(e.target.value);
  if (!Number.isFinite(a)) a = 0;
  if (a > maxAngleLimit) { a = maxAngleLimit; e.target.value = String(a); }
  // Slider release -> final write
  const finalInt = Math.round(Math.max(0, Math.min(maxAngleLimit, a)));
  publishAndSuppress("home/dashboard/window", { angle: finalInt, final: true, source: 'slider' }, 'angle', finalInt);
  beginGuard('angle', finalInt, 700);
  // Final angle set -> publish grouped snapshot
  scheduleGroupedPublish();
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
  // Also publish grouped settings snapshot (debounced)
  scheduleGroupedPublish();
});

// message handler - robust parse
if (client) client.on("message", (topic, message) => {
  // Bridge pong handler
  if (topic === 'home/dashboard/bridge_pong') {
    try {
      const m = JSON.parse(message.toString());
      if (m && (m.id || m.pong)) {
        bridgeOnline = true;
        setBridgeBannerVisible(false);
        bridgeDismissed = false;
        startupHealthy = true;
        if (!wasBridgeOnline && window.liveData.length > 0) {
          // pushLiveDataToDb(); // Bridge handles DB
        }
        wasBridgeOnline = true;
        if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
        if (startupFallbackTimer) { clearTimeout(startupFallbackTimer); startupFallbackTimer = null; }
        // Request a settings snapshot from the bridge so we can learn bridge-provided max_angle
        if (!pendingBridgeMaxAngleRequest) {
          pendingBridgeMaxAngleRequest = true;
          try { client.publish('home/dashboard/settings/get', JSON.stringify({ requestor: 'dashboard' })); } catch {}
          // Clear pending flag after a short window to allow retries if nothing arrives
          setTimeout(() => { pendingBridgeMaxAngleRequest = false; }, 3000);
        }
      }
    } catch {}
    return;
  }
  // Bridge status topic controls the red banner
  if (topic === 'home/dashboard/bridge_status') {
    const raw = message.toString().trim();
    let status = raw.toLowerCase();
    // support JSON payloads like {"status":"online"} or {"online":true}
    try {
      const obj = JSON.parse(raw);
      if (typeof obj === 'object' && obj) {
        if (typeof obj.online === 'boolean') status = obj.online ? 'online' : 'offline';
        else if (typeof obj.status === 'string') status = String(obj.status).toLowerCase();
      }
    } catch {}
    if (status === 'online' || status === '1' || status === 'true') {
      bridgeOnline = true;
      setBridgeBannerVisible(false);
      bridgeDismissed = false; // reset so future offline can show again
      startupHealthy = true;
      if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
      if (startupFallbackTimer) { clearTimeout(startupFallbackTimer); startupFallbackTimer = null; }
      // Push accumulated data to DB if bridge just came online
      if (!wasBridgeOnline && window.liveData.length > 0) {
        // pushLiveDataToDb(); // Bridge handles DB
      }
      wasBridgeOnline = true;
        // Request bridge snapshot to obtain max_angle
        if (!pendingBridgeMaxAngleRequest) {
          pendingBridgeMaxAngleRequest = true;
          try { client.publish('home/dashboard/settings/get', JSON.stringify({ requestor: 'dashboard' })); } catch {}
          setTimeout(() => { pendingBridgeMaxAngleRequest = false; }, 3000);
        }
    } else if (status === 'offline' || status === '0' || status === 'false') {
      bridgeOnline = false;
      setBridgeBannerVisible(true);
      wasBridgeOnline = false;
      // Keep ping timer running to detect when it recovers, but clear fallback if any
      if (startupFallbackTimer) { clearTimeout(startupFallbackTimer); startupFallbackTimer = null; }
    } else {
      // unknown payload -> leave as-is
    }
    if (bridgeFallbackTimer) { clearTimeout(bridgeFallbackTimer); bridgeFallbackTimer = null; }
    return;
  }
  if (topic === 'home/dashboard/angle_special') {
    console.log('Received angle_special message:', message.toString());
    if (!espOverrideEnabled) {
      console.log('ESP override disabled, ignoring angle_special');
      return;
    }
    try {
      const data = JSON.parse(message.toString());
      // knob_disabled can be provided to disable the UI
      if (data.knob_disabled !== undefined) {
        const kd = !!data.knob_disabled;
        console.log('Setting knob disabled:', kd);
        setKnobDisabled(kd);
      }
      const angle = parseFloat(data.angle);
      if (!isNaN(angle)) {
        const clamped = Math.max(0, Math.min(maxAngleLimit, angle));
        console.log('Updating angle to:', clamped);
        updateAngleSmooth(clamped, true);
        // Publish grouped settings immediately
        publishGroupedSettings(buildGroupedSettingsPayload(), true);
      } else {
        console.log('Invalid angle in message:', data.angle);
      }
    } catch (e) {
      console.warn('Error processing angle_special:', e);
    }
    return;
  }
  if (topic === 'home/dashboard/graphRange') {
    try {
      const m = JSON.parse(message.toString());
      const key = m?.range;
      const allowed = new Set(['live','15m','30m','1h','6h','1d']);
      if (typeof key === 'string' && allowed.has(key)) {
        if (window.THGraph && typeof window.THGraph.setRange === 'function') {
          // Apply without publishing or persisting again (avoid echo/loop)
          try { window.THGraph.setRange(key, { publish: false, persist: false }); } catch {}
        } else {
          // Stash to apply when graph is ready
          window.__initialGraphRangeKey = key;
        }
      }
    } catch {}
    return;
  }
  // Bridge status topic - hide banner when bridge reports online
  // (bridge_status banner removed)

  // Device availability topic may be string payload (online/offline)
  if (topic === DEVICE_AVAILABILITY_TOPIC || topic === LEGACY_DEVICE_AVAILABILITY_TOPIC) {
    const payload = message.toString().trim().toLowerCase();
    if (payload === 'online' || payload === '1') {
      if (deviceOfflineDebounceTimer) { clearTimeout(deviceOfflineDebounceTimer); deviceOfflineDebounceTimer = null; }
      markDeviceSeen('availability');
    } else if (payload === 'offline' || payload === '0') {
      // Debounce only; do NOT ignore due to recent heartbeat anymore, so LWT triggers a fast offline.
      if (deviceOfflineDebounceTimer) { clearTimeout(deviceOfflineDebounceTimer); }
      deviceOfflineDebounceTimer = setTimeout(() => {
        deviceOnline = false;
        updateStatusUI('availability-offline');
      }, OFFLINE_DEBOUNCE_MS);
    }
    return; // handled
  }
  if (topic === DEVICE_HEARTBEAT_TOPIC) {
    // Heartbeat JSON optional; parse if possible for dynamic interval
    const now = Date.now();
    lastHeartbeatAt = now;
    heartbeatSeen = true; // enable heartbeat timeout logic from now on
    const txt = message.toString();
    try {
      const obj = JSON.parse(txt);
      const rawInt = obj?.interval_ms ?? obj?.interval ?? obj?.ms;
      if (rawInt && Number.isFinite(Number(rawInt))) {
        const v = Math.round(Number(rawInt));
        // Accept sane heartbeat intervals 0.5s .. 10 minutes
        if (v >= 500 && v <= 600000 && Math.abs(v - heartbeatExpectedMs) > 200) {
          heartbeatExpectedMs = v;
          // Rebuild monitor with new expectation
          if (heartbeatCheckTimer) { clearInterval(heartbeatCheckTimer); heartbeatCheckTimer = null; }
          const interval = Math.max(2000, Math.min(heartbeatExpectedMs / 2, 10000));
          heartbeatCheckTimer = setInterval(() => {
            if (!deviceOnline) return;
            if (!lastHeartbeatAt) return;
            const age = Date.now() - lastHeartbeatAt;
            const staleThresh = heartbeatExpectedMs * HEARTBEAT_STALE_FACTOR;
            const hardOffline = age > PRESENCE_OFFLINE_HARD_MS;
            if (heartbeatSeen && (hardOffline || age > staleThresh)) { deviceOnline = false; updateStatusUI('heartbeat-timeout'); }
          }, interval);
        }
      }
      else {
        // Derive interval adaptively if device doesn't include one
        if (__hbLastAt) {
          const gap = now - __hbLastAt;
          if (gap >= 400 && gap <= 600000) {
            if (__hbEst == null) __hbEst = gap; else __hbEst = __hbEst * 0.6 + gap * 0.4;
            if (__hbEstSamples < 50) __hbEstSamples++;
            const derived = Math.round(__hbEst);
            if (__hbEstSamples >= 2) {
              const diff = Math.abs(derived - heartbeatExpectedMs);
              if (diff > 200 && diff / Math.max(1, heartbeatExpectedMs) > 0.12) {
                heartbeatExpectedMs = derived;
                if (heartbeatCheckTimer) { clearInterval(heartbeatCheckTimer); heartbeatCheckTimer = null; }
                const interval = Math.max(1500, Math.min(heartbeatExpectedMs / 2, 8000));
                heartbeatCheckTimer = setInterval(() => {
                  if (!deviceOnline) return;
                  if (!lastHeartbeatAt) return;
                  const age = Date.now() - lastHeartbeatAt;
                  const staleThresh = heartbeatExpectedMs * HEARTBEAT_STALE_FACTOR;
                  const hardOffline = age > PRESENCE_OFFLINE_HARD_MS;
                  if (heartbeatSeen && (hardOffline || age > staleThresh)) { deviceOnline = false; updateStatusUI('heartbeat-timeout'); }
                }, interval);
              }
            }
          }
        }
        __hbLastAt = now;
      }
    } catch { /* non-JSON heartbeat still counts */ }
    markDeviceSeen('heartbeat');
    updateStatusUI('heartbeat');
    return;
  }
  let data;
  try {
    data = JSON.parse(message.toString());
  } catch (e) {
    console.warn("Received non-JSON or invalid JSON message", topic, message.toString());
    return;
  }
  // Capture bridge-provided full settings snapshots and learn max_angle
  if (topic === 'home/dashboard/settings') {
    if (data && typeof data.max_angle === 'number') {
      bridgeHasMaxAngle = true;
      lastBridgeMaxAngle = Math.max(1, Math.round(Number(data.max_angle)));
      // Apply limit locally as well
      applyMaxAngleLimit(lastBridgeMaxAngle);
    }
  }
  // Temperature
  const temp = data.temperature ?? data.temparature;
  const tempNum = parseFloat(temp);
  if (!isNaN(tempNum)) {
    const tempValue = tempEl.querySelector('.gauge-value');
    tempValue.innerHTML = `${tempNum}<sup>°C</sup>`;
    setGaugeProgress(tempEl, Math.max(0, Math.min(80, tempNum)) / 80);
  }
  // Humidity
  if (data.humidity !== undefined) {
    const humidNum = parseFloat(data.humidity);
    if (!isNaN(humidNum)) {
      const humidValue = humidEl.querySelector('.gauge-value');
      humidValue.innerHTML = `${humidNum}<sup>%</sup>`;
      setGaugeProgress(humidEl, Math.max(0, Math.min(100, humidNum)) / 100);
    }
  }
  // Update last DHT data timestamp if temp or humidity received
  if (data.temperature !== undefined || data.humidity !== undefined || data.condition !== undefined || data.motion !== undefined) {
    lastDhtAt = Date.now();
  }
  // Motion
  if (data.motion !== undefined) motionStatus.innerText = data.motion ? 'Detected' : 'Calm';
  // Condition
  if (data.condition !== undefined) {
    const conditionIcon = document.querySelector('.control-item.condition .icon');
    if (conditionIcon) conditionIcon.textContent = data.condition ? '💧' : '☀️';
  }

  // Push to live graph if live mode and topic is data
  if (topic === 'home/dashboard/data' && window.graphState && window.graphState.range === 'live') {
    const last = window.liveData.length ? window.liveData[window.liveData.length - 1] : { t: 24, h: 55 };
    const numT = parseFloat(data.temperature ?? data.temparature);
    const t = isNaN(numT) ? last.t : numT;
    const numH = parseFloat(data.humidity);
    const h = isNaN(numH) ? last.h : numH;
    window.liveData.push({ t, h, ts: Date.now() });
    const minTs = Date.now() - 86400000; // 1 day
    while (window.liveData.length && window.liveData[0].ts < minTs) window.liveData.shift();
    if (window.liveData.length > 86400) window.liveData.splice(0, window.liveData.length - 86400);
    // Persist to localStorage every 10 seconds
    const now = Date.now();
    if (now - lastLiveDataSave > 10000) {
      try {
        localStorage.setItem('liveData', JSON.stringify(window.liveData));
        lastLiveDataSave = now;
      } catch (e) {
        console.warn('Failed to save liveData to localStorage', e);
      }
    }
  }

  // Legacy windowAngle field
  if (data.windowAngle !== undefined) {
    const incoming = Math.round(Math.max(0, Math.min(maxAngleLimit, data.windowAngle)));
    const adjusting = window.__angleDragging || (window.__angleAdjustingUntil && Date.now() < window.__angleAdjustingUntil);
    if (isGuardedMismatch('angle', incoming)) return;
    if (!shouldSuppress('angle', incoming) && !adjusting) {
      updateAngleSmooth(incoming, false);
    }
  }
  // New angle field with final flag
  if (data.angle !== undefined) {
    const incoming = Math.round(Math.max(0, Math.min(maxAngleLimit, data.angle)));
    const adjusting = window.__angleDragging || (window.__angleAdjustingUntil && Date.now() < window.__angleAdjustingUntil);
    if (isGuardedMismatch('angle', incoming)) return;
    if (data.final === true) {
      if (adjusting && !shouldSuppress('angle', incoming)) return; // ignore foreign finals while dragging
      updateAngleSmooth(incoming, true);
      clearGuardIfMatch('angle', incoming);
    } else if (!shouldSuppress('angle', incoming) && !adjusting) {
      updateAngleSmooth(incoming, false);
    }
  }

  // Max angle limit broadcast
  if (data.max_angle !== undefined) {
    const lim = Math.max(1, Math.round(Number(data.max_angle)));
    lastMaxAngleSeen = lim;
    applyMaxAngleLimit(lim);
  }

  // Apply graph range from settings-like payload
  if (data.graph_range !== undefined) {
    const key = String(data.graph_range);
    const allowed = new Set(['live','15m','30m','1h','6h','1d']);
    if (allowed.has(key) && window.THGraph && typeof window.THGraph.setRange === 'function') {
      try { window.THGraph.setRange(key, { publish: false, persist: false }); } catch {}
    }
  }

  // Auto mode
  if (data.auto !== undefined) {
    const self = window.__autoSelf;
    const ignore = self && Date.now() < self.until && self.value === data.auto;
    if (!ignore) {
      autoToggle.classList.toggle('active', !!data.auto);
      autoToggle.setAttribute('aria-pressed', String(!!data.auto));
    }
    if (data.auto) slider.classList.add('disabled'); else slider.classList.remove('disabled');
  }

  // Threshold
  if (data.threshold !== undefined) {
    const incoming = clamp(Number(data.threshold), 0, 100);
    if (!isGuardedMismatch('threshold', incoming) && !shouldSuppress('threshold', incoming)) {
      threshold = incoming;
      thValEl.textContent = String(threshold);
    }
  }
  // Vent
  if (data.vent !== undefined) {
    const incoming = !!data.vent;
    if (!shouldSuppress('vent', incoming)) {
      ventActive = incoming;
      ventBtn.classList.toggle('active', ventActive);
      ventBtn.setAttribute('aria-pressed', String(ventActive));
    }
  }

  // Temp/humidity card styling example
  const tempHumidityCard = document.querySelector('.row-2 .card');
  if (tempHumidityCard) {
    // Do not auto-grey the temp/humidity card; always keep it enabled
    tempHumidityCard.classList.remove('disabled');
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

  // Snapping disabled: user can set any angle precisely without auto-snaps
  const SNAP_ENABLED = false;
  const SNAP_DEGREES = [];
  const SNAP_DEADZONE = 0; // unused when snapping is off

  let dragging = false;
  const PUBLISH_THROTTLE_MS = 60;
  let lastPublishAt = 0;
  let lastPublishedAngle = null;
  let trailingTimer = null;
  let currentAngleInt = 90; // track the UI's last rounded angle during drag
  let lastValidFraction = null; // last valid position on the 270° arc (ignores bottom gap)

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
    // The track covers [0,270]; the bottom gap is (270,360).
    // In the gap, hold at extremes:
    // - First half (270–315°): hold at max (fraction=1)
    // - Second half (315–360°): hold at min (fraction=0)
    if (deg > 270) {
      if (deg < 315) deg = 270; else deg = 0;
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
      // Schedule grouped settings snapshot
      scheduleGroupedPublish();
    }
  }

  function onPointerDown(e) {
    if (knobDisabled) return;
    dragging = true;
    window.__angleDragging = true;
    knob.setPointerCapture?.(e.pointerId);
    // Seed lastValidFraction from current UI angle so a first move in the gap won't jump
    lastValidFraction = currentAngleInt / Math.max(1, maxAngleLimit);
    onPointerMove(e);
  }
  function onPointerMove(e) {
    if (knobDisabled) return;
    if (!dragging) return;
    const f = pointToFraction(e.clientX, e.clientY);
    if (f == null) {
      // Ignore movements through the bottom gap to avoid snapping to 0/max
      return;
    }
    lastValidFraction = f;
    applyFraction(f, false);
    // Throttled transient publish (final:false) while dragging
    const now = Date.now();
    const angleNow = currentAngleInt;
    if (now - lastPublishAt >= PUBLISH_THROTTLE_MS && angleNow !== lastPublishedAngle) {
      publishAndSuppress('home/dashboard/window', { angle: angleNow, final: false, source: 'knob' }, 'angle', angleNow, 600);
      publishWindowStream({ angle: angleNow, source: 'knob' });
      lastPublishAt = now;
      lastPublishedAngle = angleNow;
      if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
    } else {
      // Set a short trailing timer to ensure the very last movement gets published if user pauses then releases quickly
      if (trailingTimer) { clearTimeout(trailingTimer); }
      trailingTimer = setTimeout(() => {
        if (!dragging) return; // pointer already up, final handler will publish
        if (currentAngleInt !== lastPublishedAngle) {
          const a = currentAngleInt;
            publishAndSuppress('home/dashboard/window', { angle: a, final: false, source: 'knob' }, 'angle', a, 600);
            publishWindowStream({ angle: a, source: 'knob' });
              lastPublishedAngle = a;
              lastPublishAt = Date.now();
        }
  }, PUBLISH_THROTTLE_MS + 20);
    }
  }
  function onPointerUp(e) {
    if (knobDisabled) return;
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
  const PUBLISH_MS = 80;

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
    if (knobDisabled) return; // ignore while disabled
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
      const final = currentWheelAngle != null ? currentWheelAngle : (valueEl ? parseInt(valueEl.textContent) || 0 : 0);
      publishFinal(final);
      // Also schedule grouped snapshot
      scheduleGroupedPublish();
    }, PUBLISH_MS);
  }

  gauge.addEventListener('wheel', onWheel, { passive: false });
})();
