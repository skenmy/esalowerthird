#!/usr/bin/env node
// ESA Lower Third — WebSocket relay + Tiltify donation integration + Horaro schedule
// Usage: node relay.js
// Env vars: TILTIFY_CLIENT_ID, TILTIFY_CLIENT_SECRET, TILTIFY_CAMPAIGN_ID, TILTIFY_CAMPAIGN_TYPE
//           HORARO_SCHEDULE (e.g. "esa/2026-winter1")
//           TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Static-file serving. STATIC_DIR holds source.html / control.html / index.html
// alongside relay.js inside the container; set STATIC_DIR=disabled to opt out.
const STATIC_DIR = process.env.STATIC_DIR === 'disabled' ? null : (process.env.STATIC_DIR || __dirname);
const STATIC_FILES = new Set(['source.html', 'control.html', 'confidence.html', 'index.html', 'esa-logotype.png']);
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

const PORT = parseInt(process.env.RELAY_PORT || '8081', 10);
const TILTIFY_CLIENT_ID = process.env.TILTIFY_CLIENT_ID;
const TILTIFY_CLIENT_SECRET = process.env.TILTIFY_CLIENT_SECRET;
const TILTIFY_CAMPAIGN_ID = process.env.TILTIFY_CAMPAIGN_ID;
const TILTIFY_CAMPAIGN_TYPE = process.env.TILTIFY_CAMPAIGN_TYPE || 'team_campaigns'; // 'campaigns' or 'team_campaigns'
const TILTIFY_API = 'https://v5api.tiltify.com';
const POLL_INTERVAL = 15_000;
const TOKEN_REFRESH_MARGIN = 5 * 60 * 1000; // refresh 5 min before expiry

const HORARO_SCHEDULE = process.env.HORARO_SCHEDULE || ''; // e.g. "esa/2026-winter1"
const HORARO_API = 'https://horaro.net/-/api/v1';
const HORARO_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_API = 'https://api.twitch.tv/helix';

// Shared secret gating the WebSocket + /api/* surface. When set, every WS
// client and HTTP API caller must present it (?token=, X-Relay-Token header,
// or "Authorization: Bearer <token>"). Unset = open (legacy behaviour, fine
// when something else fronts auth). Static files + /healthz stay open.
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';

const tiltifyEnabled = !!(TILTIFY_CLIENT_ID && TILTIFY_CLIENT_SECRET && TILTIFY_CAMPAIGN_ID);
const horaroEnabled = !!HORARO_SCHEDULE;
const twitchEnabled = !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET);
const authEnabled = !!RELAY_TOKEN;

// Constant-ish-time token check: accept the token from the query string or a
// header so both browser WS clients (?token=) and Companion's HTTP module
// (header) work. Returns true when auth is disabled.
function tokenValid(token) {
  return !!token && token === RELAY_TOKEN;
}
function authOk(req, url) {
  if (!authEnabled) return true;
  if (tokenValid(url.searchParams.get('token'))) return true;
  if (tokenValid(req.headers['x-relay-token'])) return true;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ') && tokenValid(auth.slice(7))) return true;
  return false;
}

// --- Tiltify state ---
let accessToken = null;
let tokenExpiresAt = 0;

// --- Twitch state ---
let twitchAccessToken = null;
let twitchTokenExpiresAt = 0;

let tiltifyCache = {
  campaign: null,
  donations: [],
  targets: [],
  milestones: [],
  incentives: {},  // { targets: {id: {name, raised, goal}}, polls: {id: {name, options: {optId: name}}} }
  donationMatches: [],
  lastUpdated: 0,
};

// --- OAuth ---

