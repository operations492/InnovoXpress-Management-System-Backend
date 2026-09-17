# Innovo Xpress TMS — Backend reference

This is the exhaustive reference for the backend: every endpoint, every request and response shape,
every rule and the reason for it, every table, every job. It is written for an AI agent that must change
the backend correctly without re-reading the code first. `backend/CLAUDE.md` is the short orientation;
read it first.

Everything here was taken from the code on disk. If a sentence here disagrees with the code, the code is
right and this file must be fixed in the same change.

---

## 1. The domain in one page

A **consignment** is one courier job: collect goods from a **sender**, deliver them to a **receiver**. It
belongs to exactly one **client** (the company whose parcels move: Daraz, Apple Express, TCS in the seed),
carries one or more **items**, may name a **service level** ("5 Ton Truck", "Expedite" …), and is worked
by at most one **driver**.

Addresses, weights and dimensions are Canadian: two-letter provinces, `A1A 1A1` postcodes, pounds,
inches. Every seed is in the Greater Toronto Area.

### The lifecycle — eight states, forward only

```
UNASSIGNED ──assign──► ASSIGNED ──manual──► EN_ROUTE_TO_PICKUP ──manual──► AT_PICKUP
                                                                              │ PROOF
                                                                              ▼
DELIVERED ◄──PROOF── AT_DELIVERY ◄──manual── EN_ROUTE_TO_DELIVERY ◄──manual── PICKED_UP
```

`src/constants/statusFlow.ts` is the single definition. Each edge names the **gate** that may traverse it:

| Gate | Traverses | Triggered by |
|---|---|---|
| `ASSIGNMENT` | UNASSIGNED ↔ ASSIGNED | `POST/DELETE /api/consignments/:id/assign`, bulk assign |
| `MANUAL` | ASSIGNED → EN_ROUTE_TO_PICKUP → AT_PICKUP, PICKED_UP → EN_ROUTE_TO_DELIVERY → AT_DELIVERY | `PATCH /api/consignments/:id/status` |
| `POD` | AT_PICKUP → PICKED_UP, AT_DELIVERY → DELIVERED | `POST /api/consignments/:id/pod/:leg` |

Consequences an agent must keep true:

- `PATCH /status` accepts only the four `MANUAL` targets. The Zod schema rejects `PICKED_UP` and
  `DELIVERED`; the service re-checks the gate.
- `PICKED_UP` and `DELIVERED` are set only inside the proof-upload transaction, so status and stored
  proof never disagree.
- **Editable** means `UNASSIGNED` or `ASSIGNED` (`isEditable`). Past that, `PUT` is a 409.
- Database CHECK: `("driverId" IS NULL) = (status = 'UNASSIGNED')`. The three dispatch-map tabs are a
  clean partition of the enum because of it (`src/constants/mapTabs.ts`).
- There is no `CANCELLED` and no `FAILED`. Adding one later is an append-only enum change; do not add
  them unprompted.

### Order identity

- `orderNo` — server-assigned, globally unique, `{CLIENTCODE}-{YYYYMMDD}-{0001}` (e.g.
  `DRZ-20260915-0001`). Allocated by one atomic upsert on `order_counters` **before and outside** the
  insert transaction (§7). Never accepted from a client.
- `clientReference` — the client's own tracking id. Optional, unique **within** a client
  (`@@unique([clientId, clientReference])`), re-checked when the client of an order changes.

---

## 2. Architecture

**Modular monolith**: one Express process, one Postgres database, feature modules with real boundaries.

```
routes → controller → service → repository → Prisma
```

| Layer | Owns | Must not |
|---|---|---|
| `*.routes.ts` | middleware chain per endpoint | contain logic |
| `*.controller.ts` | read `req`, call one service function, send status + JSON | touch Prisma or rules |
| `*.service.ts` | every rule, every error, DTO shaping | import `config/prisma` |
| `*.repository.ts` | every query, every transaction | contain business rules |

`grep -r "config/prisma" backend/src/modules/*/*.service.ts` must print nothing.

**Modules** (`src/modules/`): `auth · chat · clients · consignments · drivers · locations · map · pod · reference
· routes · routing · serviceLevels · users`. `locations` has no routes file; `drivers.routes.ts` mounts
its handlers. `pod` is mounted under `/api/consignments/:id/pod` with `mergeParams`. `routing` owns the
OSRM client (`routing.osrm.ts`); `routes` imports that client for geometry.

Tolerated cross-module imports (do not add more): `locations.service → drivers.repository`,
`routes.service → routing.osrm`, `users.service → map.service` (`nextColorIndex`),
`consignments.repository` has its own `findDriverById`.

**Request pipeline** (`src/app.ts`, in order):

1. `cors` — allowlist from `CORS_ORIGINS` (comma-separated), `credentials: true`; wide open when
   `NODE_ENV=test`.
2. `express.json({ limit: '1mb' })`.
3. `GET /health` → runs `SELECT 1`, returns `{ status: "ok" }`.
4. Routers: `/api/auth`, `/api/reference`, `/api/clients`, `/api/service-levels`, `/api/consignments`, `/api/drivers`,
   `/api/users`, `/api/chat`, `/api/map`, `/api/routes`.
5. `notFound` → 404 `Route not found: METHOD /path`.
6. `errorHandler` → every error leaves as `{ error: { code, message, details? } }`.

**Error mapping** (`src/middleware/errorHandler.ts`):

| Source | Status | code |
|---|---|---|
| `AppError` (`badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict`) | 400 / 401 / 403 / 404 / 409 | `BAD_REQUEST` … `CONFLICT` |
| Zod failure (via `validate`) | 400 | `BAD_REQUEST`, `details = fieldErrors` |
| Multer `LIMIT_FILE_SIZE` | 413 | `PAYLOAD_TOO_LARGE` |
| Other multer errors | 400 | details `{ field, code }` |
| Prisma P2002 unique violation | 409 | `CONFLICT`, details name the target |
| Prisma P2025 not found | 404 | `NOT_FOUND` |
| Prisma P2003 foreign key | 400 | `BAD_REQUEST` |
| Prisma P2034 write conflict | 409 | `CONFLICT` |
| Prisma P2028 transaction timeout | 503 | `TRANSACTION_TIMEOUT` |
| anything else | 500 | `INTERNAL`, logged with `console.error` |

**Validation** (`src/middleware/validate.ts`): `validate(schema, 'body' | 'query' | 'params')`. Body and
params are replaced by the parsed value. Query is stored on `req.validatedQuery` (Express 5 makes
`req.query` read-only) and read with `getValidatedQuery(req)`. **Every body schema is `.strict()`**: an
unknown key is a 400, so server-owned fields like `orderNo` and `status` are rejected, never ignored.

---

## 3. Authentication and authorization

### Layer 1 — who are you? (`src/middleware/auth.ts`)

Supabase Auth issues every token; this API only verifies. There is no login endpoint, no password check,
no signing secret.

1. `Authorization: Bearer <jwt>` is required → else 401 `Missing or malformed Authorization header`.
2. The token is verified locally with `jose` against `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`
   (ES256; issuer and audience `authenticated` checked; the JWKS is re-fetched on an unknown `kid`).
   Bad signature / expired → 401 `Invalid or expired token`. JWKS unreachable → **503**
   `Could not reach the authentication service`, so an outage is not reported as a bad token.
3. The `sub` claim is our `users.id`. The profile row `{ id, email, role, active, driverId }` is loaded
   through `auth.repository.findUserById` and cached **30 seconds** (`forgetProfile(id)` and
   `forgetAllProfiles()` clear it; the users service calls them after edits). No profile → 403
   `This account has no profile in the system`; `active = false` → 403 `This account has been
   deactivated`.
4. `req.user` is that profile row (type `AuthUser` in `src/types/auth.ts`).

**The `role` claim is not our role.** Supabase's top-level `role` claim is always `anon` /
`authenticated` / `service_role` — the Postgres role for RLS. Our role is `app_metadata.role`, mirrored
from `users.role` by `users.service.syncClaims`, and the middleware reads it from the profile row.

