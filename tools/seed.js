// Seed script to insert test coordinates into api/storage/locations.json
// Usage:
//   node api/tools/seed.js --uid=<UID> --petId=<PETID> [--label="Ponto"] [--lat=-23.55] [--lng=-46.63] [--count=3] [--origin=map] [--createdBy=seed]

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'storage');
const DATA_FILE = path.join(DATA_DIR, 'locations.json');

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

async function ensureFile() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(DATA_FILE, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(DATA_FILE, JSON.stringify({ tenants: {} }, null, 2), 'utf8');
  }
}

async function readData() {
  await ensureFile();
  const raw = await fsp.readFile(DATA_FILE, 'utf8');
  try {
    const json = JSON.parse(raw || '{}');
    if (Array.isArray(json.locations)) {
      return { tenants: { default: { locations: json.locations } } };
    }
    if (!json.tenants || typeof json.tenants !== 'object') json.tenants = {};
    return json;
  } catch {
    return { tenants: {} };
  }
}

async function writeData(data) {
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

function genId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `loc_seed_${ts}_${rnd}`;
}

function getTenant(data, uid) {
  if (!data.tenants[uid]) data.tenants[uid] = { locations: [] };
  return data.tenants[uid];
}

async function main() {
  const args = parseArgs(process.argv);
  const uid = args.uid;
  const petId = args.petId;
  if (!uid || !petId) {
    console.error('Usage: node api/tools/seed.js --uid=<UID> --petId=<PETID> [--label=...] [--lat=...] [--lng=...] [--count=...] [--origin=...] [--createdBy=...]');
    process.exit(1);
  }
  const label = args.label || 'Ponto de Teste';
  const lat = parseFloat(args.lat ?? '-23.55052');
  const lng = parseFloat(args.lng ?? '-46.633308');
  const count = Math.max(1, parseInt(args.count ?? '3', 10));
  const origin = args.origin || 'map';
  const createdBy = args.createdBy || 'seed';

  const nowIso = new Date().toISOString();
  const data = await readData();
  const tenant = getTenant(data, uid);

  for (let i = 0; i < count; i++) {
    const jitterLat = lat + (Math.random() - 0.5) * 0.001;
    const jitterLng = lng + (Math.random() - 0.5) * 0.001;
    const id = genId();
    tenant.locations.push({
      id,
      uid,
      petId,
      label: `${label} ${i + 1}`,
      latitude: +jitterLat.toFixed(6),
      longitude: +jitterLng.toFixed(6),
      origin,
      createdBy,
      createdAt: nowIso,
    });
  }

  await writeData(data);
  console.log(`Seed complete: inserted ${count} location(s) for uid=${uid}, petId=${petId}`);
}

main().catch((e) => {
  console.error('Seed error:', e);
  process.exit(1);
});