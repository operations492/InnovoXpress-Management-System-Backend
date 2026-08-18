# CLAUDE.md — Innovo Xpress TMS

> Reading this file alone should be enough to continue work. For exhaustive backend detail — every
> endpoint, every rule, every file — read **`backend/README.md`**, which is the authoritative guide.
> Keep both current as features land.

---

## 1. What this is

An order-management system for **Innovo Xpress** (operations@innovoxpress.com), a Pakistani courier
company. It follows a consignment from a dispatcher logging it to a driver proving it was delivered.

Three real clients: **Daraz, Apple Express, TCS**. Roughly 8 drivers. Orders move around Lahore, Karachi
and Islamabad.

**Two callers share one API, and this shapes almost every design decision:**

- **The dispatcher console** — operators/admins who see and act on *every* order.
- **The driver app** — a driver on a phone who may see and touch **only their own jobs**. Built, and now
  signing in against Supabase Auth like everyone else.

---

## 2. Current state

| Piece | Status |
|---|---|
| **Backend** | Core features + chat, dispatch map, live positions, OSRM routing and route planning. Live on Supabase. |
| **Dispatcher console** | Consignments · POD · live map · login · Users · **Chat** · **Dispatch map** · **route planning**. |
| **Driver app** | Built (`frontend/test_react_mob_app`), on Supabase Auth, GPS tied to the shift. No test suite. |
| Finance screens | Still on in-memory fixtures, deliberately untouched |

> ⚠️ **`npm test` in `backend/` still wipes the database it runs against and deletes auth users.** Suites
> are run individually against the shared project during development; the whole suite needs a scratch
> project. Counts move as features land — check by running, not by trusting a number written here.

The core features, all built:

1. **Client-scoped order logging** — create/list/read/edit consignments with items
2. **Driver assignment** — assign, swap, unassign, with live load counts
3. **Proof of delivery** — photo + signature at pickup and at delivery, in Supabase Storage
4. **Progression to delivered** — the manual travelling/arrived steps

Added since: **GPS tracking**, **address coordinates**, **Supabase Auth** replacing the home-grown JWT,
and an **admin-only Users area** — then everything in §2a below.

---

## 2a. What was added after the sections below were written

These are real and shipped; the rest of this file predates them and still describes the system correctly
apart from where it is contradicted here.

**Chat** (`/api/chat`, operators and admins only — drivers are excluded by design). Direct messages and
spaces, with file attachments up to 5 MB in a **separate `chat-attachments` bucket** (POD's image-only
whitelist is an evidence rule; chat deliberately takes any type). Delivery is Supabase **Realtime
broadcast-from-database** on a per-user topic `chat:<userId>:inbox`, fanned out by a Postgres trigger.

**Dispatch map** (`/api/map`). `GET /pins` returns every task as a waypoint with facet counts in one
request; `GET /drivers` is the roster. Live changes arrive on the shared `dispatch:tasks` topic as
`{id, op}` — an invalidation, never data. Drivers gained `mapColorIndex` (an index into an 8-colour
palette, not a hex).

**Live positions — the split that fixed a family of bugs.** `driver_positions` holds **one row per
driver, overwritten forever**; `driver_locations` stays append-only and records only significant
movement. "Where is this driver now?" and "where have they been?" are different questions with opposite
write patterns, and answering both from the history table meant liveness depended on whether the driver
*moved* — a courier parked at a warehouse silently vanished from the map. Positions push on
`dispatch:drivers`.

**Shift close time.** `drivers.shiftEndedAt` alongside `shiftStartedAt`; the pair is the last shift's
window. `shiftStartedAt` is no longer cleared on clock-off, and the 04:00 pg_cron job now closes an
abandoned shift at the driver's **last GPS ping** rather than at 04:00, which nobody worked until.

**Off-shift drivers cannot be given work** — `POST /:id/assign` refuses with a 409. Enforcement is in the
service; the console greying them out is presentation.

**OSRM — a new runtime dependency.** A self-hosted routing engine at `OSRM_URL` (default
`http://localhost:5000`), used for driving distances, ETAs and route optimisation. Free, local, and
**not traffic-aware**: durations come from OpenStreetMap speed profiles, so trust the ordering and treat
the clock as optimistic. Measured limits on the current build: `/table` and `/trip` cap at **100
coordinates**, `/route` has no waypoint cap (126 waypoints drew in ~300 ms).