### Layer 2 — what kind of caller? (`src/middleware/rbac.ts`)

`requireMinRole('driver' | 'operator' | 'admin')`, ranked `driver 0 < operator 1 < admin 2`. Below rank
→ 403 `Requires <role> role or higher`. `requireDriver` additionally requires a linked `driverId` → else
403 `This endpoint is for the driver app`.

### Layer 3 — is this record yours? (`src/middleware/ownership.ts`)

`allowOperatorOrAssignedDriver`: operators and admins pass; a driver passes only when
`consignment.driverId === req.user.driverId`. **"Not yours" and "does not exist" both return 403** with
the same body, so ids cannot be probed. Chat applies the same idea with `requireConversationMember`
(membership, not role; 403 for both cases; admins get no bypass).

### Identity model

- `auth.users` (GoTrue) holds credentials. Written only through `supabase.auth.admin.*` in
  `users.service`.
- `public.users` is the profile: same uuid as `id`, `email`, `name`, `role`, `active`, `driverId`
  (unique — one login per driver at most).
- `GET /api/auth/me` returns `{ id, email, name, role, active, driver: { id, name, code, active,
  onShift } | null }` so the driver app learns its roster row and shift state in one call.

### The driver lifecycle — three separate states

| State | Column | Set by | Meaning |
|---|---|---|---|
| Employed | `drivers.active` | admin (`PATCH /api/users/:id`) | deactivating also clocks off and stamps `shiftEndedAt` if a shift was open |
| On shift | `drivers.onShift` + `shiftStartedAt` / `shiftEndedAt` | driver (`POST /api/drivers/me/shift`), pg_cron at 04:00 | assignable only while on shift |
| Has login | `users.driverId` | admin (`POST /api/users`) | one login per driver |

Shift rules (raw SQL in `users.service.setShift`, because the update depends on the current row): clock
on sets `shiftStartedAt = now(), shiftEndedAt = null`; clock off sets `shiftEndedAt = now()` only if
currently on shift and leaves `shiftStartedAt` alone; re-tapping the same button changes nothing. Only
the latest shift is kept. The 04:00 job stamps `shiftEndedAt` at the driver's **last GPS ping** of that
shift, falling back to `now()`.

---

## 4. API reference

All paths below are prefixed `/api` unless stated. All require `authenticate` unless stated. Dates are ISO
8601 strings in JSON. `Decimal` columns arrive as numbers in mapped DTOs.

### 4.1 Health and auth

| Method | Path | Who | Returns |
|---|---|---|---|
| GET | `/health` (no prefix, no auth) | anyone | `{ status: "ok" }` after `SELECT 1` |
| GET | `/auth/me` | any signed-in user | profile + driver row (see §3) |

### 4.2 Reference — `GET /reference` (operator+)

Everything the console needs to fill its dropdowns in one call:

```json
{
  "clients":       [{ "id", "name", "code" }],                       // active, by name
  "drivers":       [{ "id", "name", "code", "mobile" }],             // active, by name
  "serviceLevels": [{ "id", "name" }],                               // active, by sortOrder then name
  "statuses":      [{ "value", "label" }],                           // 8 lifecycle states
  "priorities":    [{ "value", "label" }],                           // NORMAL, HIGH, LOW
  "taskTypes":     [{ "value", "label" }]                            // DELIVERY, PICKUP, PICKUP_AND_DELIVERY
}
```

### 4.3 Service levels — `/service-levels`

An admin-managed lookup (a table, not an enum) that orders reference by id.

| Method | Path | Who | Body / query | Notes |
|---|---|---|---|---|
| GET | `/` | operator+ | `?includeInactive=true` to include retired | ordered by `sortOrder`, then name |
| GET | `/:id` | operator+ | | 404 if unknown |
| POST | `/` | admin | `{ name (1–80), sortOrder? }` | 201; name unique case-insensitively → 409; omitted `sortOrder` goes last |
| PATCH | `/:id` | admin | `{ name?, sortOrder?, active? }` (at least one) | rename reaches every order that uses it |
| DELETE | `/:id` | admin | | 204; **409 if any order references it** ("deactivate it instead") |

DTO: `{ id, name, active, sortOrder, usageCount, createdAt, updatedAt }`. `usageCount` is the number of
consignments referencing the level; the console offers Delete only at zero.

### 4.4 Users — `/users` (admin only, every route)

| Method | Path | Body / query | Behaviour |
|---|---|---|---|
| GET | `/` | `?role=&q=&includeInactive=` | `q` matches name or email, case-insensitive |
| GET | `/unlinked-drivers` | | active roster rows with no login yet |
| GET | `/:id` | | 404 if unknown |
| POST | `/` | `{ email, password (≥8), name, role, driverId? \| newDriver?: { name, code?, mobile? } }` | 201 `{ user }`. For `role: driver` exactly one of `driverId` (link an existing, unlinked, active driver) or `newDriver` (create the roster row, allocating `mapColorIndex`). Creates the Supabase user with `email_confirm: true` and `app_metadata = { role, driver_id }`, then the profile; on profile failure the auth user and any new driver row are deleted again. Email taken / driver already linked → 409 |
| PATCH | `/:id` | `{ email?, password?, name?, role?, active? }` | Cannot demote or deactivate yourself, or the last active admin (400). Role change re-syncs `app_metadata`. Deactivating a driver user clocks them off. Clears the profile cache |
| DELETE | `/:id` | | `{ deleted: true, driverKept }` — deletes login and profile, keeps the roster row. Same self / last-admin guards |
| DELETE | `/drivers/:id` | | Removes a driver from the roster **only if they have no consignments and no proofs**, else 409. Deletes their login and profile too |

User DTO: `{ id, email, name, role, active, createdAt, driver: { id, name, code, active, onShift } | null }`.

A profile-creation failure that also fails its rollback leaves a "ghost" auth account: it can sign in and
gets 403 on every request because it has no profile.

