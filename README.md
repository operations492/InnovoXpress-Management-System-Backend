# Innovo Xpress TMS — Backend

The order-management API for **Innovo Xpress**, a Pakistani courier company. It covers the life of a
consignment from the moment a dispatcher logs it to the moment a driver proves it was delivered.

Two very different callers share this API:

- **The dispatcher console** (`frontend/innovo-frontend`) — operators and admins who see every order.
- **The driver app** (not built yet) — a driver on a phone who may see and touch **only their own jobs**.

That split is the single most important thing to understand here. Almost every authorization decision in
the codebase exists because a driver token and an operator token must be treated completely differently.

**Stack:** Node 22 · TypeScript · Express 5 · Prisma 7 (driver adapter) · PostgreSQL, Storage **and Auth**
on Supabase · Zod 4 · `jose` for token verification · Vitest + Supertest.

**Status:** the core features are built, and identity has moved to **Supabase Auth** — this API no longer
issues tokens, it only verifies them.

> ⚠️ **The test suite has not been run since that migration.** Its helpers now create real Supabase
> accounts; they typecheck, but nothing has executed them. `npm test` wipes the shared database *and*
> would delete auth users — point it at a scratch project first. Treat any older "122 passing" claim as
> out of date.

> **Just cloned this?** Jump to **[§8 Running it from a fresh clone](#8-running-it-from-a-fresh-clone)** —
> with the team's `.env` it is three commands. **Then read
> [Working as a team](#working-as-a-team)**: `npm test` wipes the shared database, and that is the one
> mistake worth knowing about before you make it.

---

## 1. The domain in one page

A **consignment** is one courier job: collect from a sender, deliver to a receiver. It belongs to exactly
one **client** (Daraz, Apple Express, TCS), carries one or more **items**, and is worked by one **driver**.

### The lifecycle — 8 states, forward only

```
UNASSIGNED ──assign──► ASSIGNED ──manual──► EN_ROUTE_TO_PICKUP ──manual──► AT_PICKUP
                                                                              │
                                                                            PROOF
                                                                              ▼
DELIVERED ◄──PROOF── AT_DELIVERY ◄──manual── EN_ROUTE_TO_DELIVERY ◄──manual── PICKED_UP
```

Every edge is guarded by **which mechanism** may traverse it — not just which state follows which:

| Gate | Meaning | Used by |
|---|---|---|
| `ASSIGNMENT` | attaching or detaching a driver | `POST/DELETE /:id/assign` |
| `MANUAL` | a person moving the job along | `PATCH /:id/status` |
| `POD` | completed **only** by uploading proof | `POST /:id/pod/:leg` |

**`PICKED_UP` and `DELIVERED` are unreachable through `PATCH /status`.** The schema rejects those words
outright. The only way an order becomes picked up or delivered is by uploading a photo and a signature,
and that upload changes the status **in the same database transaction** as it inserts the proof. Proof and
status therefore can never disagree.

There is deliberately **no `CANCELLED` and no `FAILED`** — the user chose a happy-path-only lifecycle.
Adding them later is an append-only enum change plus new edges in `statusFlow.ts`; nothing else breaks.

### Order identity

Every consignment carries **two** identifiers:

- **`orderNo`** — system-assigned, client-prefixed, e.g. `DRZ-20260815-0001`. Unique across the system.
- **`clientReference`** — the client's own number (a Daraz or TCS tracking id). Optional, and unique only
  *within* a client, so two clients may both use `PO-1001`.

---

## 2. Architecture

A **modular monolith**: one process, one database, one deploy, split internally into feature modules with
real boundaries.

```
routes  →  controller  →  service  →  repository  →  Prisma
```

| Layer | Responsibility | Must not |
|---|---|---|
| `routes` | URL, middleware chain, guards | contain logic |
| `controller` | HTTP ⇄ plain arguments | contain business rules |
| `service` | business rules, orchestration | **import `prisma`** |
| `repository` | every database call | know about HTTP |

**No service imports `prisma`.** That rule is enforceable with one grep and is worth keeping:

```bash
grep -r "config/prisma" src/modules/*/*.service.ts   # must return nothing
```

Modules are `auth`, `consignments`, `drivers`, `locations`, `pod`, `reference`.

**Two known boundary leaks** (harmless today, worth not spreading): `locations.service.ts` imports
`drivers.repository.ts`, and `consignments.repository.ts` has its own `findDriverById`.

---

## 3. Authentication and authorization

Three layers, and confusing them is the usual source of security bugs.

### Layer 1 — who are you? (`authenticate`)

**Supabase Auth issues every token; this backend only ever verifies one.** There is no
`POST /api/auth/login`, no bcrypt and no signing key here. A client calls
`supabase.auth.signInWithPassword(...)` directly and gets a token that this API accepts *and* Postgres
understands for row-level security — which is the entire reason for the arrangement.

Verification is **local**, with `jose` against the project's public JWKS:

```
{SUPABASE_URL}/auth/v1/.well-known/jwks.json
```

Tokens are ES256. Supabase advises against verifying HS256 tokens with a shared secret and tells such
projects to call the Auth server on *every request* instead; asymmetric keys are what let this stay a
few microseconds of in-process maths. `issuer` and `audience` are both checked, not just the signature.

> **A failed JWKS fetch is a 503, not a 401.** Reporting an outage as "invalid or expired token" sends
> you debugging the wrong system. Every `jose` error *except* a timeout means the token is bad.

### ⚠️ The `role` claim is not our role

Supabase's own top-level `role` claim is always `anon`, `authenticated` or `service_role` — it is the
**Postgres role used to apply RLS**. Writing `admin` there would break RLS for that user.

Our role lives in **`app_metadata.role`**, mirrored from `users.role` whenever an admin changes it, and
is what RLS policies will read via `auth.jwt() -> 'app_metadata' ->> 'role'`.

`req.user` is then assembled from the verified token *plus our own profile row*, so deactivating someone
takes effect without waiting for their token to expire. Profiles are cached for 30 seconds, and any admin
write invalidates the entry immediately.

### Layer 2 — what kind of caller? (`requireMinRole`)

Ranked: `driver: 0 · operator: 1 · admin: 2`. A driver **fails every** console permission by
construction. `driver` is now a real `UserRole` — drivers hold accounts like everyone else.

`requireDriver` is the inverse — the caller must be a driver's phone.

### Layer 3 — is this record yours? (`allowOperatorOrAssignedDriver`)

Role alone cannot answer "is this order yours?", and for a driver that is the question that matters.
This guard lets operators through untouched and requires a driver to own the row
(`consignment.driverId === token.driverId`).

**It returns `403` for both "not yours" and "does not exist"** — a `404` for one and `403` for the other
would let a driver discover which order ids are real by watching status codes.

### The driver lifecycle — three states, kept apart

Merging these causes real operational bugs, so they are separate columns with separate owners:

| State | Column | Set by | Changes |
|---|---|---|---|
| **On shift** | `drivers.onShift` | the driver, from the phone | several times a day |
| **Active / employed** | `drivers.active` | an admin | rarely |
| **Has a login** | `users.driverId` | an admin | once |

`GET /api/drivers?onShift=true` is what the assignment popover sends, so an operator is offered only
people who have clocked in. Without the filter every active driver is returned — otherwise dispatch would
be impossible at 6am before anyone taps the button.

A `pg_cron` job clocks everyone off at 04:00. A shift does not carry across days, and a courier who
forgets to tap *off* must not look available all week.

**Removing a driver almost always means deactivating them.** A hard delete is refused with a 409 when
they have any consignment or proof on record — `consignments.driverId` is `onDelete: Restrict`, and
erasing them would erase who delivered what. Deleting their *login* is separate and always allowed: it
kills access instantly and leaves the history intact.

> The password-free driver sign-in is **gone**. `GET /api/drivers/roster`, `POST /api/drivers/session`
> and `ALLOW_DRIVER_SELF_SELECT` no longer exist — anyone holding the URL could previously become any
> driver and close their jobs.

---

## 4. API reference

Error envelope for every failure:

```json
{ "error": { "code": "CONFLICT", "message": "…", "details": { "field": ["…"] } } }
```

`details` carries Zod field errors on a 400 — surface it, or "Validation failed" is unactionable.

**All request bodies are `.strict()`**: an unknown key is a 400, not a silent drop. This is why `status`
and `orderNo` cannot be smuggled into a create or update.

### Health & auth

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | — | pings the database |
| `GET` | `/api/auth/me` | any token | the caller's profile: role, active, and their driver when they have one |

> **There is no login endpoint.** Clients sign in with `supabase.auth.signInWithPassword(...)` against
> Supabase directly, which also gives them automatic token refresh — something the old hand-rolled JWT
> never had.

### Users — admin only

An operator cannot so much as list who exists: this is the one part of the API that can mint the
credentials to reach the rest of it.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/users` | the admin table. `?role=`, `?q=`, `?includeInactive=` |
| `GET` | `/api/users/:id` | one profile |
| `POST` | `/api/users` | creates the Supabase login **and** the profile. For `role: driver`, supply either `driverId` (link a roster driver) or `newDriver` (create one) — exactly one |
| `PATCH` | `/api/users/:id` | any subset of email, password, name, role, active |
| `DELETE` | `/api/users/:id` | deletes the login and profile; a linked **driver row survives** |
| `GET` | `/api/users/unlinked-drivers` | roster drivers with no login yet — feeds the create form |
| `DELETE` | `/api/users/drivers/:id` | removes a courier from the roster entirely. **409 if they have any history** |

Three guards exist because each is a way to lock yourself out permanently: you cannot change your own
role, deactivate or delete yourself, and the **last active admin** cannot be demoted, deactivated or
deleted.

Creating a user writes the Supabase account first and the profile second; if the profile fails, the
account just created is deleted. Otherwise you get a login that resolves to no profile — a ghost that
fails every request with a confusing 403.

### Reference

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/reference` | operator+ | clients, drivers, and the status / priority / task-type / package-type option lists for form dropdowns |

### Consignments

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/consignments` | operator+ | Creates the order. Allocates `orderNo`, inserts items, writes the opening audit event. **`status` is not accepted.** At least one item required. |
| `GET` | `/api/consignments` | operator+ | Filters: `clientId`, `status`, `driverId`, `unassigned`, `from`, `to`, `q`, `page`, `pageSize≤100`, `sort`, `order`. Returns slim grid rows with summed qty/weight — **no items, no timeline**. |
| `GET` | `/api/consignments/:id` | operator **or assigned driver** | Full record: items, both proof legs with signed URLs, full timeline. |
| `PUT` | `/api/consignments/:id` | operator+ | Editable **only while `UNASSIGNED` or `ASSIGNED`**. Rejects `orderNo`/`status`. Omit `items` to leave them alone. |
| `PATCH` | `/api/consignments/:id/status` | operator **or assigned driver** | Only the four travelling/arrived steps. `PICKED_UP`/`DELIVERED` → 400. |
| `POST` | `/api/consignments/:id/assign` | operator+ | `{ driverId, note? }`. `UNASSIGNED → ASSIGNED`; or swaps the driver while still `ASSIGNED`. Past `ASSIGNED` → 409. |
| `DELETE` | `/api/consignments/:id/assign` | operator+ | `ASSIGNED → UNASSIGNED`. Refused once the run has started. |

**Item editing is a keyed diff.** Send an item's `id` to update it, omit `id` to create, leave an item out
to delete it. Ids stay stable across edits — do not delete-and-recreate.

### Proof of delivery

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/consignments/:id/pod/:leg` | operator **or assigned driver** | `:leg` = `pickup` \| `delivery`. multipart `photo` + `signature`. **Advances the status atomically.** 201, or 200 on an idempotent replay. |
| `GET` | `/api/consignments/:id/pod` | operator **or assigned driver** | Both legs with short-lived signed URLs |
| `PUT` | `/api/consignments/:id/pod/:leg/files` | **admin+** | Replace a blurry photo. Does **not** touch status, does not insert a second row. |

### Drivers

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/drivers/me/consignments` | driver | My jobs, scoped by token. `?includeDelivered=true` to include finished ones. Each row carries a **`nextAction`**. |
| `POST` | `/api/drivers/me/shift` | driver | `{ onShift }` — clock on or off. Only on-shift drivers are offered when assigning. |
| `POST` | `/api/drivers/me/locations` | driver | `{ pings: [...] }` — a batch, because phones buffer offline. |
| `GET` | `/api/drivers` | operator+ | Roster with `activeLoad` (jobs not yet delivered), `onShift`, `shiftStartedAt` and **`shiftEndedAt`**. `q`, `includeInactive`, **`onShift`**. |
| `GET` | `/api/drivers/locations/latest` | operator+ | Who is live now — reads `driver_positions`, **not** the trail. Default window `POSITION_LIVE_SECONDS` (120s); `withinMinutes` overrides, `onShiftOnly` defaults true. |
| `GET` | `/api/drivers/:id/trail` | operator+ | The path taken, oldest first. `from`, `to`, `limit≤5000`. |

**`nextAction`** tells the driver app what to do without re-implementing the state machine:
`START_PICKUP → ARRIVE_AT_PICKUP → CAPTURE_PICKUP_PROOF → START_DELIVERY → ARRIVE_AT_DELIVERY →
CAPTURE_DELIVERY_PROOF → NONE`. The two `CAPTURE_` steps mean "open the camera", not "show a status button".

### Chat — operators and admins only

Drivers are excluded at the router (`requireMinRole('operator')`); this is internal dispatch talk.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/chat/directory?q=` | Who you may talk to. Drivers and deactivated accounts never appear. |
| `GET` | `/api/chat/conversations` | Inbox: last message, unread count, members. One query with two LATERALs. |
| `POST` | `/api/chat/conversations/direct` | `{userId}` → **201** for a new thread, **200** for the existing one. |
| `POST` | `/api/chat/conversations/spaces` | `{name, description?, userIds?}` |
| `GET` `PATCH` | `/api/chat/conversations/:id` | PATCH is a **409 on a DIRECT** — a two-person thread has no name to change. |
| `GET` | `/api/chat/conversations/:id/messages` | `limit`, and `before` **or** `after` for paging both ways. |
| `POST` | `/api/chat/conversations/:id/messages` | `{body, clientMessageId}`. **201** new, **200** replay — a retry cannot double-post. |
| `POST` | `/api/chat/conversations/:id/attachments` | multipart `file` (≤5 MB, any type), `clientMessageId`, optional `body`. |
| `GET` | `/api/chat/conversations/:id/messages/:messageId/attachment` | Short-lived signed URL. |
| `POST` `DELETE` | `/api/chat/conversations/:id/members[/:userId]` | 409 on a DIRECT. |
| `POST` | `/api/chat/conversations/:id/leave` | 409 on a DIRECT. |
| `POST` | `/api/chat/conversations/:id/read` | `{lastMessageId}` |

Realtime topic `chat:<userId>:inbox`; events `chat.message.created`, `chat.membership.changed`.
**Per-user topics, fanned out by a trigger** — a shared topic could not be revoked, because Realtime
caches channel authorization at join for the life of the socket.

### Dispatch map

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/map/pins` | Every task as a waypoint. `tab`, `driverIds`, `clientId`, `q`, `from`/`to` (on `deliverBy`), `completedSince`, `limit≤5000`. |
| `GET` | `/api/map/drivers` | The DRIVERS-tab roster. `includeInactive` defaults **true** — a deactivated driver still holding open work must stay labellable. |

`meta` carries `counts` (all three tabs, always — they are **facets**, not filtered by `tab`), `byStatus`,
`byDriver`, `unmappable`, `total`, `returned`, `truncated`. Realtime topic `dispatch:tasks`, event
`map.task.changed`, payload **exactly `{id, op}`** — an invalidation, never data.

### Routing — needs OSRM

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/consignments/:id/nearest-drivers` | Assignable drivers ranked by driving time to the **sender**. `withinMinutes`, `includeUnlocated`, `limit`. |
| `GET` | `/api/consignments/:id/driver-route` | `?driverId=` → the road line that driver would take to the pickup. |

`nearest-drivers` shortlists in SQL (active + on shift + reporting) then ranks with **one** OSRM matrix
call. If OSRM is unreachable it falls back to straight-line and sets `meta.source: 'straight-line'` with a
warning — never silently, because a crow-flies number read as a drive time sends someone the wrong side of
the canal. Drivers with no recent position are still listed, `ranked: false`, sorted last.

`driver-route` never errors for an absent line: **200 with `available: false`** and a `reason` of
`no-position` / `no-road-route` / `engine-unavailable`. A 404 on clicking a name reads as a broken console.

### Bulk assign and planned routes

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/consignments/assign-bulk` | `{consignmentIds[], driverId}`. **Partial success is the contract** — returns `assigned[]`, `failed[{id, orderNo, code, message}]` and `counts`. |
| `POST` | `/api/routes` | `{driverId, consignmentIds[], start, end?, clientKey?}` → plans and saves. |
| `GET` | `/api/routes/driver/:driverId` | **200 with `route: null`** when there is no plan. |
| `PATCH` | `/api/routes/:id/sequence` | `{consignmentIds[], version}` — the operator's order. |
| `POST` | `/api/routes/:id/optimise` | A **preview**. Changes nothing. |
| `DELETE` | `/api/routes/driver/:driverId` | Retires the plan; assignments survive. |

Rules worth knowing before changing any of it:

- **Bulk assign never rolls back.** Fifty orders are fifty decisions; one already collected must not undo
  the other forty-nine. Each goes through the same `assignDriver` path, and failures are collected.
- **`POST /routes` does not assign.** Folding the two together would produce a route that half-exists when
  order 37 turns out to be already collected. It requires the orders to be the driver's already, and every
  refusal **names the order numbers** — with fifty selected, "some cannot be routed" is unactionable.
- **A reorder is strictly a permutation** of the current stops. Adding or dropping is a 400: dragging a row
  must not become a way to change what the driver is carrying.
- **`version` is optimistic concurrency.** Two dispatchers reordering one route — the second gets a 409,
  not a silent overwrite.
- **Max 95 stops.** OSRM's trip service caps at 100 coordinates (measured: 101 → `TooBig`) and the start,
  plus an end when given, take two.
- **Re-optimise is never applied automatically.** Silently re-planning a hand-made order is how a driver
  ends up doubling back and stops trusting the app.

---

## 5. Data model

Sender and receiver are **snapshots on the order**, not references to an address book — editing a client
must never rewrite the history of a dispatched job.

| Table | Purpose | Notes |
|---|---|---|
| `clients` | Daraz, Apple Express, TCS | `code` (DRZ/APX/TCS) prefixes order numbers |
| `drivers` | the courier roster | `onShift` + `shiftStartedAt`/`shiftEndedAt`, and `mapColorIndex` |
| `users` | **profiles**, not credentials | `id` IS the `auth.users` uuid; holds `role`, `active`, `driverId` |
| `consignments` | the order | flat: identity, client, driver, status, structured sender/receiver, scheduling, lifecycle stamps, and **sender/receiver coordinates** |
| `items` | what is being carried | description, qty, weightKg, packageType, barcode. **No dimensions, no cubic.** |
| `proofs_of_delivery` | photo + signature per leg | `@@unique([consignmentId, leg])` — at most one per leg |
| `tracking_events` | audit trail | `fromStatus` + `toStatus`, so an assignment is distinguishable from a status move |
| `driver_locations` | GPS **history** | append-only, only significant movement, pruned after 7 days |
| `driver_positions` | **where each driver is now** | PK `driverId` — one row, overwritten forever |
| `order_counters` | `(clientId, dateKey) → lastSeq` | makes order numbers atomic |
| `chat_conversations` · `chat_members` · `chat_messages` | internal messaging | `senderId` has **no FK** — history survives an account being deleted |
| `routes` · `route_stops` | planned delivery runs | a plan, gating nothing; see below |

### Why positions and history are separate tables

They answer different questions with opposite write patterns, and answering both from `driver_locations`
was the root of a family of bugs:

- a `DISTINCT ON` over a table growing by millions of rows, and worse
- **liveness that depended on whether the driver moved.** History should only record movement, so a
  courier parked at a warehouse stopped writing rows and silently vanished from the live map.

With a primary key on `driverId` the write is an in-place UPDATE, the table never grows, and "who is live"
is a scan of eight rows. The phone can then report every few seconds regardless of movement, because
volume costs nothing when you are overwriting. `POST /me/locations` writes **both**: the position always,
history only past `HISTORY_MIN_MOVE_M`.

### Routes are a plan, not a state machine

`routes` + `route_stops` **modify no existing table**. Nothing there gates a status, demands a proof or
changes an assignment — delete both and the system behaves exactly as it did before. Two decisions carry
the design:

- **The sequence is stored; the line never is.** "Visit this order seventh" is a decision nothing else
  records. Geometry is regenerated from OSRM on every read (~300 ms for 126 waypoints), so there is no
  cache to invalidate and the drawing cannot disagree with the stops.
- **Each stop snapshots the delivery coordinates it was planned against.** That is the only way to notice
  later that someone edited an address under a plan already in progress — the old value exists nowhere
  else once the consignment is updated. Stop health (`delivered`, `reassigned`, `unassigned`,
  `address-moved`) is then **derived on read**, so there is no denormalised state to go stale and no
  trigger to maintain.

Constraints Prisma cannot express live in `prisma/sql/routes.sql`: a **partial unique index** for one
ACTIVE route per driver, and `UNIQUE (routeId, seq) DEFERRABLE INITIALLY DEFERRED` — deferrable because
reordering rewrites most of the sequence at once, and an immediately-checked constraint would reject the
first UPDATE against a row that has not moved yet.

### Address coordinates

`senderLat` · `senderLng` · `receiverLat` · `receiverLng` — all `Float?`, accepted as `lat` / `lng`
inside the `sender` and `receiver` objects on create and update, and returned in the same place.

They exist so the dispatcher map can pin pickup and delivery. **There is no geocoding on the server** —
the console captures them when the operator picks an address suggestion (TomTom Search, called
from the browser) or drags a map pin. That keeps a rate-limited third-party call out of the request
path and off the critical path of creating an order.

Nullable on purpose: Postman, the seed and any future integration must be able to log an order whose
address will not geocode. The console additionally refuses to save without them, which is a UI rule,
not a database one.

> The update path uses `?? null`, so sending a `sender` object **without** `lat`/`lng` clears any
> stored coordinates — the same behaviour `phone` and `postcode` already have.

### Invariants enforced by the database

`prisma/sql/constraints.sql` — applied by `npm run db:constraints`, idempotent. Code-level guards vanish
the moment someone opens the Supabase SQL editor; these do not.

```sql
-- A driver and the status must agree, in both directions.
CHECK (("driverId" IS NULL) = (status = 'UNASSIGNED'))
CHECK (qty >= 1)
CHECK ("weightKg" IS NULL OR "weightKg" >= 0)
CHECK ("readyBy" IS NULL OR "deliverBy" IS NULL OR "deliverBy" >= "readyBy")
```

Because of the first one, `consignments.driverId` uses `onDelete: Restrict`, not `SetNull` — nulling a
driver on an in-flight order would violate it.

### Row-level security

**Supabase publishes every `public` table through PostgREST using the anon key**, which is public by design
and ships in any frontend bundle. Without protection, all consignment, client and user data is readable by
anyone who knows the project URL.

So the same file **enables RLS on every table with no policies at all**, and revokes all grants from
`anon` and `authenticated`. The backend connects as `postgres`, which has `rolbypassrls`, so it is
unaffected.

Supabase's linter reports these as *"RLS enabled, no policy"* at INFO level. **That is the intended state,
not an oversight.**

#### The one exception: `realtime.messages`

The note that used to sit here — "Realtime respects RLS and would deliver nothing, so poll instead" — has
been overtaken. Realtime is in use, and the way it is done keeps the doctrine above intact: **application
tables still have zero policies and are still unreadable by `anon`/`authenticated`.** The only policies in
the project are three `SELECT` policies on `realtime.messages`, which decide who may *join a topic*:

| Topic | Who may join | Defined in |
|---|---|---|
| `chat:<uid>:inbox` | that user only, matched on `auth.uid()` | `chat.sql` |
| `dispatch:tasks` | operators and admins, via `is_ops_user()` | `map.sql` |
| `dispatch:drivers` | operators and admins, via `is_ops_user()` | `positions.sql` |

Nothing is broadcast by the browser — there is **no INSERT policy on any of them**, so only the database
triggers can publish.

`is_ops_user()` is `SECURITY DEFINER` because the policy evaluates as `authenticated`, which this file has
just revoked from `public.users`. It is `STABLE`, pinned to an empty `search_path`, takes no argument an
attacker can steer, and is revoked from `PUBLIC`. It reads `public.users.role` rather than the JWT's
`app_metadata.role` on purpose: a claim is baked in at token issuance, so a demoted operator would keep
ops access until their token refreshed.

Two properties of Realtime that shaped all of this:

- **Channel authorization is computed at JOIN and cached for the life of the socket.** Nobody can be
  promptly revoked from a shared topic — which is why `dispatch:tasks` carries `{id, op}` and nothing
  worth stealing, and why chat uses a topic per user rather than one per conversation.
- **`realtime.send` swallows its own failures** with a `RAISE WARNING`. Delivery is best-effort, so every
  client keeps a slow poll underneath and refetches on subscribe and reconnect.

One operational gotcha: `realtime.messages` is **daily-partitioned, and only Supabase's Realtime service
can create the partitions** — `postgres` gets `permission denied for schema realtime`. A client connection
wakes the tenant, which provisions them. Before that happens every broadcast is silently dropped, because
of the swallowed-failure behaviour above.

---

## 6. Two mechanisms that need care

### Order numbers — atomic, never read-then-increment

`INSERT … ON CONFLICT DO UPDATE … RETURNING` against `order_counters`, and **called outside the insert
transaction**. The counter row serializes every create for one client on one day, so holding its lock for a
whole multi-statement transaction makes concurrent creates queue and time out.

The trade-off: a failed insert burns a number, leaving a gap. Fine — these are identifiers, not a gapless
financial series.

> Verified by `orderNo.test.ts`: 20 concurrent creates → 20 distinct numbers, zero conflicts.

### Proof upload — storage first, then the transaction

```
1. multer memoryStorage      both files buffered, never hit disk
2. validate in-process       magic bytes, size, both files present
3. pre-flight read           wrong status / already captured fails here, before any network cost
4. upload both to Storage    deterministic paths, upsert
5. one transaction           CAS the status → insert proof → write audit event
6. on failure                best-effort delete of the just-written objects
```

**Never reorder 4 and 5.** Row-first would allow an order marked `DELIVERED` whose proof file was never
written — the exact failure this feature exists to prevent.

**Uploads are validated by magic bytes, not `Content-Type`.** That header is client-supplied and trivially
forged; a PDF labelled `image/png` is rejected by `utils/imageSniff.ts`.

**Paths are deterministic** — `{consignmentId}/{LEG}/photo.{ext}`. A failed retry therefore leaves at most
two overwritable objects instead of unbounded orphans. The cost is that paths are guessable, which is
exactly why the bucket is **private** and reads go through short-lived signed URLs.

**Idempotency:** send an `Idempotency-Key` header and a retry whose response was lost returns **200 with
the original proof** instead of a 409 — the normal case for a phone on a weak signal.

---

## 7. File map

```
src/
  app.ts                     cors allowlist, json, /health, mounts, notFound, errorHandler
  server.ts                  listen + graceful shutdown
  config/
    env.ts                   Zod-validated process.env; throws at import on a bad value
    prisma.ts                PrismaClient via the PrismaPg driver adapter (Prisma 7)
    supabase.ts              Storage client, service-role key, Storage ONLY
  constants/
    enums.ts                 Prisma enum re-exports + label maps + asOptions()
    statusFlow.ts            TRANSITIONS (gated), canTransition, MANUAL_STATUS_TARGETS, isEditable
  middleware/
    auth.ts                  Bearer JWT → req.user
    rbac.ts                  requireMinRole (ranked), requireDriver, requireRole
    ownership.ts             allowOperatorOrAssignedDriver — resource-level authorization
    validate.ts              Zod for body/query/params. Express 5's req.query is getter-only, so
                             parsed query goes on req.validatedQuery → getValidatedQuery<T>()
    upload.ts                multer memoryStorage, 2 files, size + mime pre-filter
    errorHandler.ts          AppError · ZodError · MulterError · Prisma P2002/P2025/P2003/P2034/P2028
    notFound.ts              unmatched route → 404
  modules/<name>/            routes → controller → service → repository
    drivers/                 drivers.service (console roster) · driverWork.service (my jobs)
                             · drivers.repository
    locations/               GPS: repository · service · controller (routes live in drivers.routes)
    pod/                     + pod.storage.ts (Supabase Storage: paths, upload, signed URLs)
    chat/                    + chat.guard.ts (membership) · chat.storage.ts · chat.upload.ts
                             · chat.rateLimit.ts (in-memory token bucket, 20 burst / 2 per sec)
    map/                     dispatch map pins and roster; reads constants/mapTabs.ts
    routing/                 routing.osrm.ts — THE ONLY place that talks to OSRM.
                             Owns the lon,lat ↔ lat,lng flip and the outage-vs-no-answer distinction
    routes/                  planned runs; depends on routing for geometry
  schemas/                   Zod at the API boundary; every object .strict()
  utils/
    orderNo.ts               atomic client-prefixed allocation
    imageSniff.ts            PNG/JPEG/WebP magic bytes
    geo.ts                   haversine + plottable() — rejects (0,0), a failed geocode not a place
    httpError.ts             AppError + factories
    jwt.ts · password.ts · pagination.ts · asyncHandler.ts
prisma/
  schema.prisma              the tables
  seed.ts                    DESTRUCTIVE rebuild: admin, 3 clients, 8 drivers (6 on shift), 9 orders
  seedGta.ts                 ADDITIVE: 200 unassigned GTA- orders around Mississauga; --clean removes them
  sql/constraints.sql        CHECK constraints, RLS lockdown, pg_cron retention + shift-reset jobs
  sql/chat.sql               chat CHECKs, the inbox RLS policy, fan-out triggers
  sql/map.sql                is_ops_user(), the dispatch:tasks policy and task/item triggers
  sql/positions.sql          the dispatch:drivers policy and the position broadcast trigger
  sql/routes.sql             partial unique index + the DEFERRABLE (routeId, seq) constraint
  applyConstraints.ts        runs the SQL via `pg` (psql is not on a typical Windows box).
                             ORDER MATTERS — positions.sql needs is_ops_user() from map.sql
```

**One rule the OSRM client exists to protect: OSRM speaks `lon,lat`, Leaflet wants `lat,lng`.** Swapping
them raises nothing — it draws a confident line in the Indian Ocean. The flip happens once, in
`routing.osrm.ts`, and there are tests asserting every returned point lands inside Pakistan.

---

## 8. Running it from a fresh clone

Nothing here depends on the frontend — this gets the API running on its own.

There are two paths. **Most people on the team want the first one.**

| | You need | Time |
|---|---|---|
| **A. Use the team's `.env`** | someone to send you the file | 2 minutes |
| **B. Your own Supabase project** | a free Supabase account | ~15 minutes |

### Path A — the team's shared `.env` (normal case)

```bash
cd backend
npm install
# put the .env you were given into backend/.env
npm run prisma:generate
npm run dev            # http://localhost:4000
```

That is all. The schema, constraints and seed data already exist in the shared project — **do not run
`db:push`, `db:constraints` or `seed`**; they are one-time setup that has been done.

Then jump to **[step 7, Verify it works](#step-7--verify-it-works)**, and read
**[Working as a team](#working-as-a-team)** before you run anything else. There are two ways to destroy
everyone's data by accident.

To explore the API by hand from there, **[§9 has a full Postman walkthrough](#9-trying-the-api-in-postman)**
— every endpoint, the exact JSON each returns, and what should fail.

> ### How to share `.env` — and how not to
>
> That file contains the database password and the **service-role key, which bypasses every security rule
> on the project**. Treat it like a production credential.
>
> - ✅ A password manager or company vault — 1Password, Bitwarden, Vaultwarden
> - ❌ **Never commit it.** `.gitignore` blocks it, but git history is forever if it ever slips through
> - ❌ Not Slack, WhatsApp, email or a shared drive — all of them retain and index it
>
> If it does leak: rotate the database password (Settings → Database) **and** the service-role key
> (Settings → API), then reissue the file.

### Path B — your own Supabase project

Follow steps 1–7 below. Useful if you want an isolated database to experiment in, and **required** if you
are going to run the test suite (see [Working as a team](#working-as-a-team)).

### Prerequisites

- **Node 22 or newer** — `node -v`
- A free **Supabase** account — <https://supabase.com>

### Step 1 — Install

```bash
cd backend
npm install
```

### Step 2 — Create the Supabase project

1. Create a new project. Choose a region near you and **save the database password** — it is shown once.
2. Open **Connect** (top of the dashboard) → **ORMs** → **Prisma**, and copy the two connection strings.

> **Three traps, all of which cost real time:**
>
> - Use the **session-mode pooler** host — `aws-0-<region>.pooler.supabase.com:5432`. **Not** the
>   transaction pooler on `:6543`: Prisma takes a session-scoped advisory lock that transaction pooling
>   breaks, and schema commands then deadlock.
> - **Never** use `db.<project-ref>.supabase.co`. On projects created after Jan 2024 it resolves
>   **IPv6-only**, which simply hangs on a typical Windows machine or CI runner.
> - **URL-encode special characters in the password.** `@` becomes `%40`, `#` becomes `%23`. An
>   unencoded `@` ends the credentials early and the host is parsed wrongly.

### Step 3 — Create the Storage bucket

**Storage → New bucket**, named exactly **`pod`**:

| Setting | Value | Why |
|---|---|---|
| Public | **off** | Object paths are deterministic and therefore guessable — a public bucket would expose every customer signature |
| File size limit | `10 MB` | |
| Allowed MIME types | `image/jpeg`, `image/png`, `image/webp` | |

### Step 4 — Configure `.env`

```bash
cp .env.example .env
```

Fill in:

| Key | Where it comes from |
|---|---|
| `DATABASE_URL` | the session-mode pooler string from step 2 |
| `DIRECT_URL` | the same string — used by the Prisma CLI |
| `SUPABASE_URL` | Settings → API → Project URL. Also derives the JWKS URL used to verify tokens |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API Keys → `service_role` (marked secret) |
| `SUPABASE_STORAGE_BUCKET` | `pod` |
| `CORS_ORIGINS` | `http://localhost:5173` for the console |

**There is no JWT secret.** Supabase signs tokens with an ES256 key and publishes the public half; this
API verifies against that and holds no signing material at all.

> **Switch the project to asymmetric signing keys** (Settings → JWT Keys → ES256) before anything works.
> Confirm with `curl $SUPABASE_URL/auth/v1/.well-known/jwks.json` — it returns an empty `keys` array
> while the project is still on the legacy HS256 secret, and every request will 401.

> ⚠️ The **service-role key bypasses every security rule** on your project. It belongs on the server only —
> never in a frontend bundle, a mobile app, or a commit.

Generate a secret quickly:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Step 5 — Create the schema and data

```bash
npm run prisma:generate    # generate the Prisma client
npm run db:push            # create the 9 tables
npm run db:constraints     # CHECK constraints + RLS lockdown + retention job
npm run seed               # 3 clients, 8 drivers, 9 orders
```

> **Do not skip `db:constraints`.** It enables row-level security on every table. Without it, Supabase
> publishes all your data — consignments, clients, password hashes — through PostgREST using the public
> anon key. It also adds the CHECK constraints and the 7-day GPS retention job.
>
> If it cannot reach the database (some networks block direct Postgres), paste
> `prisma/sql/constraints.sql` into the Supabase **SQL Editor** and run it once. It is idempotent.

### Step 6 — Run

```bash
npm run dev      # http://localhost:4000
```

### Step 7 — Verify it works

```bash
# 1. the server is up and the database is reachable
curl http://localhost:4000/health
# → {"status":"ok"}

# 2. sign in — against SUPABASE, not this API. There is no /api/auth/login.
curl -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: <publishable key>" -H "Content-Type: application/json" \
  -d '{"email":"operations@innovoxpress.com","password":"ChangeMe!123"}'
# → {"access_token":"eyJ...", "refresh_token":"...", ...}

# 3. read the seeded orders (paste access_token from step 2)
curl "http://localhost:4000/api/consignments?pageSize=5" \
  -H "Authorization: Bearer <ACCESS_TOKEN>"
# → 9 orders, DRZ- / APX- / TCS- numbers
```

The publishable key is in the Supabase dashboard under Settings → API. It is **meant** to be public —
it grants nothing without a password.

The seeded admin is `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`, defaulting to
`operations@innovoxpress.com` / `ChangeMe!123`. **Change it** — the default is written in this file and
therefore public within the repo. It is now a 30-second job from the console's Users screen, or one
`PATCH /api/users/:id` call, rather than a database edit.

The 8 seeded drivers each get a login too — `<first>.<last>@innovoxpress.com` with the password set in
`prisma/seed.ts` — so the driver app is testable immediately.

### Working as a team

Everyone sharing one `.env` means everyone shares **one database**. Two things will bite.

#### 1. `npm test` destroys the shared data

The suites truncate consignments, items, events, proofs and locations **before every test**, and leave
`TCA`/`TCB` clients and `test-driver-*` rows behind. Run it against the shared project and every
colleague's demo data disappears mid-demo, with no warning and no undo.

**The fix — a scratch project for tests, done once:**

1. Create a second free Supabase project, e.g. `innovo-tms-test`.
2. Point a `.env.test` at it (same shape as `.env`, different `DATABASE_URL` / `DIRECT_URL`).
3. Run its one-time setup: `npm run db:push` and `npm run db:constraints` against that project.
4. Run tests with that env loaded — e.g. `dotenv -e .env.test -- npm test`, or set the variables in your
   shell for that terminal.

Since the Supabase Auth migration this is **worse than it was**: the helpers create and delete real
accounts in the project's auth store, so a stray run removes colleagues' logins, not just their demo
orders. `npm run seed` rebuilds the world afterwards, but anything created by hand is gone.

#### 2. Give people their own account

Everyone sharing one admin login used to be unavoidable — it no longer is. An admin creates accounts from
the console's **Users** screen, or directly:

```http
POST /api/users
{ "email": "colleague@innovoxpress.com", "password": "...", "name": "Their Name", "role": "operator" }
```

Give people `operator` unless they need more; `admin` additionally manages users and can replace
proof-of-delivery files. Until everyone has their own account, every tracking event records the same
actor regardless of who acted, and the audit trail cannot tell you who reassigned a driver.

#### 3. Schema changes

`npm run db:push` rewrites the shared schema for everyone. Before running it against the shared project:
tell the team, make sure nobody is mid-demo, and remember a column drop takes its data with it. Anyone
experimenting with the schema should be on their own project (Path B).

#### Also worth agreeing as a team

- **Change the seeded admin password.** The default is written in this file, so it is public within the
  repo. Do it from the Users screen.
- **Everyone should have their own account** — see above. Shared logins make the audit trail useless.
- **The service-role key in `.env` bypasses every Supabase security rule.** It is what lets this API
  create and delete accounts. Never let it near a browser.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Hangs, then `ETIMEDOUT` / `ENETUNREACH` | Using `db.<ref>.supabase.co` (IPv6-only). Switch to the pooler host. |
| `password authentication failed` | Special character in the password not URL-encoded — `@` → `%40`. |
| `P1001: Can't reach database server` | Wrong host or port, or a firewall blocking outbound 5432. |
| `P3014` on `prisma migrate` | Expected — Supabase refuses the shadow database. Use `npm run db:push`. |
| `Invalid environment configuration` at startup | A missing or malformed key in `.env`; the error names it. |
| Uploads fail with "Could not store the proof file" | The `pod` bucket does not exist, or the service-role key is wrong. |
| Supabase shows "RLS enabled, no policy" | **Correct.** That is the intended state — see §5. |

### Why `db:push` and not `migrate`

Supabase's restricted `postgres` role usually refuses to create the shadow database that `prisma migrate
dev` needs (`P3014`). `db:push` syncs the schema directly. Before you have production data, author a real
migration against a local Postgres and ship it with `migrate deploy`.

### Environment reference

| Key | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | runtime connection, session-mode pooler |
| `DIRECT_URL` | falls back to `DATABASE_URL` | used by the Prisma CLI |
| `SUPABASE_URL` | — | Storage, Auth admin, **and** the JWKS endpoint tokens are verified against |
| `SUPABASE_SERVICE_ROLE_KEY` | — | bypasses all Supabase security; also what creates/deletes accounts |
| `SUPABASE_STORAGE_BUCKET` | `pod` | must be private |
| `POD_MAX_PHOTO_BYTES` | `10485760` | 10 MB |
| `POD_MAX_SIGNATURE_BYTES` | `2097152` | 2 MB |
| `POD_SIGNED_URL_TTL` | `300` | seconds a proof link stays valid |
| `LOCATION_RETENTION_DAYS` | `7` | the pg_cron interval lives in `constraints.sql` — change both |
| `CHAT_STORAGE_BUCKET` | `chat-attachments` | private, **separate from `pod`** — POD's image-only whitelist is an evidence rule; chat takes any type |
| `CHAT_MAX_FILE_BYTES` | `5242880` | 5 MB |
| `CHAT_SIGNED_URL_TTL` | `300` | seconds a chat attachment link stays valid |
| `POSITION_LIVE_SECONDS` | `120` | how recently a driver must have reported to count as live |
| `HISTORY_MIN_MOVE_M` | `15` | how far a driver must move for a fix to be kept as *history*; the live position is always overwritten |
| `OSRM_URL` | `http://localhost:5000` | the routing engine. No key — it is our own process |
| `OSRM_TIMEOUT_MS` | `4000` | short on purpose: an operator is waiting, and a stale ranking beats a hung list |
| `CORS_ORIGINS` | `http://localhost:5173` | comma-separated |
| `PORT` / `NODE_ENV` | `4000` / `development` | |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_NAME` | see table above | used by `npm run seed` |

### OSRM — the one non-Supabase dependency

Routing, ETAs and route optimisation come from a **self-hosted OSRM** at `OSRM_URL`. It is free, local and
unmetered, and the current build covers Pakistan (verified on both Lahore and Islamabad).

Three services are used, and confusing the first two is the easiest mistake here:

| Service | Question it answers | Changes the order? |
|---|---|---|
| `/table` | "how far is everyone from this point?" — numbers only, no geometry | — |
| `/route` | "draw the roads through these stops **in this order**" | **No** — it obeys |
| `/trip` | "what is the **best order** for these stops?" | **Yes** — that is its job |

Reordering a saved route uses `/route`; re-optimising uses `/trip`. Using `/trip` on a read would silently
draw a different route than the one on screen.

**Measured limits on this build** — worth trusting over the docs, since they are configurable per server:
`/table` and `/trip` cap at **100 coordinates** (101 → `TooBig`); `/route` has no waypoint cap and drew
126 waypoints in ~300 ms; `/match` also caps at 100.

**It is not traffic-aware.** Durations come from OpenStreetMap speed profiles, so it correctly prefers a
longer stretch of main road over a shorter crawl through lanes, but treats 3pm and 7pm as identical.
Every response that carries a duration also carries `trafficAware: false`; keep it that way.

---

## 9. Trying the API in Postman

Assumes **Path A**: you have the team's `.env`, the database is already set up, and `npm run dev` is
running on `http://localhost:4000`.

> ⚠️ **Postman writes to the shared database and leaves the rows there.** Every order you create shows up
> in your colleagues' console. Use an obvious `clientReference` like `POSTMAN-yourname-1` so your test rows
> are easy to spot and delete. This is the main difference from the test suite — see [§9.7](#97-postman-vs-the-test-suite).

### 9.1 One-time setup

**Create an environment** (Environments → +) called `Innovo Local`, with these variables:

| Variable | Initial value |
|---|---|
| `baseUrl` | `http://localhost:4000` |
| `token` | *(leave empty — filled automatically)* |
| `driverToken` | *(leave empty)* |
| `consignmentId` | *(leave empty)* |
| `driverId` | *(leave empty)* |

Select that environment from the dropdown, top right. Anything in `{{curly braces}}` now resolves.

**Make the login request fill in the token for you.** On the login request, open the **Scripts** tab
(older Postman: **Tests**) and paste:

```js
const body = pm.response.json();
pm.environment.set("token", body.token);
console.log("token saved for", body.user.email);
```

Now you log in once and every other request just works. Without this you would be copying a long JWT by
hand into every request.

**Set collection-level auth** so you do not repeat it: on the collection → **Authorization** →
Type **Bearer Token** → Token `{{token}}`. Individual requests then inherit it.

### 9.2 The happy path, in order

Run these top to bottom and you will take an order from creation to delivered:

| # | Request | Does |
|---|---|---|
| 1 | `POST {supabase}/auth/v1/token?grant_type=password` | get a token — **from Supabase, not this API** |
| 2 | `GET /api/reference` | get the client and driver ids you need |
| 3 | `POST /api/consignments` | create the order |
| 4 | `POST /api/consignments/{{consignmentId}}/assign` | attach a driver → `ASSIGNED` |
| 5 | `PATCH …/status` `EN_ROUTE_TO_PICKUP` | driver sets off |
| 6 | `PATCH …/status` `AT_PICKUP` | driver arrives |
| 7 | `POST …/pod/pickup` | photo + signature → **`PICKED_UP`** |
| 8 | `PATCH …/status` `EN_ROUTE_TO_DELIVERY` | |
| 9 | `PATCH …/status` `AT_DELIVERY` | |
| 10 | `POST …/pod/delivery` | photo + signature → **`DELIVERED`** |

Steps 7 and 10 are the interesting ones: the upload *is* the status change.

### 9.3 Console endpoints

---

**1. Sign in — against Supabase**

This API has no login endpoint. Point Postman at your Supabase project:

```
POST {{supabaseUrl}}/auth/v1/token?grant_type=password
```

Headers: `apikey: {{publishableKey}}` · `Content-Type: application/json`

```json
{ "email": "operations@innovoxpress.com", "password": "ChangeMe!123" }
```

Returns **200** with `access_token`, `refresh_token` and `expires_in`. Save it in the Scripts tab:

```js
pm.environment.set("token", pm.response.json().access_token);
```

Note the field is **`access_token`**, not `token`. Then `GET {{baseUrl}}/api/auth/me` tells you what that
person may do — role and active flag live in *our* database, not in the token's `role` claim (which is
always the literal `authenticated`, because it is the Postgres role used for RLS).

A wrong password gives **400** from Supabase, not 401 from us.

---

**2. Reference data** — where you get real ids

```
GET {{baseUrl}}/api/reference
```

Returns **200**:

```json
{
  "clients":  [{ "id": "cm...", "name": "Daraz", "code": "DRZ" }],
  "drivers":  [{ "id": "cm...", "name": "Ahsan Iqbal", "code": "DRV-008", "mobile": "+92 322 4471308" }],
  "statuses": [{ "value": "UNASSIGNED", "label": "Unassigned" }],
  "priorities": [...], "taskTypes": [...], "packageTypes": [...]
}
```

Copy a client `id` for the next step.

---

**3. Create a consignment**

```
POST {{baseUrl}}/api/consignments
```

```json
{
  "clientId": "PASTE_A_CLIENT_ID",
  "clientReference": "POSTMAN-yourname-1",
  "taskType": "DELIVERY",
  "priority": "NORMAL",
  "generalNote": "Created from Postman",
  "sender": {
    "name": "Daraz Fulfilment Centre", "phone": "+92 42 3529 8800",
    "line1": "Warehouse 4, Sundar Industrial Estate", "area": "Raiwind Road",
    "city": "Lahore", "postcode": "54000", "instructions": "Gate 2"
  },
  "receiver": {
    "name": "Sana Yousaf", "phone": "+92 300 4471129",
    "line1": "House 214, Street 8, Block C", "area": "DHA Phase 5",
    "city": "Lahore", "postcode": "54792", "notes": "Ring twice"
  },
  "items": [
    { "description": "Power bank 20000mAh", "qty": 1, "weightKg": 0.48,
      "packageType": "BOX", "barcode": "8901234500011" }
  ]
}
```

Returns **201** with the full record:

```json
{
  "id": "cm...", "orderNo": "DRZ-20260815-0004", "clientReference": "POSTMAN-yourname-1",
  "client": { "id": "cm...", "name": "Daraz", "code": "DRZ" },
  "driver": null,
  "status": "UNASSIGNED", "statusLabel": "Unassigned",
  "priority": "NORMAL", "taskType": "DELIVERY",
  "sender":   { "name": "...", "line1": "...", "city": "Lahore", ... },
  "receiver": { "name": "...", "line1": "...", "city": "Lahore", ... },
  "readyBy": null, "deliverBy": null,
  "assignedAt": null, "pickedUpAt": null, "deliveredAt": null,
  "items":  [{ "id": "cm...", "description": "...", "qty": 1, "weightKg": 0.48,
               "packageType": "BOX", "barcode": "8901234500011" }],
  "totals": { "itemCount": 1, "totalQty": 1, "totalWeightKg": 0.48 },
  "proofs": [],
  "timeline": [{ "fromStatus": null, "toStatus": "UNASSIGNED",
                 "toStatusLabel": "Unassigned", "note": "Consignment logged", ... }],
  "createdAt": "2026-08-15T...", "updatedAt": "2026-08-15T..."
}
```

Note `orderNo` was assigned by the server, `status` is always `UNASSIGNED` on create, and the timeline
already has its opening event.

**Save the id automatically** — Scripts tab:

```js
pm.environment.set("consignmentId", pm.response.json().id);
```

---

**4. List consignments**

```
GET {{baseUrl}}/api/consignments?pageSize=10&sort=createdAt&order=desc
```

Query params worth knowing (Postman's **Params** tab):

| Param | Example | Effect |
|---|---|---|
| `clientId` | `cm...` | only that client's orders |
| `status` | `AT_PICKUP` | one status |
| `driverId` | `cm...` | one driver's orders |
| `unassigned` | `true` | only orders with no driver |
| `from` / `to` | `2026-08-01` | created-date range (`to` covers the whole day) |
| `q` | `Karachi` | free text over order no, client ref, names, cities |
| `page` / `pageSize` | `1` / `20` | max 100 |

Returns **200** — note these are **slim rows: no items, no timeline**:

```json
{
  "data": [{
    "id": "cm...", "orderNo": "DRZ-20260815-0004", "clientReference": "POSTMAN-yourname-1",
    "client": { "id": "cm...", "name": "Daraz", "code": "DRZ" },
    "driver": null, "status": "UNASSIGNED", "statusLabel": "Unassigned",
    "priority": "NORMAL", "taskType": "DELIVERY",
    "senderName": "...", "senderLine1": "...", "senderCity": "Lahore", "senderProvince": "...",
    "receiverName": "...", "receiverLine1": "...", "receiverCity": "Lahore", "receiverProvince": "...",
    "readyBy": null, "deliverBy": null, "generalNote": "...",
    "createdAt": "2026-08-15T...",
    "itemCount": 1, "totalQty": 1, "totalWeightKg": 0.48
  }],
  "meta": { "total": 10, "page": 1, "pageSize": 10, "totalPages": 1 }
}
```

An unknown query parameter returns **400** — the schemas are strict.

---

**5. One consignment in full**

```
GET {{baseUrl}}/api/consignments/{{consignmentId}}
```

Same shape as the create response, including `items`, `proofs` and the whole `timeline`.

---

**6. Edit** — only while `UNASSIGNED` or `ASSIGNED`

```
PUT {{baseUrl}}/api/consignments/{{consignmentId}}
```

```json
{ "priority": "HIGH", "generalNote": "Escalated by the client" }
```

**Items are a keyed diff.** Send `id` to update, omit `id` to create, leave one out to delete:

```json
{
  "items": [
    { "id": "EXISTING_ITEM_ID", "description": "Power bank", "qty": 5, "weightKg": 0.48, "packageType": "BOX" },
    { "description": "New carton", "qty": 1, "weightKg": 2 }
  ]
}
```

**Omit `items` entirely** to leave them untouched. Sending `[]` is a 400 — an order needs at least one item.

Once the order is past `ASSIGNED` this returns **409**.

---

**7. Assign a driver**

```
POST {{baseUrl}}/api/consignments/{{consignmentId}}/assign
```

```json
{ "driverId": "PASTE_A_DRIVER_ID" }
```

Returns **200**, `status` now `ASSIGNED`, `assignedAt` set, and a new timeline entry
*"Assigned to Ahsan Iqbal"*. Posting again with a **different** driver swaps them (*"Reassigned from…"*);
the **same** driver gives 409; past `ASSIGNED` gives 409.

`DELETE` the same URL to unassign — allowed only while `ASSIGNED`.

---

**8. Move the order along**

```
PATCH {{baseUrl}}/api/consignments/{{consignmentId}}/status
```

```json
{ "status": "EN_ROUTE_TO_PICKUP" }
```

Only four values are accepted: `EN_ROUTE_TO_PICKUP`, `AT_PICKUP`, `EN_ROUTE_TO_DELIVERY`, `AT_DELIVERY`.

Try `{"status":"DELIVERED"}` — you get **400**. Proof is the only route to that state, and the schema
rejects the word before any code runs.

---

**9. Driver roster with workload**

```
GET {{baseUrl}}/api/drivers?includeInactive=false
```

```json
{ "data": [{ "id": "cm...", "name": "Ahsan Iqbal", "code": "DRV-008",
             "mobile": "+92 322 4471308", "active": true, "activeLoad": 1 }] }
```

`activeLoad` counts jobs not yet delivered — who is free.

### 9.4 The driver app flow

**A driver signs in exactly like anyone else — against Supabase, with a password.** The passwordless
`GET /api/drivers/roster` and `POST /api/drivers/session` shown in older copies of this file are gone:
anyone holding the URL could become any driver and close their jobs.

Sign in the same way as §9.1, using a driver account (`npm run seed` creates one per driver, password
`Driver!123`):

```
POST {{supabaseUrl}}/auth/v1/token?grant_type=password
apikey: {{supabasePublishableKey}}

{ "email": "ahsan-iqbal@innovoxpress.com", "password": "Driver!123" }
```

Save it as a **separate** variable so it does not clobber your console token:

```js
pm.environment.set("driverToken", pm.response.json().access_token);
```

For every driver request below, override the collection auth: **Authorization → Bearer Token →
`{{driverToken}}`**.

**My jobs:**

```
GET {{baseUrl}}/api/drivers/me/consignments
```

Returns only orders assigned to *that* driver, each with a **`nextAction`**:

```json
{ "data": [{
  "id": "cm...", "orderNo": "DRZ-20260815-0004", "status": "ASSIGNED",
  "client": { "name": "Daraz" },
  "senderName": "...", "senderLine1": "...", "senderCity": "Lahore",
  "receiverName": "...", "receiverLine1": "...", "receiverCity": "Lahore",
  "items": [...], "proofs": [],
  "nextAction": "START_PICKUP"
}] }
```

`nextAction` walks `START_PICKUP → ARRIVE_AT_PICKUP → CAPTURE_PICKUP_PROOF → START_DELIVERY →
ARRIVE_AT_DELIVERY → CAPTURE_DELIVERY_PROOF → NONE`.

**Send GPS pings** (a batch — phones buffer offline):

```
POST {{baseUrl}}/api/drivers/me/locations
```

```json
{ "pings": [
  { "lat": 31.5204, "lng": 74.3587, "accuracyM": 12, "speedMps": 8.3, "headingDeg": 90 },
  { "lat": 31.5210, "lng": 74.3601 },
  { "lat": 31.5218, "lng": 74.3625 }
] }
```

```json
{ "accepted": 3 }
```

**Then switch back to `{{token}}`** and watch it on the console side:

```
GET {{baseUrl}}/api/drivers/locations/latest
GET {{baseUrl}}/api/drivers/{{driverId}}/trail?limit=100
```

```json
{ "data": [{ "driverId": "cm...", "name": "Ahsan Iqbal", "lat": 31.5218, "lng": 74.3625,
             "accuracyM": 8, "speedMps": 7.6, "headingDeg": 85, "recordedAt": "..." }] }
```

```json
{ "driver": { "id": "cm...", "name": "Ahsan Iqbal" }, "retentionDays": 7, "count": 3,
  "data": [{ "lat": 31.5204, "lng": 74.3587, "recordedAt": "...", "consignmentId": null }] }
```

The trail is **oldest first** — feed it straight to a map polyline. `latest` is newest per driver.

### 9.5 Uploading proof of delivery

This is the only multipart request, and the only one Postman handles differently.

The order must be at **`AT_PICKUP`** (for the pickup leg) or **`AT_DELIVERY`** (for delivery).

```
POST {{baseUrl}}/api/consignments/{{consignmentId}}/pod/pickup
```

1. **Body** tab → select **form-data** (not raw)
2. Add a key `photo` → hover the row → change the type dropdown from **Text** to **File** → choose a JPEG
   or PNG
3. Add a key `signature` → also **File** → choose an image
4. **Do not** set a `Content-Type` header yourself — Postman must generate the multipart boundary
5. Authorization: `{{token}}` (operator) or `{{driverToken}}` (the assigned driver)

Returns **201**:

```json
{ "proof": [{
  "leg": "PICKUP",
  "capturedAt": "2026-08-15T06:53:08.712Z",
  "capturedByDriver": { "id": "cm...", "name": "Ahsan Iqbal" },
  "photo":     { "mime": "image/png", "bytes": 70, "url": "https://...supabase.co/storage/v1/object/sign/pod/...?token=..." },
  "signature": { "mime": "image/png", "bytes": 70, "url": "https://...?token=..." },
  "replacedAt": null,
  "expiresInSeconds": 300
}] }
```

Paste a `url` into a browser — the image loads. Wait five minutes and it stops working: the bucket is
private and those links are short-lived.

Now `GET /api/consignments/{{consignmentId}}` and check `status` is **`PICKED_UP`** and `pickedUpAt` is
set. **That is the whole point** — you never called a status endpoint.

Optional header `Idempotency-Key: any-string`. Send the same request twice with the same key and the
second returns **200 with the original proof** instead of a 409 — what a phone does when the response is
lost.

### 9.6 Things worth trying that should fail

Half of understanding this API is seeing it refuse things. Each of these is a rule, not a bug:

| Try | Expect | Why |
|---|---|---|
| `PATCH /status` with `"DELIVERED"` | **400** | proof is the only route to that state |
| `POST /consignments` with `"status": "DELIVERED"` | **400** | strict body; status is server-owned |
| `POST /consignments` with `"items": []` | **400** | a job must carry something |
| `PUT /consignments/:id` on an order past `ASSIGNED` | **409** | the record is history now, not a draft |
| Same `clientReference` twice for one client | **409** | unique per client |
| Same `clientReference` for a *different* client | **201** | that is allowed on purpose |
| POD upload while status is `ASSIGNED` | **409** | wrong moment |
| POD upload twice on one leg | **409** | one proof per leg |
| Upload a PDF renamed `.png` | **400** | magic bytes are checked, not the file name |
| Driver token on `GET /api/consignments` | **403** | drivers never see the whole book of work |
| Driver token on another driver's order | **403** | ownership, not just role |
| A nonexistent order id with a driver token | **403** (not 404) | so a driver cannot probe which ids exist |
| Any request with no `Authorization` header | **401** | |

### 9.7 Postman vs the test suite

Both hit the same API. They answer different questions.

| | **Postman** | **`npm test` (Vitest + Supertest)** |
|---|---|---|
| Who judges the result | **You**, reading the JSON | The code, via `expect(...)` |
| Needs a running server | Yes — `npm run dev` | No, it loads the Express app in-process |
| Data afterwards | **Left behind** in the shared database | Truncated before every test |
| Repeatable | Only if you remember what you clicked | Identical every run |
| Runs in CI | No | Yes |
| Catches a regression next month | No | Yes — that is the entire point |
| Good for | exploring, debugging, demoing, checking a deployed environment | proving nothing broke |
| Coverage | whatever you happen to click | 122 cases including every rule in §9.6 |

The practical distinction: **Postman tells you what the API does right now. The test suite tells you
whether it still does what it did last week.**

A concrete example from this project — three real bugs were found by the test suite that manual clicking
had missed: every GPS ping in a batch getting an identical timestamp (so "latest position" was arbitrary),
an ownership guard returning 404 in one case and 403 in another (letting a driver probe for real order
ids), and a status change silently sending an empty item list. None of those are visible by eye in a single
response; all three were caught the moment something asserted the expected value.

They are complements, not alternatives:

- **Reach for Postman** when you are building the driver app and want to see the exact JSON, when something
  behaves oddly and you want to poke at it, or when checking a deployed environment is alive.
- **Reach for the suite** before you commit, and any time you change a rule — the rules live in
  `tests/statusFlow.test.ts` and `tests/drivers.test.ts` as executable statements.

> Postman *can* assert, in the Scripts tab:
> ```js
> pm.test("status became PICKED_UP", () => {
>   pm.expect(pm.response.json().status).to.eql("PICKED_UP");
> });
> ```
> That is worth doing for a collection you run repeatedly. It still leaves data behind and still needs a
> live server, so it does not replace the suite.

---

## 10. Tests — 17 suites

```bash
npm test
```

> ### ⚠️ The suite wipes the database it runs against
> `cleanConsignments()` truncates consignments, items, events, proofs, locations and counters **before each
> test**, and `seedReference()` leaves `TCA`/`TCB` clients and `test-driver-*` rows behind.
>
> **On a shared team database this destroys everyone's data**, including work a colleague created by hand
> that no seed can rebuild. Point tests at a scratch project first — see
> [Working as a team](#working-as-a-team). If you do run it by accident, `npm run seed` restores the 9 demo
> orders and nothing else.

| Suite | Covers |
|---|---|
| `statusFlow` | pure unit: every edge, every gate; `PICKED_UP`/`DELIVERED` unreachable manually |
| `orderNo` | 20 concurrent creates → 20 distinct numbers |
| `auth` | login, `/me`, bad tokens |
| `consignments` | create/list/get/update, client scoping, strict-body rejection, item keyed diff, edit window |
| `assignment` | assign / swap / unassign, 409 boundaries, `activeLoad`, the driver-status invariant |
| `pod` | **against real Supabase Storage**: both legs, signed URLs resolve, spoofed mime rejected, oversize 413, idempotent replay |
| `drivers` | roster, sessions, work list scoping, `nextAction`, and every ownership rule |
| `locations` | batch pings, coordinate bounds, clock skew, the live/history split, trail ordering and windowing |
| `chat` · `chatAttachments` | conversations, membership, paging, replay-safe sends; uploads against real Storage |
| `chatRls` · `mapRealtime` | the Realtime policies themselves — who may join which topic, and that no policy on `realtime.messages` is non-SELECT |
| `map` | pins, facet counts, tab partitioning, the unmappable/truncated meta |
| `nearestDrivers` · `driverRoute` | ranking and the drawn line, **written to pass with or without OSRM** |
| `routes` | bulk assign partial failure, planning, reorder as a permutation, version conflicts, optimise-as-preview, derived stop issues |

`vitest.config.ts` sets `fileParallelism: false` — the suites share one database.

**Suites that need OSRM check for it rather than assuming it.** `nearestDrivers`, `driverRoute` and
`routes` each detect an unreachable engine and assert the documented degraded behaviour instead of
failing, so the suite still passes on a machine without a routing binary. The cost is that a happy path
can silently skip — when changing routing, verify against a running engine, not only against green ticks.

The test count moves as features land. Run it rather than trusting a number written here.

---

## 11. Deliberate omissions

Named so they read as decisions, not oversights:

- **No `CANCELLED` / `FAILED` states** — user's explicit choice; append-only to add.
- **No finance** — no money columns anywhere. `lineTotal`, COD and shipping fee exist in the frontend form
  and are not sent.
- **No item dimensions or cubic volume** — weight and package type only.
- **No server-side geocoding** — coordinates arrive from the client, already resolved. Adding a
  backend geocoder would put a rate-limited external call inside the create transaction.
- **No self-service password change** — an admin resets passwords from the Users screen. `/api/users` is
  admin-only, so an operator cannot change their own; adding it means a new endpoint.
- **No bulk assign** — the API assigns one order per request; the UI disables multi-select with a reason.
- **No delete endpoint for orders** — they are operational history. (Users and drivers *can* be deleted,
  under the rules in §3.)
- **No Realtime** — the console polls. Now unblocked: users hold real Supabase identities, so an RLS
  policy can use `auth.uid()`. See the RLS note in §5.
- **No storage reaper** — deterministic paths bound the damage, but nothing prunes objects for deleted
  orders.