**Routing** (`/api/consignments/:id/nearest-drivers`, `/api/consignments/:id/driver-route`). Ranks
assignable drivers by driving time to an order's pickup in one matrix call, and draws the road line for
whichever driver is selected. Degrades to straight-line distance and says so when OSRM is unreachable.

**Bulk assign and planned routes** (`POST /api/consignments/assign-bulk`, `/api/routes`). A route is a
**plan**: it records an intended visiting order and gates nothing. It touches no existing table, so the
consignment lifecycle behaves exactly as it did before. Two rules carry the design — **the sequence is
stored and the line never is** (geometry is regenerated from OSRM on every read, so there is no cache to
invalidate), and **the computer suggests, the operator decides** (`/trip` picks an order only when asked;
`/route` draws whatever order is saved and reports its honest cost even when that is worse).

---

## 3. Stack

**Backend** (`backend/`) — Node 22 · TypeScript · Express 5 · Prisma 7 (driver adapter, no `url` in
schema) · PostgreSQL + Storage on **Supabase** · Zod 4 · JWT + bcrypt · multer · Vitest + Supertest.

**Frontend** (`frontend/innovo-frontend/`) — Vite · React 19 · TypeScript · Tailwind v4 · shadcn/Radix ·
**TanStack Query** (server state) · TanStack Table · React Hook Form + Zod · React Router 7 · Leaflet.

**Also required at runtime**: a local **OSRM** server (`OSRM_URL`, default `http://localhost:5000`).
Without it, routing endpoints degrade rather than fail — the assign list falls back to straight-line
distance and says so, and a saved route still lists its stops without a drawn line — but route
*creation* returns 503, because there is no honest order to save.

Supabase is used as **Postgres + Storage + Auth + Realtime**. Not PostgREST, and not RLS-based
authorization for application data — that lives in Express. RLS *is* used for one thing: deciding who may
join a Realtime topic (policies on `realtime.messages`).

---

## 4. The lifecycle — read this before touching status code

```
UNASSIGNED ──assign──► ASSIGNED ──manual──► EN_ROUTE_TO_PICKUP ──manual──► AT_PICKUP
                                                                              │ PROOF
                                                                              ▼
DELIVERED ◄──PROOF── AT_DELIVERY ◄──manual── EN_ROUTE_TO_DELIVERY ◄──manual── PICKED_UP
```

Eight states, forward only. Each edge declares **which mechanism** may traverse it —
`ASSIGNMENT`, `MANUAL` or `POD` (`backend/src/constants/statusFlow.ts`).

**`PICKED_UP` and `DELIVERED` cannot be set through `PATCH /status`.** The Zod schema rejects those words.
They happen only when a photo + signature upload succeeds, and that upload changes the status in the *same
transaction* that stores the proof — so the two can never disagree.

**No `CANCELLED`, no `FAILED`** — the user's explicit choice. Adding them later is an append-only enum
change; do not add them unprompted.

---

## 5. Authorization — three distinct layers

Confusing these is the usual source of security bugs here.

1. **`authenticate`** — is the token genuine? **Supabase Auth issues every token; this backend only
   verifies.** Local ES256 verification with `jose` against the project JWKS — no login endpoint, no
   bcrypt, no signing secret here. `req.user` is the verified token *plus our profile row*, cached 30s.
2. **`requireMinRole`** — what *kind* of caller? Ranked `driver 0 < operator 1 < admin 2`. `driver` is a
   real `UserRole` now; `super_admin` is gone.
3. **`allowOperatorOrAssignedDriver`** — is this *record* yours? Role cannot answer that. Operators pass
   through; a driver must own the row. Returns **403 for both "not yours" and "does not exist"**, so a
   driver cannot probe which order ids are real.

### ⚠️ The `role` claim is not our role
Supabase's top-level `role` claim is always `anon`/`authenticated`/`service_role` — it is the **Postgres
role used for RLS**. Ours lives in `app_metadata.role`, mirrored from `users.role`. Putting `admin` in the
top-level claim would break RLS for that user.

### Identity model
`auth.users` (GoTrue, never write directly) owns credentials. `public.users` is a **profile** keyed by the
same uuid, holding `role`, `active` and `driverId`. Admin-only CRUD at `/api/users`.

### The driver lifecycle — three separate states
`onShift` (driver-set, resets nightly at 04:00 via pg_cron) · `active` (admin-set, employment) · having a
login. Assignment offers on-shift drivers only, and now **refuses** anyone else with a 409 rather than
merely hiding them. **Removing a driver means deactivating**: a hard delete is a 409 once they have any
consignment or proof, because it would erase who delivered what.