### 4.5 Consignments — `/consignments`

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/` | operator+ | create |
| GET | `/` | operator+ | paginated list of slim rows |
| GET | `/:id` | operator, or the assigned driver | full record |
| PUT | `/:id` | operator+ | edit while editable |
| PATCH | `/:id/status` | operator, or the assigned driver | one manual step |
| POST | `/:id/assign` | operator+ | assign or swap driver |
| DELETE | `/:id/assign` | operator+ | unassign |
| POST | `/assign-bulk` | operator+ | assign many, partial success |
| GET | `/:id/nearest-drivers` | operator+ | §4.9 |
| GET | `/:id/driver-route` | operator+ | §4.9 |
| * | `/:id/pod/...` | see §4.6 | proof of delivery |

**Create body** (`createConsignmentSchema`):

```json
{
  "clientId": "…",                          // required; client must exist and be active (400)
  "clientReference": "PO-1001",             // optional, ≤64, unique within the client (409)
  "serviceLevelId": "…",                    // optional; must exist and be active (400)
  "taskType": "DELIVERY",                   // DELIVERY | PICKUP | PICKUP_AND_DELIVERY (default DELIVERY)
  "priority": "NORMAL",                     // NORMAL | HIGH | LOW (default NORMAL)
  "sender":   { "name", "phone?", "email?", "line1", "city", "province?", "postcode?", "instructions?", "lat?", "lng?" },
  "receiver": { "name", "phone?", "email?", "line1", "city", "province?", "postcode?", "notes?",        "lat?", "lng?" },
  "pickupAfter": "…", "pickupBefore": "…",  // all four required; pickupBefore ≥ pickupAfter
  "deliverAfter": "…", "deliverBefore": "…",// deliverBefore ≥ deliverAfter and ≥ pickupAfter
  "generalNote": "…",                       // optional, ≤2000
  "items": [                                // at least one
    { "barcode?": "LKA001450097", "description": "…", "qty": 1,
      "weightLb?": 14, "lengthIn?": 15, "widthIn?": 13, "heightIn?": 15 }
  ]
}
```

Address text is not validated beyond length. Coordinates are optional (Postman and seeds may omit them)
but the console always sends them. `status` and `orderNo` in the body are a 400.

What create does, in order: validate client and service level → pre-check `clientReference` → allocate
`orderNo` (outside the transaction) → one Prisma create with nested items and the opening tracking event
(`null → UNASSIGNED`, note "Consignment logged") → return the detail DTO with 201.

**List query** (`listConsignmentsQuerySchema`):

| Param | Meaning |
|---|---|
| `status` | one lifecycle value |
| `clientId`, `driverId` | exact match |
| `unassigned=true` | `driverId IS NULL` |
| `tab` | `unassigned` \| `assigned` \| `completed` → the tab's status set from `mapTabs.ts`. Combined with an explicit `status` by intersection: a status outside the tab yields an empty page rather than one filter overriding the other |
| `from`, `to` | `createdAt` range; a `to` at exactly midnight is widened to the end of that day |
| `q` | 1–120 chars, case-insensitive substring over `orderNo`, `clientReference`, `senderName`, `receiverName`, `senderCity`, `receiverCity`, `receiverProvince` |
| `page` (default 1), `pageSize` (1–100, default 20) | |
| `sort` (`createdAt` \| `orderNo` \| `status` \| `pickupAfter` \| `deliverBefore`, default `createdAt`), `order` (`asc` \| `desc`, default `desc`) | |

Response: `{ data: SummaryRow[], meta: { total, page, pageSize, totalPages } }`.

**Summary row** (no items, no proofs, no timeline):

```
id, orderNo, clientReference, client { id, name, code }, driver { id, name } | null,
serviceLevel { id, name } | null, status, statusLabel, priority, taskType,
senderName, senderLine1, senderCity, senderProvince, senderLat, senderLng,
receiverName, receiverLine1, receiverCity, receiverProvince, receiverLat, receiverLng,
pickupAfter, pickupBefore, deliverAfter, deliverBefore, generalNote, createdAt,
itemCount, totalQty, totalWeightLb, totalCubic
```

**Detail DTO** (create, get, update, status, assign all return it):

```
…everything in the summary row, plus
sender   { name, phone, email, line1, province, city, postcode, instructions, lat, lng }
receiver { name, phone, email, line1, province, city, postcode, notes, lat, lng }
assignedAt, pickedUpAt, deliveredAt, updatedAt,
items: [{ id, barcode, description, qty, weightLb, lengthIn, widthIn, heightIn, cubic }],
totals: { itemCount, totalQty, totalWeightLb, totalCubic },
proofs: [{ leg, capturedAt, photoBytes, signatureBytes }],
timeline: [{ id, fromStatus, toStatus, fromStatusLabel, toStatusLabel, driver { id, name } | null, actorEmail, note, recordedAt }]  // newest first
```

`cubic` per item = `lengthIn × widthIn × heightIn ÷ 61,023.744` (cubic inches → cubic metres), four
decimals, `null` when any dimension is missing. `weightLb` is the **whole line as typed**; totals are
plain sums and are never multiplied by `qty`.

**Update body** (`updateConsignmentSchema`) — every field optional; only sent fields change:

- `clientId` — move the order to another active client (400 if unknown/inactive). The `orderNo` keeps its
  original prefix. The order's `clientReference` is re-checked for uniqueness under the new client.
- `clientReference` (nullable), `serviceLevelId` (nullable: `null` clears it), `taskType`, `priority`,
  `sender`, `receiver`, the four windows (optional, **not** nullable — the columns are NOT NULL),
  `generalNote` (nullable).
- `items` — omit to leave items alone; send a non-empty array to reconcile by id: an item **with** an
  `id` is updated, **without** one is created, and every existing item **not** in the list is deleted. An
  id belonging to another order → 400. `[]` → 400.

409 when the order is not editable (`EN_ROUTE_TO_PICKUP` or later).

**Status change** — `PATCH /:id/status` `{ status, note? (≤500) }`, `status` ∈ `EN_ROUTE_TO_PICKUP`,
`AT_PICKUP`, `EN_ROUTE_TO_DELIVERY`, `AT_DELIVERY`. Compare-and-swap on the expected current status;
if another caller moved it first → 409. Writes a tracking event.

**Assign** — `POST /:id/assign` `{ driverId, note? }`. Driver must exist and be active (400) and **on
shift (409: "must clock on before taking new work")**. Allowed from `UNASSIGNED` (fresh; stamps
`assignedAt`) or `ASSIGNED` (swap; keeps `assignedAt`). Same driver again → 409. Past `ASSIGNED` → 409.

**Unassign** — `DELETE /:id/assign`. Only from `ASSIGNED` → back to `UNASSIGNED`, clears `driverId` and
`assignedAt`. Anything else → 409.

**Bulk assign** — `POST /assign-bulk` `{ consignmentIds (1–200), driverId, note? }`. Runs the single
assign rule per order, catching each failure. **Always 200**, never 207:

```json
{ "driverId": "…", "assigned": ["id", …], "failed": [{ "id", "orderNo", "code", "message" }],
  "counts": { "requested": 50, "assigned": 48, "failed": 2 } }
```

Partial success is the contract: fifty orders lassoed on a map are fifty independent decisions.

### 4.6 Proof of delivery — `/consignments/:id/pod`

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/` | operator, or assigned driver | both legs with signed URLs |
| POST | `/:leg` (`pickup` \| `delivery`) | operator, or assigned driver | capture; **advances the status** |
| PUT | `/:leg/files` | admin | replace the two files of an existing proof; no status change |

**Capture request**: `multipart/form-data` with file fields `photo` and `signature` (both required),
body fields `capturedByDriverId?`, `signedByName?` (1–120), `note?` (≤500), optional header
`Idempotency-Key`. Middleware order is deliberate: params → ownership → multer → body schema, so an
unauthorised request never reads the upload off the wire.

Rules, in the order they are checked:

1. Files buffered in memory (`multer.memoryStorage`), max 2 files. Over `POD_MAX_PHOTO_BYTES` (10 MB) or
   `POD_MAX_SIGNATURE_BYTES` (2 MB) → 413. Missing either file → 400.
2. **Magic bytes** decide the type (`utils/imageSniff.ts`): PNG, JPEG or WebP; `Content-Type` is
   ignored. Mismatch → 400 "…its actual contents were checked, not its declared type".
3. Leg vs status: `pickup` requires `AT_PICKUP`, `delivery` requires `AT_DELIVERY` → else 409. No driver
   assigned → 409. Leg already captured → 409, unless the `Idempotency-Key` matches the stored one, in
   which case the original proof is returned with **200** (a genuine capture is **201**).
4. Files are uploaded to the private `pod` bucket at deterministic paths
   `{consignmentId}/{LEG}/photo.{ext}` and `{consignmentId}/{LEG}/signature.{ext}` with upsert, so a
   retry overwrites rather than accumulates.
5. One transaction (15 s timeout): compare-and-swap the status (`AT_PICKUP → PICKED_UP` stamping
   `pickedUpAt`, or `AT_DELIVERY → DELIVERED` stamping `deliveredAt`), insert the proof row, write the
   tracking event. A lost race → 409 "order changed while uploading"; the just-written objects are
   deleted best-effort.

**Never reorder steps 4 and 5**: row-first would allow `DELIVERED` with no proof file.

**Read DTO** per leg:

```json
{ "leg": "PICKUP", "capturedAt": "…", "signedByName": "…" | null,
  "capturedByDriver": { "id", "name" } | null,
  "photo":     { "mime", "bytes", "url" },      // url is a signed link
  "signature": { "mime", "bytes", "url" },
  "replacedAt": null, "expiresInSeconds": 300 }  // POD_SIGNED_URL_TTL
```

