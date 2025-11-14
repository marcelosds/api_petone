# PetOne Locations Backend (Node HTTP)

Simple file-backed REST API to store device/pet locations.

Endpoints:

- `GET /health` — returns `{ status: "ok" }`
- `GET /localizacao/:petId` — list locations for a given `petId`
- `POST /localizacao` — create or update a location (upsert)
  - body: JSON object with fields like `id?`, `petId`, `label`, `latitude`, `longitude`, `origin?`, `createdBy?`, `createdAt?`
  - if `id` is omitted, the server generates one.
- `DELETE /localizacao/:id` — delete a location by id
- `DELETE /localizacao?petId=<PET_ID>` — delete all locations for a given `petId`; if `petId` is omitted, deletes all locations for current tenant

Device ingestion (TAG/Device):

- `POST /devices/register` — register or update a device/TAG mapping to a `petId`
  - body: `{ petId, code?, deviceId?, name? }`
  - per tenant; upsert behavior
- `GET /devices` — list registered devices for current tenant
- `POST /locations/ingest` — ingest a location using `code` or `deviceId`
  - body: `{ code? or deviceId?, lat, lng, accuracy?, speed?, timestamp? }`
  - resolves `petId` via device registry

Storage:

- JSON file at `api/storage/locations.json`

Run locally:

```bash
node api/server.js
```

Integrate with the app:

- Set `EXPO_PUBLIC_API_URL` to `http://localhost:3000`
- Switch the app to use remote API calls instead of local DB
  - In `src/services/api.js`, set `USE_LOCAL_DB = false` (temporário para testes)

Notes:

- CORS is enabled for `*` with `GET,POST,DELETE,OPTIONS`
- Authorization header is accepted but not validated; add verification if needed.
- Supports optional base path prefix via `BASE_PATH`, e.g., `BASE_PATH="/petone"`.

Seeding test coordinates:

- Use the seed script to insert locations directly into storage (multi-tenant by `uid`).
- Example:

```bash
node api/tools/seed.js --uid=YOUR_UID --petId=PET123 --label="Ponto" --lat=-23.55 --lng=-46.63 --count=3 --origin=map
```

- Or via npm:

```bash
npm run seed -- --uid=YOUR_UID --petId=PET123 --label="Ponto" --lat=-23.55 --lng=-46.63 --count=3 --origin=map
```

- Data is written to `api/storage/locations.json` in shape `{ tenants: { <uid>: { locations: [...] } } }`."# api_petone" 