`shiftStartedAt` + `shiftEndedAt` are the window of the current shift, or of the last one once it closes.
`shiftEndedAt` is null exactly while a shift is open, and is stamped once — by the driver, by an admin
deactivating them, or by the nightly job. Re-tapping a button moves neither timestamp. Only the latest
shift is kept; there is no history table.

The password-free driver sign-in is **gone** — `/drivers/roster`, `/drivers/session` and
`ALLOW_DRIVER_SELF_SELECT` no longer exist.

---

## 6. Backend architecture

**Modular monolith.** One process, one database, feature modules with real boundaries.

```
routes → controller → service → repository → Prisma
```

**No service imports `prisma`** — every database call goes through a repository. Verify with:

```bash
grep -r "config/prisma" backend/src/modules/*/*.service.ts   # must return nothing
```

Modules: `auth · chat · consignments · drivers · locations · map · pod · reference · routes · routing`.

- **`routing`** owns the OSRM client and nothing else touches it. Its two endpoints live under
  `/api/consignments/:id/...` because the question is about an order — the same way tracking sits under
  `/api/drivers`.
- **`routes`** owns planned runs at `/api/routes`, and depends on `routing` for geometry.

Known boundary leaks (harmless, do not spread): `locations.service` imports `drivers.repository`;
`consignments.repository` has its own `findDriverById`.

**Full endpoint list, per-file map and every rule: `backend/README.md`.**

---

## 7. Things that will bite you

- **Running `npm test` in `backend/` wipes the database it runs against** *and now deletes Supabase Auth
  accounts too* — the helpers create real logins. **This is a shared team database.** A stray run removes
  colleagues' accounts, not just their demo orders. Point it at a scratch project before running it;
  `npm run seed` rebuilds the world but not anything created by hand.
- **`npm run seed` is destructive by design.** It truncates every operational table, empties the `pod`
  Storage bucket and deletes every auth user, then rebuilds: 3 clients, 8 drivers *each with a login*
  (**6 on shift, 2 off**, each with a `mapColorIndex`), one admin, 9 consignments with coordinates.
  The off-shift pair are there so "you cannot assign work to someone who went home" can be tried without
  first clocking anyone off from a phone.
- **`prisma/seedNust.ts` is additive, not destructive.** 200 unassigned deliveries around NUST Islamabad
  for load and route testing, all tagged with an `NST-` order-number prefix so the batch can be removed
  again with `npx tsx prisma/seedNust.ts --clean`. `npm run seed` still deletes them along with
  everything else.
- **RLS policies exist now, but only on `realtime.messages`.** Three of them — chat inboxes, the dispatch
  task feed, the driver position feed. Application tables remain RLS-enabled with zero policies. Realtime
  computes channel authorization **when a client joins and caches it for the life of the socket**, so
  nobody can be promptly revoked from a shared topic; that is why `dispatch:tasks` carries `{id, op}` and
  nothing worth stealing.
- **`realtime.send` swallows its own failures** with a `RAISE WARNING`, so delivery is best-effort. Every
  client keeps a slow poll underneath — that is the safety net, not the mechanism.
- **New SQL files run in order** via `prisma/applyConstraints.ts`: `constraints.sql → chat.sql → map.sql
  → positions.sql → routes.sql`. Order matters — `constraints.sql` revokes across the whole schema, and
  `positions.sql` calls `is_ops_user()` which `map.sql` creates.
- **Give people their own account.** `/api/users` and the console's Users screen exist now — a shared
  login makes the audit trail useless, since every tracking event records the same actor.
- **Supabase connection**: use the **session-mode pooler** (`:5432`), never the transaction pooler
  (`:6543`) — Prisma's advisory lock breaks. Never `db.<ref>.supabase.co` (IPv6-only, hangs on Windows).
  URL-encode `@` in passwords as `%40`.
- **RLS is enabled with *no policies* on every table, deliberately.** Supabase publishes `public` tables
  via PostgREST with a public anon key; this locks that door. The linter's "RLS enabled, no policy" INFO
  notices are the intended state. The backend connects as `postgres`, which bypasses RLS.
- **The `pod` bucket must stay private.** Object paths are deterministic and therefore guessable; reads go
  through short-lived signed URLs.