### 4.7 Drivers — `/drivers`

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/me/consignments?includeDelivered=` | driver | my jobs |
| POST | `/me/locations` | driver | batch of GPS pings |
| POST | `/me/shift` | driver | clock on / off |
| GET | `/?q=&includeInactive=&onShift=` | operator+ | roster with live load |
| GET | `/locations/latest?withinMinutes=&onShiftOnly=` | operator+ | live positions |
| GET | `/:id/trail?from=&to=&limit=` | operator+ | GPS history |

**My consignments**: `driverId` comes from the token (`req.user.driverId`), never from the URL. Excludes
`DELIVERED` unless `includeDelivered=true` ("what is left to do, not a growing history"). Each row:
`id, orderNo, status, priority, taskType, generalNote, client { name }, sender* (name, phone, line1,
province, city, instructions), pickupAfter, receiver* (…, notes), deliverBefore, items [{ id, barcode,
description, qty, weightLb, lengthIn, widthIn, heightIn }], proofs [{ leg, capturedAt }]` plus a computed
**`nextAction`** so the app never re-encodes the state machine:

```
ASSIGNED → START_PICKUP · EN_ROUTE_TO_PICKUP → ARRIVE_AT_PICKUP · AT_PICKUP → CAPTURE_PICKUP_PROOF
PICKED_UP → START_DELIVERY · EN_ROUTE_TO_DELIVERY → ARRIVE_AT_DELIVERY · AT_DELIVERY → CAPTURE_DELIVERY_PROOF
DELIVERED → NONE
```

**Shift**: `{ onShift: boolean }` → `{ id, name, onShift, shiftStartedAt, shiftEndedAt }`. Rules in §3.

**Locations**: `{ pings: [{ lat, lng, accuracyM?, speedMps?, headingDeg?, consignmentId?, recordedAt? }] }`,
1–200 per request (the phone buffers offline and flushes). Returns
`{ accepted, position: { lat, lng, recordedAt } }`. Rules (`locations.service`):

- A ping in the future is rejected; missing timestamps are spaced 1 ms apart so "latest" is never
  ambiguous.
- The **live row** (`driver_positions`) is always upserted with the newest ping, but only if its
  `recordedAt` is not older than what is stored, so a late buffered batch cannot rewind the pin.
- **History** (`driver_locations`) keeps a ping only when it is at least `HISTORY_MIN_MOVE_M` (15 m,
  haversine) from the last kept point, starting from the stored live position and walking cumulatively
  through the batch. A parked driver adds one row, not one per batch.
- An unknown `consignmentId` is nulled, not rejected (a reseed must not break position reporting).

**Latest**: reads `driver_positions`, not history. A driver is **live** when `onShift` **and**
`recordedAt` is within the window — default `POSITION_LIVE_SECONDS` (120), overridable with
`withinMinutes` (1–1440; no default on purpose so it cannot silently widen the window). `onShiftOnly`
defaults to `true`. Returns `{ data: [{ driverId, name, lat, lng, accuracyM?, speedMps?, headingDeg?,
recordedAt }], meta: { withinSeconds, onShiftOnly } }`.

**Trail**: oldest-first history for drawing a polyline; `limit` 1–5000 (default 1000). Returns
`{ driver, retentionDays, count, data: [{ lat, lng, accuracyM?, speedMps?, recordedAt, consignmentId? }] }`.
404 for an unknown driver.

### 4.8 Dispatch map — `/map` (operator+)

**`GET /pins`** — every task as a waypoint, in one request, with facet counts. Query:

| Param | Meaning |
|---|---|
| `tab` | `unassigned` \| `assigned` \| `completed`; filters rows **but not counts** |
| `driverIds` | CSV or repeated; orthogonal to `tab` (unassigned by driver is honestly empty) |
| `clientId` | exact |
| `q` | 1–100 chars over `orderNo`, `clientReference`, `receiverName`, `receiverCity` |
| `from`, `to` | on the **`deliverBefore`** axis (the dispatch map bounds by deadline); send instants |
| `completedSince` | default now − 24 h; delivered tasks older than this are dropped, open tasks always show |
| `limit` | ≤ 5000, default 5000 — a circuit breaker, not a page size |

Rows are ordered `deliverBefore asc, createdAt asc` so the sidebar never reshuffles between refetches.

Pin DTO:

```
id, orderNo, status, taskType, priority,
lat, lng,                      // = receiver coordinates when plottable, else null
senderLat, senderLng, receiverLat, receiverLng,
clientName,
senderName, senderLine1, senderProvince, senderCity,
receiverName, receiverLine1, receiverProvince, receiverCity,
totalQty, pickupAfter, pickupBefore, deliverAfter, deliverBefore,
driver { id, name, colorIndex } | null
```

**Plottable** means non-null, finite, within range and not `(0, 0)` (a half-filled form or failed
geocode). Both ends' coordinates and addresses ship so the console can plot either end; the server's
`lat/lng` is always the receiver.

`meta`: `{ counts: { unassigned, assigned, completed }, byStatus, byDriver, unmappable, total, returned,
truncated }`. `counts` and `total` come from a single `groupBy(status)` folded through
`MAP_TAB_STATUSES`, so badges always sum to the total. They respect every filter **except `tab`**, so
switching tabs never moves the numbers. `byDriver` merges the roster (including inactive drivers still
holding open work) onto the counts. `unmappable` counts returned pins with null coordinates.

Deliberately absent from a pin: items, `generalNote`, sender contact details, proofs, tracking events.
Those belong to `GET /api/consignments/:id`.

**`GET /drivers?includeInactive=`** (default `true`) — the DRIVERS-tab roster:
`[{ id, name, code, active, onShift, colorIndex, assignedCount }]`. With `includeInactive=false`,
deactivated drivers are dropped unless they still hold open work.

**Colours**: `drivers.mapColorIndex` is an index into an 8-colour palette (`MAP_COLOR_COUNT`), assigned
least-used-first at driver creation (`map.service.nextColorIndex`), never unique; drivers created before
the column fall back to a hash of the id. Colour is never the only encoding.

### 4.9 Routing — under `/consignments/:id` (operator+, needs OSRM)

**`GET /:id/nearest-drivers?withinMinutes=&includeUnlocated=&limit=`** — ranks assignable drivers by
drive time to the order's **pickup** (sender) coordinate.

- Candidates: active **and** on-shift drivers (`LEFT JOIN driver_positions`, so a clocked-on driver whose
  phone has not reported is still a candidate; they come back with `ranked: false` and sort last when
  `includeUnlocated=true`, the default). `withinMinutes` 1–1440, default 3. `limit` 1–100, default 50.
- One OSRM `/table` call ranks all located drivers. If OSRM is unreachable the service falls back to
  straight-line haversine distance, leaves `durationS` null (a faked speed would lie), and says so:
  `meta.source` is `osrm` | `straight-line` | `none`, with a `warning` string when degraded.
- Sort: ranked first, then `durationS` (or `distanceM` when degraded), then lower `activeLoad`, then
  name (so the list never reshuffles arbitrarily between polls).
- Per driver: `{ driverId, name, code, mobile, colorIndex, activeLoad, lat, lng, recordedAt, accuracyM,
  staleSeconds, durationS, distanceM, ranked }`. Meta: `{ source, warning, rankedCount, unlocatedCount,
  totalCandidates, trafficAware: false }`.

**`GET /:id/driver-route?driverId=`** — the road line from the driver's last position to the pickup.
**Always 200.** Success: `{ available: true, points: [[lat, lng], …], distanceM, durationS, staleSeconds }`.
Otherwise `{ available: false, reason: 'no-position' | 'no-road-route' | 'engine-unavailable', warning }`.
The position is deliberately not windowed by recency; `staleSeconds` reports its age instead.

**The OSRM client** (`routing.osrm.ts`): profile `driving`; `AbortSignal.timeout(OSRM_TIMEOUT_MS)`
(4 s); `routeTo`, `matrixTo`, `routeThrough`, `optimiseTrip`. `/table` and `/trip` cap at **100
coordinates** (`TRIP_MAX_POINTS`); `/route` has no cap (126 waypoints ≈ 300 ms). "No road" answers
(`NoRoute`, `NoSegment`) return `null`; everything else throws `OsrmUnavailableError`. **OSRM speaks
`lon,lat`; the flip to `[lat, lng]` happens here, once.** OSRM is not traffic-aware: durations come from
OpenStreetMap speed profiles, so trust the ordering and treat the clock as optimistic. The extract must
cover the Greater Toronto Area.

### 4.10 Planned routes — `/routes` (operator+)

A route is a **plan**: one active per driver, recording an intended visiting order and start/end points.
It gates nothing; deleting it changes no consignment.

| Method | Path | Body | Behaviour |
|---|---|---|---|
| POST | `/` | `{ driverId, consignmentIds (2–95), start: { lat, lng, label? }, end?: { lat, lng, label? }, clientKey? }` | Validates driver active and on shift (409), every order exists (400), is assigned to that driver (409), not delivered (409), has receiver coordinates (400), start/end plottable (400). Asks OSRM `/trip` for the order (**503 if OSRM is down — there is no honest order to save**). Supersedes the driver's previous ACTIVE route in the same transaction. `clientKey` makes a double-tap return the first route |
| GET | `/driver/:driverId` | | **200 with `{ route: null }`** when there is none; otherwise the route below with geometry regenerated from OSRM |
| DELETE | `/driver/:driverId` | | supersedes the active route (404 if none); assignments survive |
| PATCH | `/:id/sequence` | `{ consignmentIds, version }` | `consignmentIds` must be an **exact permutation** of the current stops (400 otherwise). `version` mismatch → 409 (another dispatcher edited it). Sets `sequenceSource: MANUAL`, bumps `version`, recomputes planned totals. Uses a DEFERRABLE unique on `(routeId, seq)` so the shuffle can pass through duplicates |
| POST | `/:id/optimise` | | **preview only, saves nothing**: `{ consignmentIds, version, unchanged, current: { distanceM, durationS }, proposed: {…}, saves: {…} }`. 503 if OSRM is down, 409 if no tour is possible |

Route DTO: `{ id, driver, status: 'ACTIVE' | 'SUPERSEDED', version, start, end, sequenceSource:
'OPTIMISED' | 'MANUAL', stops: [{ seq, consignmentId, orderNo, status, plannedLat, plannedLng, issues[] }],
points: [[lat, lng], …], distanceM, durationS, geometryError, needsReview, trafficAware: false }`.
`points` is empty with `geometryError: true` when OSRM is unreachable on read.

**Stop issues** are derived on every read, never stored: `delivered` (status DELIVERED), `reassigned`
(order now on another driver), `unassigned` (no driver), `address-moved` (receiver coordinate differs
from the planned snapshot by more than 50 m). Any issue sets `needsReview`.

Two rules carry the design: **the sequence is stored and the line never is** (geometry from OSRM on every
read, so nothing can go stale), and **the computer suggests, the operator decides** (`/trip` picks an
order only when asked; the read draws whatever is saved and reports its honest cost even when worse).

### 4.11 Chat — `/chat`

Router-level gate is `requireMinRole('driver')`, so drivers reach chat. What keeps it safe is that
**every `/:id` route runs `requireConversationMember`**: membership, not role, and 403 for both "not a
member" and "no such conversation", with no admin bypass. Two things stay staff-only: creating a space
and adding members.

**The driver rule in one line: dispatch opens conversations, drivers reply to them.** A driver's
directory is empty and `POST /conversations/direct` from a driver is 403. An operator may open a direct
thread with a driver. Spaces may not contain drivers (`assertEligible(…, allowDrivers=false)`).

| Method | Path | Who | Body / query → result |
|---|---|---|---|
| GET | `/directory?q=` | any (drivers get `[]`) | active users except yourself, matched on name or email; drivers included so dispatch can address them |
| GET | `/conversations` | any | inbox: each conversation with last message, unread count, members |
| POST | `/conversations/direct` | operator+ | `{ userId }` → **201 created / 200 existing** (idempotent via `directKey`); self → 400; unknown, inactive or otherwise ineligible target → uniform 404 |
| POST | `/conversations/spaces` | operator+ | `{ name (1–120), description? (≤500), userIds? (≤50) }` → 201; creator is `OWNER` |
| GET | `/conversations/:id` | member | conversation DTO |
| PATCH | `/conversations/:id` | member | `{ name?, description? }` — spaces only; DIRECT → 409 |
| GET | `/conversations/:id/messages?limit=&before=\|after=` | member | keyset paging, `limit` 1–100 (default 50), newest first; `before` and `after` are opaque cursors and mutually exclusive → `{ data, meta: { hasMore, nextCursor } }` |
| POST | `/conversations/:id/messages` | member, rate-limited | `{ body (1–4000), clientMessageId (uuid) }` → **201 / 200 replay** of the same `clientMessageId` |
| POST | `/conversations/:id/attachments` | member, rate-limited | multipart field `file` (≤ `CHAT_MAX_FILE_BYTES`, **any type**) + `clientMessageId` + optional `body` → 201 / 200 |
| GET | `/conversations/:id/messages/:messageId/attachment` | member | `{ messageId, name, mime, bytes, isImage, downloadUrl, viewUrl? }` — signed links, `viewUrl` only when magic bytes say PNG/JPEG/WebP |
| POST | `/conversations/:id/members` | operator+, member | `{ userIds (1–50) }` — spaces only (409 on DIRECT); re-adding is a no-op; drivers refused |
| DELETE | `/conversations/:id/members/:userId` | member | spaces only |
| POST | `/conversations/:id/leave` | member | spaces only |
| POST | `/conversations/:id/read` | member | `{ lastMessageId }` → `{ lastReadAt }`; the marker only ever moves forward |

DTOs: **Conversation** `{ id, type: 'DIRECT' | 'SPACE', name (computed for DIRECT from the
counterpart), description, counterpart (DIRECT only), memberCount, members: [{ userId, role, joinedAt,
user }], createdById, lastMessageAt, createdAt, updatedAt }`. **Message** `{ id, conversationId,
senderId, type, body, clientMessageId, createdAt, attachment: { name, mime, bytes, isImage } | null }`
— never a storage path. **Participant** `{ id, name, email, role }` only.

Attachments: uploaded **before** the message row is written (so a row can never point at a file that was
not stored), to the private `chat-attachments` bucket at `{conversationId}/{randomUUID}`; the original
filename is stored on the row, sanitised, and never used in the path. Download links set
`Content-Disposition: attachment`; only sniffed images get an inline `viewUrl`.

Rate limit (`chat.rateLimit.ts`): in-memory token bucket per user, burst 20, refill 2 per second, 429
`TOO_MANY_REQUESTS`. It exists to stop one buggy tab flooding Realtime; replace it with a shared store
before running more than one process.

Realtime: the service does nothing; a Postgres trigger fans each new message out to every member's
personal topic `chat:<userId>:inbox` as `chat.message.created`, and membership changes as
`chat.membership.changed`. The broadcast payload is built in `prisma/sql/chat.sql` and **must stay
structurally identical to the Message DTO**. Delivery is best-effort; the client reconciles with
`GET /messages?after=` on subscribe, reconnect and tab focus.

---

### 4.12 Clients — `/clients`

The companies whose parcels move. Admin-managed. The code prefixes every order number the client is
ever given, and the default pickup address is what the console copies into a consignment's **sender**
snapshot when an operator picks the client.

| Method | Path | Who | Body / query | Notes |
|---|---|---|---|---|
| GET | `/` | operator+ | `?includeInactive=true` to include retired | ordered by name |
| GET | `/:id` | operator+ | | 404 if unknown |
| POST | `/` | admin | `{ name (1–120), code (2–6 alphanumeric), address? }` | 201; name and code unique case-insensitively → 409; the code is upper-cased |
| PATCH | `/:id` | admin | `{ name?, code?, active?, address? }` (at least one) | **409 on a code change once the client has orders** |
| DELETE | `/:id` | admin | | 204; **409 if any order references it** ("deactivate it instead") |

DTO: `{ id, name, code, active, address, usageCount, createdAt, updatedAt }`. `usageCount` is the
number of consignments referencing the client; the console offers Delete only at zero.

**The code is frozen once the client has orders.** It is stamped into every order number already
issued and into `order_counters`, so changing it would leave `DRZ-20260813-0001` belonging to a client
now called something else. Renaming stays free at any time.

**The address is a value object, replaced wholesale.** Sending `address` sets all ten columns,
`address: null` clears them, and omitting the key leaves them alone — there is no field-by-field
merge, which is what stops a sequence of individually valid PATCHes from adding up to an address with
no coordinates. Inside the object `line1`, `city`, `lat` and `lng` are **required**, so a half-filled
address is unrepresentable rather than merely discouraged. `contactName`, `phone`, `email`, `province`
(a two-letter code), `postcode` (normalised to `A1A 1A1`) and `instructions` are optional. The DTO
returns `address: null` until the row is complete enough to prefill an order and route it.

`GET /api/reference` carries the same `address` on each client, so the consignment form prefills the
sender without a second request.

## 5. Data model

`prisma/schema.prisma` (Prisma 7, driver adapter). Table names are the `@@map` values.

| Table | Purpose | Notable columns and rules |
|---|---|---|
| `clients` | who owns the parcels | `name` and `code` unique; `code` prefixes order numbers; `active`; a nullable default pickup address (contact, `line1`, `city`, `province`, `postcode`, `lat`/`lng`, `instructions`) copied into an order's sender snapshot |
| `service_levels` | admin-managed carriage types | `name` unique; `active`; `sortOrder`; index `(active, sortOrder)` |
| `drivers` | the roster | `active`, `onShift`, `shiftStartedAt`, `shiftEndedAt`, `mapColorIndex` (0–7, not unique); at most one `users` row |
| `users` | profile for a Supabase login | `id` **is** `auth.users.id`; `email` unique; `role`; `active`; `driverId` unique |
| `consignments` | the job | snapshots of sender and receiver (never references); `orderNo` unique; `(clientId, clientReference)` unique; `serviceLevelId` FK **Restrict**; `clientId`/`driverId` FK **Restrict**; four NOT NULL windows; `assignedAt`/`pickedUpAt`/`deliveredAt`; indexes on `(clientId,status)`, `(driverId,status)`, `serviceLevelId`, `status`, `createdAt`, `deliverBefore` |
| `items` | lines on a job | `barcode` (the "Reference"), `description`, `qty`, `weightLb` Decimal(10,3), `lengthIn`/`widthIn`/`heightIn` Decimal(8,2); **no cubic column** |
| `proofs_of_delivery` | photo + signature per leg | `(consignmentId, leg)` unique; file paths, mimes, byte counts; `signedByName`; `capturedByDriverId` (SetNull), `capturedByUserId`, `idempotencyKey`, `replacedAt` |
| `tracking_events` | audit trail | `fromStatus?` → `toStatus`, `driverId` (SetNull), `actorUserId`, `actorEmail` (plain columns so history survives account deletion), `note`, `recordedAt` |
| `order_counters` | order-number sequence | PK `(clientId, dateKey)`, `lastSeq`; one atomic upsert per create |
| `driver_locations` | GPS history, append-only | significant movement only; `consignmentId` FK SetNull; indexes `(driverId, recordedAt)`, `recordedAt`; pruned after 7 days |
| `driver_positions` | live position, one row per driver | PK `driverId`, overwritten forever; `consignmentId` has **no FK** on purpose (a stale job id is better than losing the position); `recordedAt` is device time |
| `chat_conversations` | DM or space | `type`; `directKey` unique for DIRECT (sorted member ids), NULL for spaces; `lastMessageAt` |
| `chat_members` | membership + read state | PK `(conversationId, userId)`; `role` OWNER \| MEMBER; `lastReadAt` |
| `chat_messages` | messages | `senderId` is a plain column (history survives deletion); `type` TEXT \| SYSTEM; attachment columns; `attachmentIsImage` set only by magic bytes; `(conversationId, clientMessageId)` unique; `deletedAt` exists for future use, no delete endpoint yet |
| `routes` | a plan per driver | `status` ACTIVE \| SUPERSEDED (partial unique index: one ACTIVE per driver); `version` for optimistic locking; start/end coordinates and labels; `sequenceSource`; `plannedDistanceM`/`plannedDurationS` (cosmetic, recomputed); `(driverId, clientKey)` unique |
| `route_stops` | one stop | `seq` ≥ 1, unique per route **DEFERRABLE**; `plannedLat`/`plannedLng` snapshot for detecting moved addresses; `(routeId, consignmentId)` unique |

Enums: `ConsignmentStatus` (8), `PodLeg` PICKUP \| DELIVERY, `Priority` NORMAL \| HIGH \| LOW,
`TaskType` DELIVERY \| PICKUP \| PICKUP_AND_DELIVERY (the last is what a job actually is; the first two
survive because enum values cannot be removed), `UserRole` driver \| operator \| admin,
`ChatConversationType`, `ChatMemberRole`, `ChatMessageType`, `RouteStatus`, `SequenceSource`.

### Invariants the database enforces (`prisma/sql/constraints.sql`)

| Constraint | Rule |
|---|---|
| `consignments_driver_status_agree` | `("driverId" IS NULL) = (status = 'UNASSIGNED')` |
| `consignments_pickup_window_ordered` | `pickupBefore ≥ pickupAfter` |
| `consignments_deliver_window_ordered` | `deliverBefore ≥ deliverAfter` |
| `consignments_windows_sequential` | `deliverBefore ≥ pickupAfter` |
| `items_qty_positive` | `qty ≥ 1` |
| `items_weight_non_negative` | `weightLb IS NULL OR weightLb ≥ 0` |
| `items_dimensions_positive` | each of length, width, height is NULL or > 0 |
| `route_stops_seq_positive`, `route_stops_coords_sane`, `routes_start_sane` | seq ≥ 1; coordinates in range and not (0,0) |
| `route_stops_seq_uniq` | `(routeId, seq)` unique, DEFERRABLE INITIALLY DEFERRED |
| `routes_one_active_per_driver` | partial unique index on `driverId WHERE status = 'ACTIVE'` |

Address text has **no** constraint on purpose: the coordinate is what the system routes on.

### Row-level security

Every application table has RLS **enabled with zero policies**, and `anon` / `authenticated` have every
privilege revoked (plus default privileges for future tables). Supabase exposes `public` through
PostgREST with a public key; this is what closes that door. The backend connects as `postgres`, which
bypasses RLS, so it is a no-op for the app. Linter notices about "RLS enabled, no policy" are the intended
state.

The one exception is `realtime.messages`, which has three SELECT policies deciding who may **join** a
topic:

| Topic | Policy | Who |
|---|---|---|
| `chat:<userId>:inbox` | "chat inbox read own" | only that user (`auth.uid()`) |
| `dispatch:tasks` | "dispatch tasks read" | `is_ops_user()` — `public.users` row active and role ≠ driver |
| `dispatch:drivers` | "dispatch drivers read" | `is_ops_user()` |

`is_ops_user()` is `SECURITY DEFINER`, reads `public.users` by `auth.uid()` (not the JWT claim, which is
stale until refresh), and is revoked from PUBLIC. There are no INSERT policies: only triggers publish.

### Realtime triggers (`chat.sql`, `map.sql`, `positions.sql`)

| Trigger | On | Publishes |
|---|---|---|
| `chat_messages_broadcast` | INSERT `chat_messages` | `chat.message.created` with the full Message DTO, to each member's inbox topic |
| `chat_members_broadcast` | INSERT/DELETE `chat_members` | `chat.membership.changed` `{ conversationId, userId, action }` to that user's inbox |
| `map_consignments_ins_del`, `map_consignments_upd` (only when something other than `updatedAt` changed) | `consignments` | `map.task.changed` **`{ id, op: 'upsert' \| 'delete' }`** on `dispatch:tasks` |
| `map_items_changed` | `items` | `map.task.changed` `{ id: consignmentId, op: 'upsert' }` on `dispatch:tasks` |
| `driver_position_changed` | INSERT/UPDATE `driver_positions` | `driver.position` `{ driverId, name, colorIndex, lat, lng, accuracyM, speedMps, headingDeg, recordedAt }` on `dispatch:drivers`; silent for inactive or off-shift drivers |

Why the shapes differ: Realtime computes channel authorization **when a socket joins and caches it for
the socket's life**, so nobody can be promptly revoked from a shared topic. `dispatch:tasks` therefore
carries an invalidation and nothing a demoted operator could read. `dispatch:drivers` carries the whole
position because a refetch per ping (several per second per driver) would be slower than polling; it
must never carry anything about a consignment. Chat uses per-user topics so removal from a conversation
takes effect on the next send. `realtime.send` swallows its own failures with `RAISE WARNING`, so every
client keeps a slow poll underneath.

### Scheduled jobs (pg_cron, `constraints.sql`)

| Job | Schedule | Does |
|---|---|---|
| `prune_driver_locations` | `17 3 * * *` (03:17 daily) | `DELETE FROM driver_locations WHERE recordedAt < now() − 7 days` |
| `reset_driver_shifts` | `0 4 * * *` (04:00 daily) | every on-shift driver: `onShift = false`, `shiftEndedAt = max(recordedAt)` of their pings since `shiftStartedAt`, else `now()`; `shiftStartedAt` untouched |

---

## 6. Two mechanisms that need care

**Order numbers.** `utils/orderNo.ts` does one `INSERT … ON CONFLICT DO UPDATE … RETURNING` on
`order_counters` keyed by `(clientId, YYYYMMDD)`. It is called **before** the insert transaction and never
inside it: the counter row serialises every create for one client on one day, so holding its lock for a
multi-statement transaction over a cross-region connection made concurrent creates queue and blow the
timeout. A failed insert burns a number; gaps are fine because these are identifiers, not a gapless
financial series.

**Proof upload.** Storage first, then one compare-and-swap transaction (§4.6). Deterministic object
paths mean retries overwrite instead of leaving garbage; the price is guessable paths, which is why the
bucket is private and reads are signed URLs only. Both files are validated by magic bytes before any
network call, and a pre-flight read rejects a wrong status before the upload starts.

---

## 7. Configuration

### Environment (`src/config/env.ts`, Zod-validated at import; the process refuses to start on error)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | runtime connection — the **session-mode pooler, port 5432** |
| `DIRECT_URL` | falls back to `DATABASE_URL` | used by the Prisma CLI (`prisma.config.ts`); must not be a transaction pooler |
| `SUPABASE_URL` | required | derives the JWKS URL; Storage endpoint |
| `SUPABASE_SERVICE_ROLE_KEY` | required | server-side only; bypasses every Supabase rule |
| `SUPABASE_STORAGE_BUCKET` | `pod` | proof-of-delivery bucket (private) |
| `CHAT_STORAGE_BUCKET` | `chat-attachments` | separate private bucket for chat files |
| `CHAT_MAX_FILE_BYTES` | `5242880` (5 MB) | keep in sync with the bucket's own limit |
| `CHAT_SIGNED_URL_TTL` | `300` s | chat attachment links |
| `POD_MAX_PHOTO_BYTES` | `10485760` (10 MB) | |
| `POD_MAX_SIGNATURE_BYTES` | `2097152` (2 MB) | |
| `POD_SIGNED_URL_TTL` | `300` s | proof links |
| `LOCATION_RETENTION_DAYS` | `7` | reported in the trail response; the cron job hard-codes 7 |
| `POSITION_LIVE_SECONDS` | `120` | how recent a ping must be to count as live |
| `HISTORY_MIN_MOVE_M` | `15` | metres a driver must move before a ping is kept as history |
| `OSRM_URL` | `http://localhost:5000` | self-hosted routing engine |
| `OSRM_TIMEOUT_MS` | `4000` | short on purpose: a stale ranking is worth less than one that appears |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME` | `operations@innovoxpress.com` / `ChangeMe!123` / `Operations` | the admin the seed creates |
| `PORT` | `4000` | |
| `NODE_ENV` | `development` | `test` opens CORS |
| `CORS_ORIGINS` | `http://localhost:5173` | comma-separated allowlist |

