# CLAUDE.md — Innovo Xpress TMS backend

> This file is the orientation. It is written for an AI agent that has to work on the backend without
> having seen it before. Read it top to bottom once; after that, **`backend/README.md`** is the exhaustive
> reference (every endpoint, every request and response shape, every rule, every file).
>
> Both files describe the code as it is on disk today. When code and doc disagree, the code wins — fix the
> doc in the same change.

---

## 1. What this is

An order-management system for **Innovo Xpress**, a courier company. It follows one **consignment** (a
job: collect from a sender, deliver to a receiver) from a dispatcher logging it to a driver proving it was
delivered with a photo and a signature.

- **Clients** are the companies whose parcels are moved. Three are seeded: **Daraz, Apple Express, TCS**.
  Every order belongs to exactly one client, and the client's short code prefixes the order number.
- **Drivers** are the couriers. About eight in the seed. Each has a phone login.
- **Geography is Canadian.** Addresses are Canadian (two-letter province, `A1A 1A1` postcodes), weights are
  in pounds, dimensions in inches, and every seed places orders in the Greater Toronto Area. Some people
  and client names in the seed are Pakistani, which is where the product started; nothing in the code
  depends on that any more.

**Two callers share one API, and that shapes most design decisions:**

- **The dispatcher console** (`frontend/innovo-frontend`) — operators and admins who see and act on every
  order.
- **The driver app** (`frontend/test_react_mob_app`) — a driver on a phone who may see and touch **only
  their own jobs**.

---

## 2. What is built

Everything below is real and shipped. Nothing here is a plan.

| Area | What exists |
|---|---|
| Orders | Create, list, read, edit (while not yet moving), change client, change service level, keyed item editing |
| Assignment | Assign, swap, unassign, bulk assign with partial success; off-shift drivers refused |
| Lifecycle | Eight states, forward only; the two "goods changed hands" states reachable only by uploading proof |
| Proof of delivery | Photo + signature per leg, magic-byte checked, in private Supabase Storage, idempotent retries, admin replace |
| Drivers | Roster with live load, clock on/off with shift window, nightly auto clock-off at the last GPS ping |
| GPS | Batched pings; live position table + significant-movement history; 7-day retention |
| Dispatch map | One `/pins` call feeding map + sidebar + counts; driver roster with colours; Realtime invalidations |
| Routing | Nearest drivers by drive time (OSRM, straight-line fallback), road line driver → pickup |
| Planned routes | One active plan per driver; sequence stored, line regenerated; reorder with optimistic locking; optimise preview |
| Chat | Direct messages and spaces, attachments, keyset paging, read markers, per-user Realtime inbox, rate limit |
| Users | Admin-only accounts on Supabase Auth; driver accounts linked to roster rows |
| Service levels | Admin-managed list ("5 Ton Truck", "Expedite" …) referenced by orders |
| Clients | Admin-managed list; a default pickup address that prefills an order’s sender |
| Reference | One call that fills every console dropdown |

Not built, on purpose: no `CANCELLED` or `FAILED` status, no order delete, no money or pricing columns,
no server-side geocoding, no push notifications. The frontend's finance pages run on in-memory fixtures.

There is also a **print spike**, `scripts/pdfSpike.ts`, that renders a label + proof-of-delivery sheet
for one order with `pdfkit` and `bwip-js`. It is a script, not an endpoint.

---

## 3. Stack and runtime dependencies

**Backend**: Node 22 · TypeScript (ES modules, `"type": "module"`) · Express 5 · Prisma 7 with the
`@prisma/adapter-pg` driver adapter (there is no `url` in `schema.prisma`; the connection comes from
`prisma.config.ts` and `src/config/env.ts`) · Zod 4 · `jose` for token verification · `multer` for
uploads · `@supabase/supabase-js` for Storage and the Auth admin API · Vitest + Supertest.

**Supabase is used as four things**: Postgres, Storage (two private buckets, `pod` and
`chat-attachments`), Auth (issues every token; this API only verifies), and Realtime (broadcast from
database triggers). It is **not** used as PostgREST and **not** used for row-level authorization of
application data — that lives in Express.

