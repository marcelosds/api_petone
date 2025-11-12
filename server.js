// Simple Node HTTP server for storing device locations
// Endpoints:
//   GET    /health                      -> health check
//   GET    /localizacao/:petId          -> list locations by petId
//   POST   /localizacao                 -> upsert location
//   DELETE /localizacao/:id             -> delete location by id

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const admin = require('firebase-admin');

const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '';
const DATA_DIR = path.join(__dirname, 'storage');
const DATA_FILE = path.join(DATA_DIR, 'locations.json');
const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';

// Initialize Firebase Admin using Application Default Credentials
// Set env var GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path for local dev
let AUTH_ENABLED = !AUTH_DISABLED;
try {
  if (!admin.apps.length && AUTH_ENABLED) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    console.log('[server] Firebase Admin initialized');
  }
} catch (e) {
  console.warn('[server] Firebase Admin initialization failed:', e.message);
  AUTH_ENABLED = false;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(text);
}

async function ensureDataFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(DATA_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(DATA_FILE, JSON.stringify({ locations: [] }, null, 2), 'utf8');
  }
}

async function readData() {
  await ensureDataFile();
  const raw = await fsp.readFile(DATA_FILE, 'utf8');
  try {
    const json = JSON.parse(raw || '{}');
    if (!json || typeof json !== 'object') return { tenants: {} };
    // Migrate legacy shape { locations: [] } to multi-tenant on the fly
    if (Array.isArray(json.locations)) {
      return { tenants: { default: { locations: json.locations, devices: [] } } };
    }
    if (!json.tenants || typeof json.tenants !== 'object') json.tenants = {};
    return json;
  } catch {
    // Reset corrupted file
    return { tenants: {} };
  }
}

async function writeData(data) {
  // Simple atomic-like write: write to temp then replace
  await ensureDataFile();
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const json = JSON.parse(raw);
        resolve(json);
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function genId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `loc_${ts}_${rnd}`;
}

async function requireAuth(req) {
  // If auth is disabled or not configured, fallback to default tenant
  if (!AUTH_ENABLED) return 'default';
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded?.uid;
  } catch (e) {
    // In local/dev environments, Firebase Admin may initialize but fail at runtime
    // (e.g., cannot determine project ID). Fall back to default tenant gracefully.
    console.warn('[server] Token verification failed, falling back to default tenant:', e.message);
    AUTH_ENABLED = false; // disable auth for subsequent requests
    return 'default';
  }
}

function getTenant(data, uid) {
  if (!data.tenants[uid]) data.tenants[uid] = { locations: [], devices: [] };
  if (!Array.isArray(data.tenants[uid].locations)) data.tenants[uid].locations = [];
  if (!Array.isArray(data.tenants[uid].devices)) data.tenants[uid].devices = [];
  return data.tenants[uid];
}

function upsertDevice(tenant, payload) {
  const dev = {
    petId: payload.petId,
    code: payload.code,
    deviceId: payload.deviceId,
    name: payload.name,
    updatedAt: new Date().toISOString(),
  };
  const idx = tenant.devices.findIndex(d => (
    (dev.code && d.code === dev.code) ||
    (dev.deviceId && d.deviceId === dev.deviceId)
  ));
  if (idx >= 0) {
    tenant.devices[idx] = { ...tenant.devices[idx], ...dev };
    return tenant.devices[idx];
  }
  tenant.devices.push({ ...dev, createdAt: new Date().toISOString() });
  return dev;
}