async function refreshToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: TILTIFY_CLIENT_ID,
    client_secret: TILTIFY_CLIENT_SECRET,
    scope: 'public',
  });

  const res = await fetch(`${TILTIFY_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tiltify OAuth failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  accessToken = json.access_token;
  // tokens typically last 2 hours; use expires_in if provided
  const expiresIn = (json.expires_in || 7200) * 1000;
  tokenExpiresAt = Date.now() + expiresIn;
  console.log(`[Tiltify] Token refreshed, expires in ${Math.round(expiresIn / 60000)}m`);
}

async function ensureToken() {
  if (!accessToken || Date.now() >= tokenExpiresAt - TOKEN_REFRESH_MARGIN) {
    await refreshToken();
  }
}

// --- API helpers ---

async function tiltifyGet(path) {
  await ensureToken();
  const res = await fetch(`${TILTIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tiltify GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Like tiltifyGet but returns null on 404 (some sub-campaign endpoints may not exist)
async function tiltifyGetSafe(path) {
  await ensureToken();
  const res = await fetch(`${TILTIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

// --- Twitch OAuth ---

async function refreshTwitchToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitch OAuth failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  twitchAccessToken = json.access_token;
  const expiresIn = (json.expires_in || 3600) * 1000;
  twitchTokenExpiresAt = Date.now() + expiresIn;
  console.log(`[Twitch] Token refreshed, expires in ${Math.round(expiresIn / 60000)}m`);
}

async function ensureTwitchToken() {
  if (!twitchAccessToken || Date.now() >= twitchTokenExpiresAt - TOKEN_REFRESH_MARGIN) {
    await refreshTwitchToken();
  }
}

async function twitchGet(path) {
  await ensureTwitchToken();
  const res = await fetch(`${TWITCH_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${twitchAccessToken}`,
      'Client-Id': TWITCH_CLIENT_ID,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitch GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// --- SRC + Twitch lookup handlers ---

async function handleSrcLookup(ws, data) {
  const username = (data.username || '').trim();
  if (!username) {
    ws.send(JSON.stringify({ type: 'src_result', error: 'No username provided' }));
    return;
  }

  try {
    // Look up user
    const userRes = await fetch(`https://www.speedrun.com/api/v1/users?lookup=${encodeURIComponent(username)}`);
    if (!userRes.ok) throw new Error(`SRC user lookup failed (${userRes.status})`);
    const userData = await userRes.json();
    const user = (userData.data || [])[0];
    if (!user) {
      ws.send(JSON.stringify({ type: 'src_result', error: `User "${username}" not found on speedrun.com` }));
      return;
    }

    // Fetch personal bests
    const pbRes = await fetch(`https://www.speedrun.com/api/v1/users/${user.id}/personal-bests`);
    if (!pbRes.ok) throw new Error(`SRC PB fetch failed (${pbRes.status})`);
    const pbData = await pbRes.json();
    const pbs = pbData.data || [];

    const gameIds = new Set();
    let worldRecords = 0;
    for (const run of pbs) {
      if (run.run && run.run.game) gameIds.add(run.run.game);
      if (run.place === 1) worldRecords++;
    }

    const result = {
      type: 'src_result',
      username: user.names?.international || username,
      gamesRun: gameIds.size,
      totalPBs: pbs.length,
      worldRecords,
    };

    console.log(`[SRC] Lookup "${username}": ${pbs.length} PBs across ${gameIds.size} games, ${worldRecords} WRs`);
    ws.send(JSON.stringify(result));
  } catch (err) {
    console.error(`[SRC] Lookup error for "${username}":`, err.message);
    ws.send(JSON.stringify({ type: 'src_result', error: err.message }));
  }
}

async function handleTwitchLookup(ws, data) {
  const username = (data.username || '').trim();
  if (!username) {
    ws.send(JSON.stringify({ type: 'twitch_result', error: 'No username provided' }));
    return;
  }

  if (!twitchEnabled) {
    ws.send(JSON.stringify({ type: 'twitch_result', error: 'Twitch not configured (missing env vars)' }));
    return;
  }

  try {
    const userRes = await twitchGet(`/users?login=${encodeURIComponent(username)}`);
    const user = (userRes.data || [])[0];
    if (!user) {
      ws.send(JSON.stringify({ type: 'twitch_result', error: `User "${username}" not found on Twitch` }));
      return;
    }

    const followRes = await twitchGet(`/channels/followers?broadcaster_id=${user.id}&first=1`);
    const followers = followRes.total || 0;

    const result = {
      type: 'twitch_result',
      username: user.display_name || username,
      followers,
      broadcasterType: user.broadcaster_type || '',
    };

    console.log(`[Twitch] Lookup "${username}": ${followers} followers`);
    ws.send(JSON.stringify(result));
  } catch (err) {
    console.error(`[Twitch] Lookup error for "${username}":`, err.message);
    ws.send(JSON.stringify({ type: 'twitch_result', error: err.message }));
  }
}

// --- Polling ---

async function pollTiltify() {
  try {
    const base = `/api/public/${TILTIFY_CAMPAIGN_TYPE}/${TILTIFY_CAMPAIGN_ID}`;
    const [campaignRes, donationsRes, targetsRes, milestonesRes] = await Promise.all([
      tiltifyGet(base),
      tiltifyGet(`${base}/donations?limit=50`),
      tiltifyGet(`${base}/targets`),
      tiltifyGet(`${base}/milestones`),
    ]);

    // Fetch incentive data from supporting sub-campaigns
    const incentives = await fetchIncentives(base);

    // Merge team-level targets with sub-campaign targets (team-level is usually empty)
    const teamTargets = (targetsRes.data || targetsRes) || [];
    const subTargets = incentives.targetsList || [];
    const seenTargetIds = new Set(teamTargets.map(t => t.id));
    const allTargets = [...teamTargets, ...subTargets.filter(t => !seenTargetIds.has(t.id))];

    tiltifyCache = {
      campaign: campaignRes.data || campaignRes,
      donations: (donationsRes.data || donationsRes) || [],
      targets: allTargets,
      polls: incentives.pollsList || [],
      milestones: (milestonesRes.data || milestonesRes) || [],
      donationMatches: incentives.matchesList || [],
      incentives,
      lastUpdated: Date.now(),
    };

    broadcastTiltifyData();
  } catch (err) {
    console.error('[Tiltify] Poll error:', err.message);
  }
}

async function fetchIncentives(base) {
  // targets: lookup map for donation resolution, targetsList: full objects for display
  const result = { targets: {}, polls: {}, targetsList: [], pollsList: [], matchesList: [] };

  try {
    // For team campaigns, incentives live on supporting sub-campaigns
    if (TILTIFY_CAMPAIGN_TYPE === 'team_campaigns') {
      const subRes = await tiltifyGetSafe(`${base}/supporting_campaigns`);
      const subCampaigns = subRes?.data || [];

      const fetches = subCampaigns.map(async (sc) => {
        const scBase = `/api/public/campaigns/${sc.id}`;
        const [targetsRes, pollsRes, matchesRes] = await Promise.all([
          tiltifyGetSafe(`${scBase}/targets`),
          tiltifyGetSafe(`${scBase}/polls`),
          tiltifyGetSafe(`${scBase}/donation_matches`),
        ]);

        for (const t of (targetsRes?.data || [])) {
          result.targets[t.id] = {
            name: t.name,
            raised: t.amount_raised?.value || t.total_amount_raised?.value || '0',
            goal: t.amount?.value || t.goal?.value || '0',
          };
          result.targetsList.push(t);
        }

        for (const p of (pollsRes?.data || [])) {
          const options = {};
          for (const o of (p.options || [])) {
            options[o.id] = { name: o.name, raised: o.total_amount_raised?.value || o.amount_raised?.value || '0' };
          }
          result.polls[p.id] = { name: p.name, options };
          result.pollsList.push(p);
        }

        for (const m of (matchesRes?.data || [])) {
          result.matchesList.push(m);
        }
      });

      await Promise.all(fetches);
    } else {
      const [targetsRes, pollsRes, matchesRes] = await Promise.all([
        tiltifyGetSafe(`${base}/targets`),
        tiltifyGetSafe(`${base}/polls`),
        tiltifyGetSafe(`${base}/donation_matches`),
      ]);

      for (const t of (targetsRes?.data || [])) {
        result.targets[t.id] = {
          name: t.name,
          raised: t.amount_raised?.value || t.total_amount_raised?.value || '0',
          goal: t.amount?.value || t.goal?.value || '0',
        };
        result.targetsList.push(t);
      }

      for (const p of (pollsRes?.data || [])) {
        const options = {};
        for (const o of (p.options || [])) {
          options[o.id] = { name: o.name, raised: o.total_amount_raised?.value || o.amount_raised?.value || '0' };
        }
        result.polls[p.id] = { name: p.name, options };
        result.pollsList.push(p);
      }

      for (const m of (matchesRes?.data || [])) {
        result.matchesList.push(m);
      }
    }
  } catch (err) {
    console.error('[Tiltify] Incentive fetch error:', err.message);
  }

  return result;
}

function broadcastTiltifyData() {
  const msg = JSON.stringify({ type: 'tiltify_data', ...tiltifyCache });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// --- Horaro schedule ---

let horaroCache = { schedule: null, upcoming: [], lastUpdated: 0 };

// --- Host confidence state (last-known, replayed to new clients) ---
let confidenceCache = {
  state: null,    // { type: 'confidence_state', state }
  feature: null,  // { type: 'confidence_feature', feature, ... }
  producer: null, // { type: 'producer_msg', text, level, active }
};

async function pollHoraro() {
  try {
    const [event, schedule] = HORARO_SCHEDULE.split('/');
    const res = await fetch(`${HORARO_API}/events/${event}/schedules/${schedule}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Horaro fetch failed (${res.status})`);
    const json = await res.json();
    const data = json.data;

    const now = Math.floor(Date.now() / 1000);
    const columns = data.columns;
    const gameIdx = columns.indexOf('Game');
    const playerIdx = columns.indexOf('Player(s)');
    const platformIdx = columns.indexOf('Platform');
    const categoryIdx = columns.indexOf('Category');

    const mapItem = item => ({
      scheduled: item.scheduled,
      scheduled_t: item.scheduled_t,
      length_t: item.length_t,
      game: item.data[gameIdx] || '',
      players: item.data[playerIdx] || '',
      platform: item.data[platformIdx] || '',
      category: item.data[categoryIdx] || '',
    });

    const allItems = data.items || [];
    // Runs not yet finished
    const upcoming = allItems
      .filter(item => item.scheduled_t + item.length_t > now)
      .map(mapItem);
    // Last 3 finished runs (most recent first, then reversed to chronological)
    const previous = allItems
      .filter(item => item.scheduled_t + item.length_t <= now)
      .slice(-3)
      .map(mapItem);

    horaroCache = {
      schedule: { name: data.name, timezone: data.timezone },
      upcoming,
      previous,
      lastUpdated: Date.now(),
    };

    broadcastSchedule();
  } catch (err) {
    console.error('[Horaro] Poll error:', err.message);
  }
}

function broadcastSchedule() {
  const msg = JSON.stringify({ type: 'schedule_data', ...horaroCache });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// --- WebSocket relay ---

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function broadcastToAll(data) {
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// --- Overlay live-state (for Companion button feedback) ---
// The relay is a forwarder, so it infers "what's currently on screen" by
// watching the real messages it relays. Companion polls GET /api/state and
// colours its buttons from these values.
const STUDIO_STATES = ['clear', 'standby', 'air', 'recording', 'wrap'];
let liveState = { names: false, total: false, studio: 'clear' };

function trackOverlayState(data) {
  if (!data || typeof data.type !== 'string') return;
  switch (data.type) {
    case 'update':
      // A global (sceneless) nameplate push. Scene-scoped pushes drive the
      // advanced multi-cam flow and don't map onto the single deck button.
      if (!data.scene && Array.isArray(data.items) && data.items.length > 0) {
        liveState.names = true;
      }
      break;
    case 'hide':
      if (!data.scene) { liveState.names = false; liveState.total = false; }
      break;
    case 'tiltify_show':
      liveState.total = (data.display === 'total' || data.display === 'totalizer');
      break;
    case 'tiltify_hide':
      liveState.total = false;
      break;
    case 'confidence_state':
      if (STUDIO_STATES.includes(data.state)) liveState.studio = data.state;
      break;
  }
}

const server = http.createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Static files (source.html, control.html, index.html) when STATIC_DIR is set.
  if (STATIC_DIR && req.method === 'GET') {
    const reqPath = url.pathname === '/' ? '/source.html' : url.pathname;
    const safe = reqPath.replace(/^\/+/, '').split('/').pop() || '';
    if (STATIC_FILES.has(safe)) {
      const filePath = path.join(STATIC_DIR, safe);
      try {
        const body = fs.readFileSync(filePath);
        const ct = CONTENT_TYPES[path.extname(safe)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, ...CORS_HEADERS });
        res.end(body);
        return;
      } catch { /* fall through */ }
    }
  }

  // GET /healthz — health check (kept for container probes)
  if (url.pathname === '/healthz' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
    res.end('ok');
    return;
  }

  // Everything under /api/* is gated by the shared token (when configured).
  if (url.pathname.startsWith('/api/') && !authOk(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }

  // GET /api/state — current overlay state for Companion button feedback
  if (url.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true, ...liveState }));
    return;
  }

  // GET /api/cmd/<go|hide|total> — Companion "deck as remote keyboard". The
  // relay just relays a remote_cmd; control.html (which holds the queue)
  // runs the matching goLive()/hideAll()/show-total action.
  if (url.pathname.startsWith('/api/cmd/') && req.method === 'GET') {
    const cmd = url.pathname.slice('/api/cmd/'.length);
    if (!['go', 'hide', 'total'].includes(cmd)) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: 'Unknown command' }));
      return;
    }
    broadcastToAll({ type: 'remote_cmd', cmd });
    console.log(`[API] GET /api/cmd/${cmd}`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true, cmd }));
    return;
  }

  // GET /api/studio/<clear|standby|air|recording|wrap> — set the host
  // confidence studio state directly (no control panel needed). Cached +
  // replayed like a confidence_state sent over WS.
  if (url.pathname.startsWith('/api/studio/') && req.method === 'GET') {
    const state = url.pathname.slice('/api/studio/'.length);
    if (!STUDIO_STATES.includes(state)) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: 'Unknown studio state' }));
      return;
    }
    const msg = { type: 'confidence_state', state };
    confidenceCache.state = msg;
    liveState.studio = state;
    broadcastToAll(msg);
    console.log(`[API] GET /api/studio/${state}`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true, studio: state }));
    return;
  }

  // POST /api/send — broadcast arbitrary JSON to all WS clients
  if (url.pathname === '/api/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        trackOverlayState(data);
        broadcastToAll(data);
        console.log(`[API] POST /api/send — type=${data.type || '?'}${data.scene ? ` scene=${data.scene}` : ''}`);
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // GET /api/hide — hide all overlay types
  if (url.pathname === '/api/hide' && req.method === 'GET') {
    const hideTypes = ['hide', 'tiltify_hide', 'schedule_hide', 'wheel_hide', 'image_hide'];
    for (const type of hideTypes) {
      broadcastToAll({ type });
    }
    liveState.names = false;
    liveState.total = false;
    // Clear the host confidence feature takeover (studio state + producer banner left intact)
    confidenceCache.feature = { type: 'confidence_feature', feature: 'none' };
    broadcastToAll(confidenceCache.feature);
    console.log('[API] GET /api/hide — broadcast all hide commands');
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

const wss = new WebSocketServer({ server });

let clientCount = 0;

function broadcastClientCount() {
  const msg = JSON.stringify({ type: 'clients', count: clientCount });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws, req) => {
  // Reads are open — OBS overlays / the host monitor connect with no
  // credential and just listen. A connection may SEND overlay-mutating
  // messages only if it's trusted: it arrived through Caddy's Twitch-gated
  // path (X-Forwarded-User injected, see the lowerthird Caddyfile) or it
  // presented a valid ?token= (Companion-over-WS / scripts). When auth is
  // disabled the relay is fully open (legacy behaviour).
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  ws.canWrite = !authEnabled
    || !!req.headers['x-forwarded-user']
    || tokenValid(u.searchParams.get('token'));

  clientCount++;
  console.log(`[WS] Client connected (${clientCount} total)`);
  broadcastClientCount();

  // Send cached data to new client
  if (tiltifyEnabled && tiltifyCache.lastUpdated > 0) {
    ws.send(JSON.stringify({ type: 'tiltify_data', ...tiltifyCache }));
  }
  if (horaroEnabled && horaroCache.lastUpdated > 0) {
    ws.send(JSON.stringify({ type: 'schedule_data', ...horaroCache }));
  }
  // Replay last-known confidence state so a host monitor opened late still syncs
  for (const cached of [confidenceCache.state, confidenceCache.feature, confidenceCache.producer]) {
    if (cached) ws.send(JSON.stringify(cached));
  }

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // Handle ping/pong
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (data.type === 'pong') {
      return;
    }

    // Untrusted (read-only) connections may emit `status` visibility pings
    // but nothing that drives the overlay or hits an upstream API.
    if (!ws.canWrite && data.type !== 'status') {
      return;
    }

    // Handle API lookups — respond to requesting client only
    if (data.type === 'src_lookup') {
      handleSrcLookup(ws, data);
      return;
    }
    if (data.type === 'twitch_lookup') {
      handleTwitchLookup(ws, data);
      return;
    }

    // Cache confidence state so it can be replayed to clients that connect later
    if (data.type === 'confidence_state') confidenceCache.state = data;
    else if (data.type === 'confidence_feature') confidenceCache.feature = data;
    else if (data.type === 'producer_msg') confidenceCache.producer = data;

    // Track overlay state from real traffic for Companion button feedback
    trackOverlayState(data);

    // Relay all other messages to all OTHER clients
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === 1) {
        client.send(msg);
      }
    }
  });

  ws.on('close', () => {
    clientCount--;
    console.log(`[WS] Client disconnected (${clientCount} total)`);
    broadcastClientCount();
  });
});