**OSRM** is a self-hosted routing engine at `OSRM_URL` (default `http://localhost:5000`). It must serve an
extract that covers the Greater Toronto Area. When it is unreachable every routing feature **degrades and
says so** rather than failing, except creating a planned route, which returns 503 because there is no
honest order to save.

**No migrations directory.** Schema changes are `npm run db:push` (Prisma) followed by
`npm run db:constraints`, which applies the hand-written SQL in `prisma/sql/` in a fixed order. See §7.

---

## 4. The lifecycle — read this before touching status code

```
UNASSIGNED ──assign──► ASSIGNED ──manual──► EN_ROUTE_TO_PICKUP ──manual──► AT_PICKUP
                                                                              │ PROOF
                                                                              ▼
DELIVERED ◄──PROOF── AT_DELIVERY ◄──manual── EN_ROUTE_TO_DELIVERY ◄──manual── PICKED_UP
```

Eight states, forward only. `src/constants/statusFlow.ts` is the single definition: every edge declares
**which mechanism** may traverse it — `ASSIGNMENT` (attach or detach a driver), `MANUAL` (the four
travelling/arrived steps), or `POD` (uploading proof).

- `PATCH /api/consignments/:id/status` accepts only the four manual targets. The Zod schema rejects
  `PICKED_UP` and `DELIVERED` outright, and the service checks the gate again.
- `PICKED_UP` and `DELIVERED` happen only inside the proof-upload transaction, so the status and the
  stored proof can never disagree.
- An order is **editable** only while `UNASSIGNED` or `ASSIGNED`. Once it has physically moved it is
  operational history and `PUT` returns 409.
- A database CHECK enforces `driverId IS NULL` **if and only if** `status = 'UNASSIGNED'`. "Assigned with
  no driver" and "unassigned with a driver" are unrepresentable.

---

## 5. Authorization — three distinct layers

Confusing these is the usual source of security bugs here.