- **Never trust `Content-Type` on uploads** — magic bytes are checked in `utils/imageSniff.ts`.
- **Order numbers are allocated outside the insert transaction** on purpose; moving them inside makes
  concurrent creates queue and time out.
- **`curl` from Git Bash on Windows cannot upload `/tmp/...` paths** — use a Windows path.
- **All Zod request bodies are `.strict()`** — an unknown key is a 400, by design.

---

## 8. Frontend notes (brief — backend is the focus)

- The consignment screen runs on the real API through `src/lib/api.ts` + `src/domain/mappers.ts`;
  `TasksProvider` is a thin TanStack Query adapter keeping its original interface.
- `src/domain/` is framework-free (no React) — types, the status machine, mappers, validation.
- **Sign-in is real.** `AuthProvider` (`src/state/`) renders the login screen *instead of* its children
  when there is no session, so no store ever mounts unauthenticated. It sits above every store in
  `app/providers.tsx` for exactly that reason. `/login` is a render state, not a route — `App.tsx`'s
  `path="*"` catch-all would otherwise swallow it.
- `api.ts` only ever **verifies**: `ensureToken()` reads the Supabase session. A 401 triggers one
  `refreshSession()`, then signs out. The old `VITE_DEV_EMAIL` / `VITE_DEV_PASSWORD` auto-login is gone —
  it put the admin password in the public bundle.
- **Users tab is admin-only**, filtered out of `TopNav` for anyone else. That is presentation; the
  enforcement is the backend's `requireMinRole('admin')`.
- **Address entry is a modal picker** (`AddressAutocomplete.tsx`) — Photon search, a draggable pin, and
  reverse geocoding. Both ends must be pinned before an order saves.
- Fields with no backend column (COD, delivery fee, crew, handling, additional services, suite/floor, item
  Product ID / Order ID / Line Total) stay on screen and simply do not persist. Leave them alone.
- Finance pages are out of scope and still on fixtures.
- `src/test/setup.ts` mocks Supabase and `/api/auth/me` globally — without it every page test would
  assert against the login screen.

### Newer screens

- **`/chat`** — spaces and direct messages, operator+. `ChatProvider` subscribes to the per-user inbox.
- **`/map`** — the dispatch map. One `/api/map/pins` request feeds the map, the sidebar *and* the pin
  widget, so a badge can never disagree with the rows beneath it. The view rules live in
  `features/map/state/mapView.ts`, which imports no React and is unit-tested on its own.
- **Shift-drag on the map** lassoes tasks (`components/map/RectangleSelect.tsx`) — a DOM overlay, not an
  `L.Rectangle`, and it suspends map dragging while shift is held or the map pans out from under the box.
  Selection clears on a tab change, because the pins on screen have changed.
- **The assign picker is side-by-side** for a single order: drive-time ranking on the left, a map of those
  drivers on the right, both from one request. The map is a *pane*, not a stacked modal — Leaflet's panes
  sit at z-index 200–700 and beat Radix's 50, so a dialog opened over a map lands behind it.

### Leaflet traps this codebase has already hit

- **Never initialise a map into a container that has not been measured.** Leaflet derives its pixel origin
  from `getSize()` at init; a zero-width container gives half-painted tiles *and* markers positioned
  off-screen. Correcting the size afterwards does not fix the markers, because `setView` to an unchanged
  centre takes the animated-pan fast path and never fires `viewreset`. Gate on `clientWidth` — not
  `getBoundingClientRect`, which a dialog's entrance transform distorts.
- **After `invalidateSize()`, fire `viewreset`** if layers must reposition.
- **Cache `L.divIcon` objects at module level.** A fresh `icon` prop makes react-leaflet call `setIcon()`,
  which rebuilds the marker's DOM element — with a poll running that rebuilds every marker every tick and
  eats the click the operator was making.
- **jsdom performs no layout**, so `clientWidth` is 0 and the measurement gate above never opens. Tests
  that mount a map shim it deliberately rather than weakening the gate.

---

## 9. Reference material

- **`backend/README.md`** — the complete backend guide. Start here for anything server-side.
- `docs/db_schema.md`, `docs/sheet_structure_snapshot.md`, `docs/sheets/*.csv` — original CSV sample data
  the domain was derived from. **Largely superseded**; the schema has moved on considerably.
- `docs/*.png` — UI reference screenshots.
- `extras/master.md` — the "Iris" frontend design system (tokens, typography, component specs).

---

## 10. STRICT AGENT RULES (non-negotiable — apply every session)

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