// --- Keepalive pings ---

setInterval(() => {
  const msg = JSON.stringify({ type: 'ping' });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}, 30_000);

// --- Start ---

server.listen(PORT, () => {
  console.log(`[Relay] WebSocket relay listening on port ${PORT}`);
  console.log(authEnabled
    ? '[Auth] Enabled — /ws reads open, writes need Caddy auth (X-Forwarded-User) or ?token=; /api/* needs the token'
    : '[Auth] DISABLED — /ws and /api/* fully open (set RELAY_TOKEN to gate writes)');
  if (tiltifyEnabled) {
    console.log(`[Tiltify] Integration enabled (campaign ${TILTIFY_CAMPAIGN_ID})`);
    // Initial poll, then every 15s
    pollTiltify();
    setInterval(pollTiltify, POLL_INTERVAL);
  } else {
    console.log('[Tiltify] Integration disabled (missing env vars)');
  }

  if (horaroEnabled) {
    console.log(`[Horaro] Schedule enabled (${HORARO_SCHEDULE})`);
    pollHoraro();
    setInterval(pollHoraro, HORARO_POLL_INTERVAL);
  } else {
    console.log('[Horaro] Schedule disabled (no HORARO_SCHEDULE env var)');
  }

  if (twitchEnabled) {
    console.log('[Twitch] Integration enabled');
  } else {
    console.log('[Twitch] Integration disabled (missing env vars)');
  }
});