There is **no JWT secret** and no `ALLOW_DRIVER_SELF_SELECT`. `.env.example` is stale (it still lists
`JWT_SECRET` / `JWT_EXPIRES_IN` and lacks the Supabase keys); trust this table.

### npm scripts (`package.json`)

| Script | Does |
|---|---|
| `dev` | `tsx watch src/server.ts` |
| `build` / `start` | `tsc` → `node dist/server.js` |
| `postinstall`, `prisma:generate` | `prisma generate` |
| `db:push` | `prisma db push` — the only schema-apply mechanism; **there is no `prisma/migrations` directory** |
| `db:constraints` (and the identical `db:chat`, `db:map`, `db:positions`, `db:routes`) | `tsx prisma/applyConstraints.ts` — applies `constraints.sql → chat.sql → map.sql → positions.sql → routes.sql` in that order, idempotently, over `pg` |
| `seed` | `tsx prisma/seed.ts` (destructive) |
| `test` / `test:watch` | Vitest, serial (`fileParallelism: false`), 30 s timeouts |
| `prisma:migrate`, `prisma:deploy` | present but unused — the project does not keep migrations |

Runtime dependencies: `@prisma/adapter-pg`, `@prisma/client`, `@supabase/supabase-js`, `bwip-js`,
`cors`, `dotenv`, `express`, `jose`, `multer`, `pdfkit`, `pg`, `zod`. `pdfkit` and `bwip-js` exist only
for `scripts/pdfSpike.ts` (a label + POD sheet renderer for one order; not an endpoint).