1. **`authenticate`** (`src/middleware/auth.ts`) — is the token genuine? Supabase Auth issues every token
   (ES256). This backend verifies the signature locally with `jose` against the project's JWKS
   (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`), checks issuer and audience, then loads our
   `public.users` profile row and caches it for **30 seconds**. `req.user` is `{ id, email, role, active,
   driverId }`. A JWKS fetch failure is a **503**, not a 401, so an outage is not mistaken for a bad token.
2. **`requireMinRole`** (`src/middleware/rbac.ts`) — what kind of caller? Ranked `driver 0 < operator 1
   < admin 2`. `requireDriver` additionally demands a linked `driverId`.
3. **`allowOperatorOrAssignedDriver`** (`src/middleware/ownership.ts`) — is this record yours? Operators
   pass through; a driver must be the assigned driver. Returns **403 for both "not yours" and "does not
   exist"**, so a driver cannot probe which order ids are real. Chat has the same idea in
   `requireConversationMember`: membership, not role, and 403 for both cases, with no admin bypass.

### The `role` claim is not our role
Supabase's top-level `role` claim is always `anon` / `authenticated` / `service_role`. It is the
**Postgres role used for RLS**. Our role lives in `app_metadata.role`, mirrored from `users.role` by
the users service, and the middleware reads it from our profile row, never from the token.

### Identity model
`auth.users` (GoTrue) owns credentials; never write to it directly, only through the Supabase admin API
in `users.service`. `public.users` is a **profile** keyed by the same uuid holding `role`, `active` and
`driverId`. A driver row can have at most one login (`users.driverId` is unique).

### The driver lifecycle — three separate states
- `active` — employment, admin-set. Deactivating also clocks the driver off.
- `onShift` — clocked in, driver-set from the phone. `shiftStartedAt` / `shiftEndedAt` are the window of
  the current or last shift; `shiftEndedAt` is null exactly while a shift is open. A pg_cron job at
  **04:00** clocks everyone off and stamps `shiftEndedAt` at their **last GPS ping**, not at 04:00.
- Having a login — admin-set, once.

**Assignment refuses an off-shift driver with a 409** (`assignDriver`, bulk assign, route creation). The
console greying them out is presentation; the service is the enforcement. **Removing a driver means
deactivating**: `DELETE /api/users/drivers/:id` is a 409 once they have any consignment or proof.

---

## 6. Backend architecture

**Modular monolith.** One process, one database, feature modules with real boundaries.

```
routes → controller → service → repository → Prisma
```

- **No service imports `prisma`.** Every database call goes through a repository. Verify with
  `grep -r "config/prisma" backend/src/modules/*/*.service.ts` — it must print nothing.
- Routes wire middleware; controllers only read the request and send the response; services hold every
  rule; repositories hold every query.

**Modules** (`src/modules/`): `auth · chat · clients · consignments · drivers · locations · map · pod · reference
· routes · routing · serviceLevels · users`.

- **`routing`** owns the OSRM client (`routing.osrm.ts`) and nothing else talks to OSRM directly except
  `routes`, which imports that client. Its two endpoints live under `/api/consignments/:id/...` because the
  question is about an order.
- **`routes`** owns planned runs at `/api/routes`.
- **`pod`** is mounted under `/api/consignments/:id/pod` with `mergeParams`.
- **`locations`** has no routes file; its handlers are mounted by `drivers.routes.ts`.

Cross-module imports that exist and are tolerated: `locations.service → drivers.repository`,
`routes.service → routing.osrm`, `users.service → map.service` (for `nextColorIndex`),
`consignments.repository` has its own `findDriverById`. Do not add more.

**Request pipeline** (`src/app.ts`): CORS allowlist from `CORS_ORIGINS` (open in test) → JSON body limit
1 MB → `GET /health` (runs `SELECT 1`) → the nine routers → `notFound` → `errorHandler`. Every error leaves
as `{ error: { code, message, details? } }`. Zod failures are 400 with `fieldErrors`; multer size limits
are 413; Prisma unique violations are 409, missing rows 404, FK failures 400; anything unknown is 500 and
logged.

**All Zod request bodies are `.strict()`** — an unknown key is a 400, by design. Server-owned fields
(`orderNo`, `status`) are therefore rejected rather than silently ignored.

---

## 7. Data rules everything depends on

- **Order numbers** are `{CLIENTCODE}-{YYYYMMDD}-{0001}`, allocated by one atomic upsert on
  `order_counters` **before and outside** the insert transaction. Holding that lock for a whole
  transaction made concurrent creates queue and time out. A failed insert burns a number; gaps are fine.
- **Client references** (`clientReference`) are the client's own tracking id, unique **within** a client.
- **Items** carry `barcode` (shown as "Reference"), `description`, `qty`, `weightLb` (the **whole line**
  in pounds, as typed, never multiplied by qty), and `lengthIn` / `widthIn` / `heightIn`. **Cubic is
  derived on every read** (L×W×H cubic inches ÷ 61,023.744, four decimals) and never stored. There is no
  package type. Editing items is a **keyed diff**: an item with an id is updated, without an id is created,
  and any existing id not in the list is deleted. An id from another order is a 400.
- **Service levels** are a table, not an enum, so admins add levels without a deploy. Orders reference a
  row by id and the API returns `serviceLevel: { id, name } | null`. A level in use cannot be deleted
  (FK Restrict and a 409 saying to deactivate it); retired levels leave the dropdown but old orders keep
  their history.
- **Addresses are snapshots** on the consignment, not references, so editing a client's address never
  rewrites dispatched history. Coordinates are captured by the console's TomTom picker and are nullable.
  **No address text is validated** beyond length: the coordinate is what the system routes on.
- **Live position vs history.** `driver_positions` holds one row per driver, overwritten forever, and is
  what "where is the driver now" reads. `driver_locations` is append-only and keeps a ping only when the
  driver moved at least `HISTORY_MIN_MOVE_M` (15 m) from the last kept point. Answering both questions
  from one table made liveness depend on movement: a parked courier vanished from the map.
- **A planned route is a plan.** It records an intended visiting order and gates nothing. The
  **sequence is stored; the line never is** — geometry comes from OSRM on every read. **The computer
  suggests, the operator decides**: optimise is a preview until the operator saves the order.
- **Realtime is an invalidation, never data.** `dispatch:tasks` carries `{ id, op }` only. Realtime caches
  channel authorization for the life of a socket, so nothing worth stealing may ever ride a shared topic.
  The one exception is `dispatch:drivers`, which carries the full position because a refetch per ping
  would be slower than polling; it never carries anything about a consignment. Chat uses per-user topics
  `chat:<userId>:inbox` for exactly this reason. Broadcast is best-effort (`realtime.send` swallows
  failures), so every client keeps a slow poll underneath.
- **Proof upload is storage first, then one transaction** (compare-and-swap the status, insert the proof
  row, write the tracking event). Never reorder: row-first would allow `DELIVERED` with no proof file.

---

## 8. Things that will bite you

- **`npm test` wipes the database it runs against and deletes Supabase Auth accounts.** The helpers
  create real logins at `@test.innovoxpress.local`. This is a shared team database. Point tests at a
  scratch project (`.env.test`) before running the whole suite; run single files with care.
- **`npm run seed` is destructive.** It truncates every operational table, empties the `pod` bucket,
  deletes every auth user, then rebuilds: 3 clients (each with a default pickup address), 13 service levels, 8 drivers with logins (6 on
  shift, 2 off with a closed shift from yesterday), 1 admin from `SEED_ADMIN_*`, 9 GTA consignments in
  `UNASSIGNED`/`ASSIGNED` only (seeding later states would create delivered orders with no proof).
- **Two additive seeds** for load and demo testing, each removable with `--clean` and safe to re-run:
  `prisma/seedGta.ts` (200 unassigned deliveries around Mississauga, `GTA-` prefix) and
  `prisma/seedBuildings.ts` (72 orders at 58 real GTA buildings geocoded to the building, `BLD-` prefix,
  with pickups, assignments and service levels). `npm run seed` deletes both.
- **SQL files run in a fixed order** via `prisma/applyConstraints.ts`: `constraints.sql → chat.sql →
  map.sql → positions.sql → routes.sql`. `constraints.sql` revokes across the whole schema, and
  `positions.sql` calls `is_ops_user()` which `map.sql` creates. The `db:chat`, `db:map`, `db:positions`
  and `db:routes` npm scripts all run the same applier.
- **Schema drift you will see:** the live database has a `users.pushToken` column that `schema.prisma`
  does not declare. `prisma db push` warns it would drop it. Do not pass `--accept-data-loss` to make the
  warning go away; either add the column to the schema or leave it.
- **`.env.example` is stale.** It still lists `JWT_SECRET` / `JWT_EXPIRES_IN` and lacks `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` and the rest. The authoritative list is the Zod schema in
  `src/config/env.ts` (reproduced in README §8).
- **Supabase connection**: use the **session-mode pooler** (`:5432`), never the transaction pooler
  (`:6543`) — Prisma's advisory lock breaks. Never `db.<ref>.supabase.co` (IPv6-only, hangs on Windows).
  URL-encode `@` in passwords as `%40`. `prisma.config.ts` uses `DIRECT_URL` first for CLI work.
- **RLS is enabled with no policies on every application table, deliberately.** Supabase publishes
  `public` tables through PostgREST with a public key; this locks that door. The backend connects as
  `postgres`, which bypasses RLS. The only policies are three SELECT policies on `realtime.messages`
  (chat inbox, dispatch tasks, dispatch drivers). Linter notices about "RLS enabled, no policy" are the
  intended state.
- **Both storage buckets must stay private.** POD object paths are deterministic and guessable; chat
  paths are random. Reads go through short-lived signed URLs minted by the API.
- **Never trust `Content-Type` on uploads** — magic bytes decide (`utils/imageSniff.ts`): PNG, JPEG, WebP.
- **OSRM speaks `lon,lat`; Leaflet wants `lat,lng`.** The flip happens once, in `routing.osrm.ts`.
  Swapping coordinates does not error; it routes you into the ocean and returns plausible numbers.
- **`weightLb` and the three dimensions are Prisma `Decimal`.** They serialise as strings from raw
  selects and numbers from the mapped DTOs. Coerce.
- **`curl` from Git Bash on Windows cannot upload `/tmp/...` paths** — use a Windows path.
- **Give people their own account.** A shared login makes the audit trail useless: every tracking event
  records the actor.

---

## 9. Things that no longer exist — do not look for them

- `POST /api/auth/login`, `JWT_SECRET`, bcrypt, any password check in this API. Supabase Auth owns all of
  it. `src/schemas/auth.schema.ts` still defines an unused `loginSchema`.
- `/api/drivers/roster`, `/api/drivers/session`, `ALLOW_DRIVER_SELF_SELECT` (the password-free driver
  sign-in). `super_admin` role.
- `prisma/seedNust.ts` and the `NST-` prefix (replaced by `seedGta.ts`).
- Photon geocoding (the console uses TomTom Search). `senderArea` / `receiverArea` (now `senderProvince`
  / `receiverProvince`).
- `weightKg`, `packageType`, the `PackageType` enum, `packageTypes` in `/api/reference`.
- The rule that an order's client cannot change after creation. `PUT` accepts `clientId` now; the order
  number keeps its original prefix.
- "Chat excludes drivers." Drivers can be **messaged** in a direct thread and reply in threads they are
  in; they cannot start conversations, and spaces are staff-only to create and to join.

---

## 10. Frontend notes (brief — the backend is the focus here)

- The console runs on the real API through `src/lib/api.ts` + `src/domain/mappers.ts`; `TasksProvider`
  is a thin TanStack Query adapter. `src/domain/` is framework-free.
- Sign-in is real: `AuthProvider` renders the login screen instead of its children when there is no
  session. `api.ts` only verifies; a 401 triggers one `refreshSession()` then signs out.
- Address entry is a modal picker on **TomTom Search** with a draggable pin; both ends must be pinned.
- Consignment items are real and match the API exactly. Fields with no backend column (COD, delivery
  fee, crew, handling, additional services, suite/floor) stay on screen and do not persist.
- Service Levels is the one finance-area page on the real API (`/api/service-levels`).
- The dispatch map derives everything from one `/api/map/pins` payload; view rules live in
  `features/map/state/mapView.ts` with no React import.

---

## 11. Reference material

- **`backend/README.md`** — the complete backend reference. Start there for anything server-side.
- `frontend/innovo-frontend/CLAUDE.md` — the console's own guide, including Leaflet traps.
- `docs/db_schema.md`, `docs/sheets/*.csv` — the original sample data the domain was derived from.
  Superseded; the schema has moved on.
- `extras/master.md` — the "Iris" frontend design system.

---

## 12. STRICT AGENT RULES (non-negotiable — apply every session)

- **ALWAYS use subagents (`haiku-file-explorer` / `Explore`) to read and explore files. The main agent must
  NEVER read files directly.**
- **Every subagent prompt MUST state explicitly that it may read AT MOST 3 files.** This is a hard limit.
- **When several files are needed, launch multiple subagents IN PARALLEL**, splitting the files between
  them — 10 small agents beats 1 large one.
- **Every subagent must return only a concise summary, exact signatures, or verbatim quotes of the specific
  lines requested — never whole files.**
- **The main agent is for designing, planning, reasoning and writing code** — not for reading.
- **Keep the main agent's context uncrowded at all times.**
- **Do not re-explore the schema or architecture if it is already described here or in
  `backend/README.md`.**
- **When building UI:** reuse existing `@/ui` primitives and in-repo patterns first. Invoke the `shadcn`
  skill only to install a missing primitive.
- **Database / Supabase work → load the skills FIRST.** Before any task that touches the database,
  schema, migrations, SQL, indexes, RLS, Supabase Auth/Storage/Edge Functions, or the `mcp__supabase__*`
  tools, invoke the **`supabase`** skill via the Skill tool — and also
  **`supabase-postgres-best-practices`** whenever the work involves schema/DDL, migrations, queries,
  indexes, RLS policies, triggers, pg_cron, or performance diagnosis. Only the skills' one-line
  descriptions are preloaded; their actual guidance is NOT in context until invoked. Load them before
  writing any SQL or calling any Supabase MCP tool, not after.