function resolvePetIdByIdentifier(tenant, code, deviceId) {
  const found = tenant.devices.find(d => (
    (code && d.code === code) || (deviceId && d.deviceId === deviceId)
  ));
  return found?.petId;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = url.pathname;
  // Strip optional base path (e.g., "/petone") if configured
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    pathname = pathname.slice(BASE_PATH.length) || '/';
  }
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // Health
  if (pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', auth: AUTH_ENABLED ? 'enabled' : 'disabled' });
  }

  try {
    // Require Bearer token for all other routes
    const uid = await requireAuth(req);
    const data = await readData();
    const tenant = getTenant(data, uid);

    // GET /localizacao/:petId
    if (method === 'GET' && pathname.startsWith('/localizacao/')) {
      const petId = decodeURIComponent(pathname.split('/')[2] || '');
      const list = tenant.locations.filter((l) => String(l.petId) === String(petId));
      return sendJson(res, 200, list);
    }

    // POST /localizacao
    if (method === 'POST' && pathname === '/localizacao') {
      const payload = await parseBody(req);
      const now = new Date().toISOString();
      let loc = payload || {};
      if (!loc.id) loc.id = genId();
      // Force assignment to tenant
      loc.uid = uid;
      const idx = tenant.locations.findIndex((l) => l.id === loc.id);
      if (idx >= 0) {
        // Update, merge values
        tenant.locations[idx] = { ...tenant.locations[idx], ...loc, updatedAt: now };
        await writeData(data);
        return sendJson(res, 200, tenant.locations[idx]);
      } else {
        // Create
        if (!loc.createdAt) loc.createdAt = now;
        tenant.locations.push(loc);
        await writeData(data);
        return sendJson(res, 201, loc);
      }
    }

    // POST /locations/ingest
    if (method === 'POST' && pathname === '/locations/ingest') {
      const payload = await parseBody(req);
      const { code, deviceId, lat, lng, accuracy, speed, timestamp } = payload || {};
      if (!code && !deviceId) return sendJson(res, 400, { error: 'code or deviceId required' });
      const petId = resolvePetIdByIdentifier(tenant, code, deviceId);
      if (!petId) return sendJson(res, 404, { error: 'Pet not found for given identifier' });
      const nowIso = new Date().toISOString();
      const loc = {
        id: genId(),
        petId,
        label: payload?.label || 'device',
        latitude: Number(lat),
        longitude: Number(lng),
        accuracy: accuracy != null ? Number(accuracy) : undefined,
        speed: speed != null ? Number(speed) : undefined,
        createdAt: timestamp ? new Date(Number(timestamp)).toISOString() : nowIso,
        origin: 'device',
        createdBy: deviceId || code || 'unknown',
        uid,
      };
      tenant.locations.push(loc);
      await writeData(data);
      return sendJson(res, 201, loc);
    }

    // POST /devices/register
    if (method === 'POST' && pathname === '/devices/register') {
      const payload = await parseBody(req);
      if (!payload?.petId) return sendJson(res, 400, { error: 'petId required' });
      if (!payload?.code && !payload?.deviceId) return sendJson(res, 400, { error: 'code or deviceId required' });
      const dev = upsertDevice(tenant, payload);
      await writeData(data);
      return sendJson(res, 201, dev);
    }

    // GET /devices
    if (method === 'GET' && pathname === '/devices') {
      return sendJson(res, 200, tenant.devices || []);
    }

    // POST /devices/detach
    if (method === 'POST' && pathname === '/devices/detach') {
      const payload = await parseBody(req);
      const code = payload?.code || url.searchParams.get('code');
      const deviceId = payload?.deviceId || url.searchParams.get('deviceId');
      if (!code && !deviceId) return sendJson(res, 400, { error: 'code or deviceId required' });
      const idx = tenant.devices.findIndex(d => (
        (code && d.code === code) || (deviceId && d.deviceId === deviceId)
      ));
      if (idx < 0) return sendJson(res, 404, { error: 'Device not found' });
      tenant.devices[idx].petId = null;
      tenant.devices[idx].updatedAt = new Date().toISOString();
      await writeData(data);
      return sendJson(res, 200, tenant.devices[idx]);
    }

    // DELETE /devices (by code or deviceId)
    if (method === 'DELETE' && pathname === '/devices') {
      // Support both JSON body and query string params
      let code = url.searchParams.get('code');
      let deviceId = url.searchParams.get('deviceId');
      try {
        const body = await parseBody(req);
        code = code || body?.code;
        deviceId = deviceId || body?.deviceId;
      } catch (_) {
        // ignore body parse errors; rely on query params
      }
      if (!code && !deviceId) return sendJson(res, 400, { error: 'code or deviceId required' });
      const before = tenant.devices.length;
      tenant.devices = tenant.devices.filter(d => !(
        (code && d.code === code) || (deviceId && d.deviceId === deviceId)
      ));
      const deleted = before - tenant.devices.length;
      if (deleted === 0) return sendJson(res, 404, { error: 'Device not found' });
      await writeData(data);
      return sendJson(res, 200, { ok: true, deleted });
    }

    // DELETE /localizacao/:id
    if (method === 'DELETE' && pathname.startsWith('/localizacao/')) {
      const id = decodeURIComponent(pathname.split('/')[2] || '');
      const before = tenant.locations.length;
      tenant.locations = tenant.locations.filter((l) => l.id !== id);
      if (tenant.locations.length === before) {
        return sendJson(res, 404, { error: 'Not found' });
      }
      await writeData(data);
      return sendJson(res, 200, { ok: true });
    }

    // DELETE /localizacao?petId=...
    if (method === 'DELETE' && pathname === '/localizacao') {
      const petId = url.searchParams.get('petId');
      const before = tenant.locations.length;
      if (petId) {
        tenant.locations = tenant.locations.filter((l) => String(l.petId) !== String(petId));
      } else {
        tenant.locations = [];
      }
      const deleted = before - tenant.locations.length;
      await writeData(data);
      return sendJson(res, 200, { ok: true, deleted, scope: petId ? { petId } : 'all' });
    }

    // Fallback
    sendJson(res, 404, { error: 'Route not found' });
  } catch (err) {
    console.error('[server] Error:', err.message);
    sendJson(res, 400, { error: err.message || 'Bad request' });
  }
});

server.listen(PORT, () => {
  console.log(`[server] Locations API listening on http://localhost:${PORT}`);
});