**Known schema drift**: the live database has a `users.pushToken` column that `schema.prisma` does not
declare. `prisma db push` warns it would drop it. Do not accept data loss to silence the warning.

---

## 8. File map

```
src/
  server.ts                 listen on PORT; SIGTERM/SIGINT close
  app.ts                    cors → json → /health → routers → notFound → errorHandler
  config/env.ts             Zod env schema (the authoritative variable list)
  config/prisma.ts          PrismaClient over PrismaPg adapter, singleton
  config/supabase.ts        service-role client for Storage; POD_BUCKET, CHAT_BUCKET
  constants/statusFlow.ts   TRANSITIONS, canTransition, MANUAL_STATUS_TARGETS, isEditable
  constants/mapTabs.ts      MAP_TAB_STATUSES partition, tabOfStatus, MAP_COLOR_COUNT
  constants/enums.ts        label maps + asOptions for /api/reference
  middleware/auth.ts        JWKS verify → profile cache → req.user
  middleware/rbac.ts        requireMinRole, requireDriver
  middleware/ownership.ts   allowOperatorOrAssignedDriver (403 for missing and not-yours)
  middleware/validate.ts    Zod for body/query/params; getValidatedQuery
  middleware/upload.ts      multer memoryStorage for photo + signature
  middleware/errorHandler.ts, notFound.ts
  types/auth.ts             AuthUser (req.user), SupabaseClaims
  utils/orderNo.ts          atomic order-number allocation
  utils/imageSniff.ts       PNG/JPEG/WebP by magic bytes
  utils/geo.ts              haversineMetres, plottable (fallback only; OSRM for anything an operator acts on)
  utils/pagination.ts       paginate, buildPageMeta { total, page, pageSize, totalPages }
  utils/httpError.ts        AppError factories; utils/asyncHandler.ts
  schemas/*.schema.ts       every request shape (all .strict())
  modules/<name>/           routes · controller · service · repository (+ chat.guard, chat.rateLimit,
                            chat.storage, chat.upload, pod.storage, routing.osrm, driverWork.service)
prisma/
  schema.prisma             16 models, 10 enums, documented inline
  sql/constraints.sql       CHECKs, RLS lockdown, REVOKEs, two pg_cron jobs
  sql/chat.sql              chat RLS policy, broadcast triggers, chat table lockdown
  sql/map.sql               is_ops_user(), dispatch:tasks policy, invalidation triggers
  sql/positions.sql         dispatch:drivers policy, position broadcast trigger
  sql/routes.sql            route constraints, one-active index, lockdown
  applyConstraints.ts       applies the five files in order
  seed.ts                   destructive rebuild
  seedGta.ts                +200 unassigned Mississauga deliveries (GTA-), --clean
  seedBuildings.ts          +72 orders at 58 real GTA buildings (BLD-), --clean
scripts/pdfSpike.ts         label + POD sheet PDF for one order (spike)
tests/                      18 Vitest files; helpers/api.ts, factory.ts, files.ts
```

---

## 9. Running it from a fresh clone

Prerequisites: Node 22+, a Supabase project (or the team's), optionally a local OSRM serving an Ontario
extract.

1. `cd backend && npm install` (runs `prisma generate`).
2. Create `.env` from the table in §7. Copy both connection strings from Supabase → Connect → ORMs →
   Prisma; use the **session pooler (:5432)** for both. URL-encode `@` as `%40` and `#` as `%23`. Never
   use `db.<ref>.supabase.co` (IPv6-only; hangs on Windows).
3. In Supabase, switch JWT signing to **ES256** (Settings → JWT Keys). Verify with
   `curl $SUPABASE_URL/auth/v1/.well-known/jwks.json` — an empty `keys` array means still HS256, and
   every request will be a 401.
4. Create two **private** Storage buckets: `pod` (10 MB, image/jpeg, image/png, image/webp) and
   `chat-attachments` (5 MB, any type).
5. On your **own** project only: `npm run db:push`, then `npm run db:constraints` (**do not skip it** —
   it enables RLS; without it PostgREST publishes every table), then `npm run seed`. On the team
   project all three are already done; skip them.
6. `npm run dev` → `GET http://localhost:4000/health` → `{ "status": "ok" }`.
7. Sign in against **Supabase**, not this API: `POST {SUPABASE_URL}/auth/v1/token?grant_type=password`
   with the `apikey` header set to the publishable key and `{ email, password }`. Use the returned
   `access_token` as the Bearer token. Seeded logins: the admin from `SEED_ADMIN_*`; drivers are
   `<first>.<last>@innovoxpress.com` / `Driver!123`.

Working as a team: the database is shared. `npm run seed` rebuilds the world and deletes everyone's auth
users. `npm test` truncates operational tables before every test and creates and deletes real auth
accounts. Use a scratch project (`.env.test`) for either.

---

## 10. Seeds

| Script | Destructive? | Creates |
|---|---|---|
| `npm run seed` | **yes** — wipes storage, every operational table, `service_levels`, and every auth user | 3 clients (DRZ, APX, TCS), each with a default pickup address in the GTA; 13 service levels in dropdown order; 8 drivers with logins, 6 on shift and 2 off with a closed shift from yesterday, each with a `mapColorIndex`; 1 admin; 9 GTA consignments (3 per client) in `UNASSIGNED` / `ASSIGNED` only, with items and tracking events |
| `npx tsx prisma/seedGta.ts [--clean]` | no — additive, `GTA-` prefix, re-run replaces the batch | 200 unassigned deliveries within 2.5 km of Airport Corporate Centre, Mississauga, across 8 real FSAs, deterministic scatter, one day's windows |
| `npx tsx prisma/seedBuildings.ts [--clean]` | no — additive, `BLD-` prefix, re-run replaces the batch | 72 orders at 58 real buildings geocoded to the building (14 used twice for stacked pins); all three clients with their own hub; a quarter pickups; a third assigned across 4 drivers, some en route; every order has a service level, items with dimensions, and history |

Both additive seeds need `npm run seed` to have run (clients, drivers, admin, service levels).
`npm run seed` deletes both batches. Higher lifecycle states are never seeded because they would produce
delivered orders with no proof.

---

## 11. Tests

18 Vitest files under `tests/`, run serially against one database (`vitest.config.ts`,
`fileParallelism: false`). Counted by `it(` blocks on disk:

| File | Cases | Covers |
|---|---|---|
| `statusFlow` | 7 | pure: every edge and gate; POD states unreachable manually |
| `orderNo` | 3 | concurrent creates get distinct numbers |
| `consignments` | 25 | create/list/update rules, items diff, cubic and totals, references, strict bodies |
| `assignment` | 18 | assign/swap/unassign, on-shift 409, driver–status invariant, bulk partial success |
| `serviceLevels` | 10 | list/permissions, uniqueness, delete vs deactivate, link to orders |
| `clients` | 8 | permissions, code and postcode normalisation, address as a value object, code frozen by orders, delete vs deactivate, prefill on `/reference` |
| `pod` | 18 | real Storage, signed URLs, magic bytes, idempotent replay, admin replace |
| `drivers` | 22 | roster, my consignments + nextAction, shift rules, ownership 403s |
| `locations` | 22 | ping batching, live vs history, windows, trail |
| `map` · `mapRealtime` | 18 · 12 | pins, counts, filters; who may join `dispatch:*` topics |
| `nearestDrivers` · `driverRoute` | 15 · 14 | written to pass **with or without OSRM**; degraded behaviour asserted |
| `routes` | 32 | create, one-active, reorder as permutation, version conflicts, optimise as preview |
| `chat` · `chatAttachments` · `chatRealtime` · `chatRls` | 36 · 18 · 10 · 8 | rules, uploads, broadcasts, topic policies |
| `auth` | 8 | token and profile handling |

Run them rather than trusting the numbers. `tests/helpers/api.ts` creates real Supabase logins at
`@test.innovoxpress.local` (`seedReference` upserts clients `TCA`/`TCB`, drivers `test-driver-1`/`b`
clocked on, service level `Test Expedite`, and an admin), `cleanConsignments` truncates child-first
including `driver_positions` and `order_counters`, and `cleanChat` also clears `realtime.messages`.
Sign-in must use a fresh client per call: signing in on the shared service-role client would swap its
credentials for the user's and break every later Storage upload.

---

## 12. Expected failures — the rules as status codes

| Do this | Get |
|---|---|
| `PATCH /status` with `DELIVERED` or `PICKED_UP` | 400 |
| `POST /consignments` with a `status` or `orderNo` field | 400 (strict body) |
| `POST /consignments` with `items: []`, or `PUT` with `items: []` | 400 |
| `PUT /consignments/:id` once past `ASSIGNED` | 409 |
| Same `clientReference` twice for one client | 409 |
| Assign an off-shift driver | 409 |
| Assign the same driver again, or assign past `ASSIGNED` | 409 |
| Upload proof while `ASSIGNED` (not yet at the address) | 409 |
| Upload a PDF renamed `.png` | 400 (magic bytes) |
| Upload the same leg twice without the same `Idempotency-Key` | 409 |
| Driver token on `GET /consignments` | 403 |
| Driver token on another driver's order, or on a nonexistent id | 403 (never 404) |
| Operator token on `POST /users` | 403 |
| Delete a driver with any consignment or proof | 409 |
| Delete a service level in use | 409 |
| Demote or deactivate yourself, or the last active admin | 400 |
| Create a planned route while OSRM is down | 503 |
| Reorder a route with a stale `version` | 409 |
| Reorder with a stop added or missing | 400 |
| Driver opens a chat conversation | 403 |
| Add a driver to a space | 404 (uniform, no role leak) |
| 21st chat message within a second | 429 |
| Unknown key in any JSON body | 400 |

---

## 13. Deliberate omissions

No `CANCELLED` / `FAILED` status. No order delete. No money or pricing columns. No server-side
geocoding (the console captures coordinates from TomTom or a dragged pin). No push notifications. No
chat message edit or delete endpoints (the `deletedAt` column is ready for it). No storage reaper for
orphaned objects beyond the best-effort cleanup on failed uploads. One process only for the chat rate
limiter.
