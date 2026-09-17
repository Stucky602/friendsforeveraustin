# ARCHITECTURE.md

Working name: **The Room**. Kevin names it. Repo root doc; everything else derives from this. Interface-level detail (routes, schemas, normalization, tests) lives in `CONTRACTS.md`.

This document covers only the decisions that are expensive to retrofit. Everything derivable is listed in §7 as a contract for the build pass, not designed here.

Scope reminder (drift check): personal, not work, not LTB. Kevin plus friends, wife included, friends-of-friends allowed. Occasional use on his terms. No real-time gameplay.

---

## 0. Stack (settled, not debated)

- One Cloudflare Worker: serves the built PWA as static assets, exposes the API, runs the cron. Same shape as `survivors`.
- D1 (SQLite) is the only store of truth. Migrations are pasted into the D1 console by hand: single-line statements, no `--` comments, no trailing whitespace.
- Map: MapLibre GL JS with OpenFreeMap vector tiles. No API key, no registration, no request limit, attribution inserted automatically. Escape hatch if it ever goes away: PMTiles on R2 (needs the pmtiles CLI once, so not the starting point).
- Geocoding: US Census Bureau geocoder. Free, no key, batch up to 10,000. Geocode **places**, never events.
- Classification/enrichment: Workers AI for the cheap pass, Anthropic key for the good pass, with the survivors pattern: visible spend meter, hard monthly cap, never reprocess.
- Tests run inside `npm run build` on Cloudflare, not on GitHub Actions. A red test takes the site down; that is the gate.
- Always-load-newest: network-first for `index.html`, hashed asset filenames, version check on window focus. Required in every Kevin app; Opus implements.
- No CLI anywhere in the workflow. Dashboard build command: `npm run build && npx wrangler deploy`. `wrangler.jsonc` carries the assets binding and the D1 binding; `.assetsignore` lists `node_modules`, `tests`, `config`.

---

## 1. Data model

### 1.1 The one ruling under everything

**Aggregates are public. Identities are gated.** Every table below follows it. "4 interested" is visible to the whole room. *Which* four is visible only across a mutual edge (§2).

### 1.2 Entities

`room`
- `id`, `name`, `owner_person_id`, `bar`, `created_at`
- `bar`: the score threshold for §3.5, default 25, owner-editable. It gates the night read only; the upcoming list ignores it, because a browse view that hides things is not a browse view.
- One room for now. The table exists so a second friend group is a row, not a rewrite.
- Creation order: insert room with null owner, insert the owner person, update room. The circularity is deliberate.

`person`
- `id`, `room_id`, `display_name`, `token_hash`, `groups`, `kid_ages`, `default_view`, `visibility`, `removed_at`, `created_at`
- `groups`: set drawn from `{foodie, kids, odd}`. A person can be in several. Kevin is at least two.
- `visibility`: `mutual | public`, default `mutual`. A person who sets `public` lets everyone in the room read their gated fields without a mutual edge. Reads only; see §2.5. Reversible at any time, and because the gate is computed at read time, flipping back re-gates on the next request.
- `kid_ages`: optional list of ints. Drives the kids filters. **Gated.**
- `default_view`: one of `{foodie, kids, odd}`. See §3.
- `removed_at`: **removal is a timestamp, not a delete.** A removed person's token is dead, their `tick` rows are deleted in both directions (so no mutual edge survives), their vouches stay as anonymous count contributions, their `plan_member` rows stay for history, and their name no longer appears on the roster. Nothing cascades. Rows are cheap; a broken history is not.
- No `home_anchor` column. Home anchor never leaves the device. See §1.4.

`place` **(first-class, always)**
- `id`, `name`, `address`, `lat`, `lng`, `neighborhood`, `groups`, `canonical_key`, `geocode_source`, `geocoded_at`, `created_by`, `merged_into`, `created_at`
- `canonical_key`: deterministic normalization of `name|address` (rules in `CONTRACTS.md` §3). Two sources naming the same venue resolve to one row.
- `groups`: optional. A playground is a `kids` place; a taco stand is a `foodie` place. Set by pipeline or by the first voucher.
- `created_by`: `pipeline` or a `person.id`. A long-press on the map creates a place.
- `neighborhood`: derived once at geocode time by point-in-polygon against a static GeoJSON checked into the repo (`config/neighborhoods.geojson`). The Census geocoder returns no neighborhoods and no external service is called for them. Seed from the City of Austin planning-area boundaries plus hand-drawn rings for Cedar Park, Leander, and Round Rock, which the city file does not cover. A place outside every polygon gets `null`, not a guess.
- A place is never deleted. It can be merged: loser gets `merged_into`, every foreign key is repointed by the merge job, loser's `canonical_key` is kept so the same duplicate cannot be recreated.

`event`
- `id`, `place_id` **(required)**, `title`, `starts_at`, `ends_at`, `groups`, `answers`, `score`, `status`, `reject_reason`, `dedupe_key`, `raw`, `first_seen`, `last_seen`
- `raw`: JSON of the listing text the pipeline extracted (description, price text, venue name, source group hint). Kept because classification is retried, and re-fetching a page to reclassify would be a second scrape of someone else's site.
- **Ruling: an event with no resolvable place does not exist in this app.** The map is the primary surface; an unplaceable event is invisible anyway. The pipeline drops them and counts the drops.
- Source and listing URLs are **not** on this table. They live on `event_source`, one row per listing.
- `groups`: set from `{foodie, kids, odd}`, from classification. **An event whose classification yields an empty set is set `status = rejected`, `reject_reason = no_group`.** It is not left live-but-invisible; invisible-but-live is how pipelines lie.
- `answers`: JSON. The four questions nobody's listing answers: `cost`, `parking`, `loud`, `kid_ok`. Each is `{value, confidence, evidence}`; `evidence` is a verbatim substring of the listing or empty, never invented. Schema in `CONTRACTS.md` §2.
- `status`: `live | expired | rejected`. **Rejected is a status, not a deletion.** It is how never-reprocess holds.
- `reject_reason`: `mute | no_place | no_group | manual | duplicate | withdrawn`. Every rejection says why. Kevin will ask.
- **Withdrawn:** a `live` event whose date is still ahead and which no source has listed for 7 days is set `rejected / withdrawn`. A cancelled show still showing as live is the single worst outcome for a plan, so the pipeline treats a listing that vanishes as a signal, not noise. Any plan pointing at it shows the one-line notice (§5.9). If the listing reappears, the event returns to `live`; never-reprocess applies to classification, not to status.
- **Expiry:** an event becomes `expired` at `ends_at`, or `starts_at + 6h` when there is no end. Same window as plan completion (§5.6) so the two never disagree about whether a night is over. Expired events are never deleted; they are the past tense of the calendar.
- `score`: **one number per event, room-wide, never per viewer.** Personalization comes from the view preset (§3) and from interest counts, not from a personal score. A personal score would have to be computed at read time for every viewer and could never be a column; a room-wide score is a column and a sort. Inputs, weighted by Opus: source fit (institutional calendars over aggregators), number of groups matched, mean answer confidence, and whether the place already has vouches.
- `dedupe_key`: `place_id|YYYY-MM-DD|norm(title)`, deterministic, declared UNIQUE. Fuzzy matching is a separate *attach* step that decides which existing event a new listing belongs to; it never feeds the key.

`event_source`
- `event_id`, `source`, `source_id`, `source_url`, `seen_at`
- Primary key `(source, source_id)`. One event, many listings. Provenance without duplication.
- `source`: `do512 | do512family | chronicle | apl | alamo | museum:<slug> | manual`.

`vouch`
- `place_id`, `person_id`, `line`, `created_at`
- Primary key `(place_id, person_id)`. One sentence. Permanent. Re-vouching updates the line.
- Count is public. Voucher identity is gated.
- **A vouch is a position, a review is a visit.** A vouch is undated, one per person per place, and it is what the pin counts. A review is dated, many per person per place, and carries a verdict. Merging them would either inflate the vouch count with every good night out or freeze reviews into permanence. Both stay.

`review`
- `id`, `place_id`, `person_id`, `visited_on`, `verdict`, `text`, `created_at`, `updated_at`
- `visited_on`: `YYYY-MM-DD`, optional. A review is a record of a specific visit; this is the past-tense layer for places, the same way `went` is for events.
- `verdict`: `loved | fine | bounced`. Kevin's existing three-level vocabulary from the survivors tracker, reused on purpose.
- `text`: any length. Text only. No photos (§6).
- **Negatives are allowed here.** The no-visible-negative rule (§2, §5.4) protects people from each other. A `bounced` on a taco stand hurts nobody in the room. Places are not friends.
- Public: `review_count` and the verdict tally `{loved, fine, bounced}` per place. Gated: who wrote it, the text, and `visited_on` (a date is whereabouts).
- Own rows only for edit and delete. Delete is a real delete; they are the person's own words.
- A removed person's reviews keep counting and become unreadable by anyone, because a removed person has no mutuals and is never public. No special case.

`interest`
- `person_id`, `target_type`, `target_id`, `created_at`, `refreshed_at`
- `target_type`: `event | place`. Interest in a place means "I'd go here sometime." Interest in an event means "I'd go to this."
- Primary key `(person_id, target_type, target_id)`.
- `refreshed_at` is what decay reads. Old interest dims; near the date the app re-asks. Behavior is Opus scope; the column is not.
- There is **no decline row**. Absence of interest is the only negative, and it is never displayed.

`tick`
- `from_person_id`, `to_person_id`, `created_at`
- Directed. "From ticked to." **No pending state exists anywhere in the schema.** Mutual is derived, never stored (§2).

`availability`
- `id`, `person_id`, `kind`, `start_date`, `end_date`, `note`
- `kind`: `free | away`. `away` is the block (dims you on the calendar). `free` is the flare ("I'm around Thursday"). Occasional use means `away` is the common entry; `free` is opt-in. Both gated.

`plan`
- `id`, `room_id`, `owner_person_id`, `target_type`, `target_id`, `starts_at`, `status`, `created_at`, `done_at`
- `status`: `open | done | dropped`. Lifecycle in §5.

`plan_member`
- `plan_id`, `person_id`, `state`, `updated_at`
- `state`: `maybe | in | out | went`.
- **History derives from plans.** `status = done` plus `state = went` is the been-there layer. There is no separate attendance table.

`prompt_seen`
- `person_id`, `place_id`, `created_at`
- The once-per-(person, place) record behind the vouch prompt (§5.6). Written the first time the prompt is shown, whether or not they vouch. Without a row the prompt cannot be once-only across two devices.

`mute`
- `room_id`, `category`
- Room-level permanent rejects applied at ingest. Seed: `live_music`, `concert`. Applied by a cheap rule before any model call. Un-mutable later without a migration.

### 1.3 Ids, time, constraints

- All ids are text ULIDs generated in the Worker.
- All timestamps UTC ISO 8601 in the store. The client renders America/Chicago. Dates for `availability` are plain `YYYY-MM-DD`. The date component of `dedupe_key` is the **Chicago** date, because a 12:30am show is "tonight" to everyone in the room.
- **No FOREIGN KEY constraints are declared.** D1 does not enforce them by default and the merge job repoints keys by hand. Referential integrity is a test (`CONTRACTS.md` §5), not a constraint.

### 1.4 What never leaves the device

- **Home anchor** (lat/lng used for drive time). Stored in IndexedDB only. Never sent to the API. Drive-time rings are computed client-side.
- **The raw token.** The server holds only `token_hash`.

### 1.5 Initial schema (paste-ready for the D1 console)

```
CREATE TABLE room (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_person_id TEXT, bar INTEGER NOT NULL DEFAULT 25, created_at TEXT NOT NULL);
CREATE TABLE person (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, display_name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, groups TEXT NOT NULL DEFAULT '[]', kid_ages TEXT, default_view TEXT NOT NULL DEFAULT 'odd', visibility TEXT NOT NULL DEFAULT 'mutual', removed_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE review (id TEXT PRIMARY KEY, place_id TEXT NOT NULL, person_id TEXT NOT NULL, visited_on TEXT, verdict TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE place (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT, lat REAL, lng REAL, neighborhood TEXT, groups TEXT NOT NULL DEFAULT '[]', canonical_key TEXT NOT NULL UNIQUE, geocode_source TEXT, geocoded_at TEXT, created_by TEXT NOT NULL, merged_into TEXT, created_at TEXT NOT NULL);
CREATE TABLE event (id TEXT PRIMARY KEY, place_id TEXT NOT NULL, title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT, groups TEXT NOT NULL DEFAULT '[]', answers TEXT NOT NULL DEFAULT '{}', score INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'live', reject_reason TEXT, dedupe_key TEXT NOT NULL UNIQUE, raw TEXT NOT NULL DEFAULT '{}', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
CREATE TABLE event_source (event_id TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL, source_url TEXT, seen_at TEXT NOT NULL, PRIMARY KEY (source, source_id));
CREATE TABLE vouch (place_id TEXT NOT NULL, person_id TEXT NOT NULL, line TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (place_id, person_id));
CREATE TABLE interest (person_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL, refreshed_at TEXT NOT NULL, PRIMARY KEY (person_id, target_type, target_id));
CREATE TABLE tick (from_person_id TEXT NOT NULL, to_person_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (from_person_id, to_person_id));
CREATE TABLE availability (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, kind TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, note TEXT);
CREATE TABLE plan (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_person_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, starts_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, done_at TEXT);
CREATE TABLE plan_member (plan_id TEXT NOT NULL, person_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (plan_id, person_id));
CREATE TABLE mute (room_id TEXT NOT NULL, category TEXT NOT NULL, PRIMARY KEY (room_id, category));
CREATE TABLE prompt_seen (person_id TEXT NOT NULL, place_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (person_id, place_id));
CREATE INDEX idx_event_starts ON event (status, starts_at);
CREATE INDEX idx_event_place ON event (place_id);
CREATE INDEX idx_interest_target ON interest (target_type, target_id);
CREATE INDEX idx_tick_to ON tick (to_person_id);
CREATE INDEX idx_availability_person ON availability (person_id, start_date);
CREATE INDEX idx_plan_member_person ON plan_member (person_id);
CREATE INDEX idx_review_place ON review (place_id);
CREATE INDEX idx_review_person ON review (person_id);
```

---

## 2. The visibility rule

### 2.1 One predicate

```
mutual(viewer, p)  = tick(viewer, p) AND tick(p, viewer)
visible(viewer, p) = (p == viewer) OR (p.visibility == 'public') OR mutual(viewer, p)
```

That is the entire rule. Self is always visible. A person who has opted to be public is visible to the whole room (§2.5). Otherwise mutual, derived at read time from `tick`. It is never cached in a column, never stored as a "friendship" row, and there is no request, no pending, and no decline. You tick people. If they ticked you, the edge exists. **Nobody is ever told they were not ticked**, and the API never returns a "they ticked you" boolean; you learn the edge exists only because gated fields start arriving.

**The room owner has no extra read access.** Owner is a roster-management role (create, regenerate, remove, mute). If the owner is not mutual with someone, the owner sees exactly what any non-mutual sees. The admin role is not a privacy hole.

### 2.2 What it gates

| Data | Ungated (whole room) | Gated (mutuals, or anyone if the subject is public) |
|---|---|---|
| Roster display names (not removed), and whether each person is public | yes | |
| Interest count on an event or place | yes | |
| Vouch count on a place | yes | |
| Review count and verdict tally on a place | yes | |
| Which people are interested | | yes |
| Who vouched, and the vouch line | | yes |
| Who reviewed, the text, and `visited_on` | | yes |
| Availability (free and away) | | yes |
| Kid ages | | yes |
| Plans (existence, contents) | | **members only**, stricter than mutual, unaffected by public |
| History / been-there | | yes (derived from plans) |
| Home anchor | never | never |

**Plan membership is its own disclosure.** Members of a plan see each other's names and states within that plan, even if two members are not mutual with each other. Nothing else is disclosed by membership: not availability, not kid ages, not history. The owner can only add their own mutuals, so every member is mutual with the owner; they need not be mutual with each other.

### 2.3 Enforcement is architectural, not disciplinary

- The Worker is the only reader of D1. The client never receives gated rows and filters locally. **Filtering happens in the query, so ungated rows are never loaded**, not stripped after the fact.
- Every route that can return person-level data goes through one module, `src/lib/gate.js`, which owns the `visible(viewer, p)` join. No route writes its own visibility check. This is the LTB privacy-wall pattern: one wall, everything routed through it.
- `tests/visibility.test.js` is mechanical and mandatory: for every API route, a non-mutual viewer receives a response containing **zero** gated fields for a `mutual`-visibility subject, a mutual viewer receives them, the owner-as-non-mutual receives zero, and any viewer receives them for a `public` subject. Add a route, add it to the test. The test runs inside the Cloudflare build, so a leak cannot deploy.
- A lint asserts no file outside `gate.js` queries `tick`, `availability`, `review`, `plan`, `plan_member`, or the `kid_ages` column directly.

### 2.4 Why counts stay public

Social proof is the product. "4 interested" is what makes someone open the card. Gating counts would make the room feel empty to newcomers, which defeats friends-of-friends. Gating identities is what keeps it from being creepy. Both, uniformly, is the rule.

### 2.5 Opting out of the gate

A person can set their own `visibility` to `public`. The rules:

- **It widens reads and nothing else.** Everyone in the room can read that person's gated fields. It does not let anyone add them to a plan; plan membership still requires a mutual edge, because being put on the hook for a Saturday is a social act and the mutual tick is the consent for it. Public means "you may see my stuff," not "you may commit me to things."
- **It is one-directional.** A public person still sees other people only through the normal rule. Kevin being public does not show Kevin anything about Dana.
- **The roster says who is public.** A small "open" label. Without it, a newcomer cannot tell why they can see one person's calendar and not another's, and unexplained asymmetry reads as a bug.
- **Ticking a public person still matters.** It does nothing for reading (already visible), but it is half of the edge that makes plans possible.
- **Removal wins.** `removed_at` makes a person invisible regardless of `visibility`.
- **Default is `mutual`.** Nobody is public by accident. Setting it is one toggle on the person's own row with one plain sentence explaining what it does.

This is the mechanism that makes reviews useful to friends-of-friends: a person who wants their reviews readable by the whole room goes public. The two features justify each other.

---

## 3. Group type is a view, not a filter

### 3.1 The ruling

There are exactly three named views: **foodie, kids, odd.** A person has a `default_view` and can switch with one tap. The three groups share one dataset and one set of tables; what differs is what the home screen *is*.

A person's `groups` (what they're into) and `default_view` (what they see first) are separate. Kevin can be in `foodie` and `odd` and default to `odd`.

### 3.2 What a view changes

| | foodie | kids | odd |
|---|---|---|---|
| Map default time window | none (places, not events) | this weekend, daytime | next three weeks |
| Map default pins | vouches, been-there, `foodie` places | `kids` events and `kids` places | `odd` events |
| Calendar default | de-emphasized; "who's around" strip only | week view | month view |
| Sort | vouch count, then `loved` reviews, then distance | start time | score |
| Answers surfaced first | cost | kid_ok, cost | cost, loud |

Everything not in this table is identical across views. If a fourth view is ever needed it is a row in a config object, not a code path.

### 3.3 Why not a filter

A filter on a shared feed produces a feed that is wrong for all three groups: the foodie has no time axis, the kids parent has a Saturday-morning window and hard constraints, the odd-screening person plans three weeks out from a short curated list. Same data, three shapes. Deciding this now costs one config object. Deciding it later costs three rewrites.

### 3.4 Room-level mutes are global, not per view

`mute` (§1.2) applies at ingest, before classification, before any model call. Live music and concerts never enter `event` as `live`. This is the single largest cost saver in the pipeline and it is not a preference; it is a room rule.

### 3.5 The Thursday read

This is the one behavior that justified putting who's-free, the vouch map, and the calendar in one app. It is a single server-side read, `GET /api/night?date=&view=`, and it is defined here so it cannot be rebuilt as three tabs that never join.

Given a date and a view, in order:

1. **Who.** Visible people (§2.1) with no `away` block covering the date, listing separately those with a `free` flare on it. Non-visible people are not counted, not even anonymously; "3 people are free" from people you cannot see would be a leak by aggregate.
2. **What's on.** `live` events on that Chicago date whose `groups` intersect the view, with `score >= bar`, sorted by the view's sort. `bar` is a room constant (start at 50) exposed in settings, not a magic number.
3. **Fallback.** If step 2 returns nothing, vouched places whose `groups` intersect the view (or all vouched places for `foodie`), sorted by vouch count then `loved` reviews, limited to those within the viewer's drive-time ring **computed on the client**, because the home anchor never reaches the server (§1.4). The server returns the candidate list with coordinates; the client trims it.
4. **Plans.** Any open plan the viewer is a member of on that date, pinned above everything.

The response is one object with those four parts. Every tab can render it: the map as pins, the calendar as a day, the People tab as the who-strip. It is the answer to "I've got Thursday, what do we do," and nothing on any screen is allowed to answer that question a different way.

---

## 4. Identity and recovery

### 4.1 No login, no room code

- Each person has one **token**: 128 bits of randomness, base32, 26 characters, generated when the room owner creates the person.
- The server stores only `sha256(token)` in `person.token_hash`.
- The personal link is `https://<app>/#/join/<token>`. **Fragment, never path or query**, so the token never appears in server logs. This rule has one known consequence, §4.8.
- On first open the client stores the token in `localStorage` with an IndexedDB mirror, then strips the fragment from the URL.
- Every API call sends `Authorization: Bearer <token>`. The Worker hashes it, looks up the person, and gets the room. No sessions, no cookies, no anonymous auth provider.
- **There is no room code.** The personal link implies the room. This is one mechanism, not two.

### 4.2 Onboarding is a group text

The room owner creates people by name. Each gets a link. The owner texts each person their own link. They tap once. Done. The link stays in their text thread forever, which is the ordinary recovery path.

### 4.3 Second device

Settings shows the raw token as a copyable code and a QR of the personal link. Same token, both devices. No merge problem because the server is truth and the device is a cache.

### 4.4 Real recovery

Lost phone with the link gone too: the room owner regenerates that person's token. Old hash is replaced immediately; the old device's next request gets `401 {error: "token"}` and the client shows one plain sentence: ask the room owner for a new link. Only the owner can regenerate.

### 4.5 Who can add people

**Room owner only, for now.** Friends-of-friends come in by Josh asking Kevin. This is a deliberate bottleneck that keeps the roster curated. It is the first thing to relax if it chafes; relaxing it is a permission bit, not a redesign.

### 4.6 The tradeoff, stated

The token is a bearer credential with no expiry. Forward the link and the recipient becomes you. For a friends-only app whose most sensitive data is "Josh is out of town next week" and whose gated data is already limited to mutuals, this is accepted. Mitigations: fragment-only transport, hashed at rest, owner regeneration. This is a decision, not an oversight.

### 4.7 Client cache

The client caches the last event set, places, own interest rows, and own plans in IndexedDB so the map opens instantly and offline. Server is truth; client re-reads on focus and after any write. Same rule as FlixPix realtime: the cache is an accelerator, never a source of truth. **Reads work offline. Writes require network.** There is no offline write queue; an occasional-use app does not earn conflict handling.

### 4.8 Consequence: no calendar subscription URL

An iCal *subscription* URL would have to carry the token in the query string, which §4.1 forbids. So calendar export is a **one-shot download** fetched by the app with the bearer header and saved as `.ics`. No subscription. If a subscription is ever wanted it needs a separate read-only calendar token, which is a new mechanism and a new decision, not a shortcut.

### 4.9 First open

The link is tapped from a group text, on a phone, by someone who has not asked for this app. The first screen decides whether there is a second one. It asks exactly three things, on one screen, each answerable with a tap: which of the three groups they're in (multi), which view to start on (defaults to the first group picked), and the `Open to everyone` toggle (default off, with its one sentence from `CONTRACTS.md` §7). Then the map. No tour, no walkthrough, no "get started." Everything else on their own row (kid ages, availability) is discovered later from the People tab, when they need it.

---

## 5. Plan lifecycle

### 5.1 What a plan is

A target (one event or one place), a `starts_at`, an owner, and members with states. Plans are visible to members only (§2.2). A plan is the only object in the app where anyone commits to anything.

### 5.2 Creation

- **Any member can create a plan from any event or place. No threshold.** The organizer in a friend group should never be told there isn't enough interest yet.
- The app *suggests* promotion when an event reaches 3+ interested among the viewer's mutuals. A suggestion is a button, not a gate.
- Creator becomes owner and enters as `in`.
- Owner adds members from their own mutuals only. Added members enter as `maybe`.
- `starts_at` defaults to the event's start for event plans; the owner sets it for place plans. It is always the plan's own column, never derived at read time. If an event's start later diverges from the plan's, the plan shows a one-line notice; it does not silently follow.

### 5.3 Member states

```
maybe -> in
maybe -> out
in    -> out
out   -> in
in    -> went      (automatic on done, §5.6)
went  -> out       (self-correction after the fact)
maybe -> maybe     (silence on done; they never said)
```

- A member can change their own state at any time while the plan is `open`.
- The owner can add and remove members. Removing a member deletes their `plan_member` row; they lose visibility of the plan.
- A member cannot remove themselves. `out` is how you leave; it keeps the history honest.

### 5.4 The one visible negative in the app

Inside a plan, `out` is visible to all members. This is the deliberate exception to "nobody sees a decline." The ambient layer (interest, availability) shows no negatives because nobody is accountable there. A plan is the opposite: someone is booking a table and needs a headcount. The two rules are not in tension; they apply to different objects.

Softening, in copy: `out` renders as "can't make it." There is no reason field and there never will be.

### 5.5 The re-ask

Within 48 hours of `starts_at`, on open, members in `maybe` or `in` see the plan pinned at the top of the app with their current state and the two buttons. That is the entire mechanism. **Silence changes nothing**: an `in` who does not re-confirm stays `in`, a `maybe` stays `maybe`. There is no push channel, so this happens only when they open the app, which is fine, because the people who open the app are the people who come.

### 5.6 Done

- A plan becomes `done` automatically at `starts_at + 6h` (cron, or lazily on next read, whichever comes first). `done_at` is set.
- On done, every `in` becomes `went`. `maybe` and `out` are untouched.
- **Optimistic history.** Yes, this records a flake as attendance if nobody corrects it. The alternative is an empty history because nobody confirms anything in an occasional-use app. Anyone can flip themselves `went -> out` afterward, and the correction is one tap.
- After a person's first `went` at a place **or** their first `loved` review of it, whichever comes first, the app offers "vouch for this place?" **once per (person, place)**, never again. This is how the vouch map seeds itself from real attendance instead of launching empty. The done screen also offers "review this place?" with the three verdicts; that one is offered every time, because every visit is a visit.

### 5.7 Dropped

Owner only, manual. No auto-drop when interest evaporates; the owner decides. Dropped plans keep their rows and disappear from members' views. Explicit action over background automation, per Kevin's standing preference.

### 5.8 The pasteable block

`GET /api/plans/:id/text` returns plain text, and the plan screen has one Copy button. Format is fixed:

```
Sat Sep 26, 7:00 PM
Terror Tuesday: The Cat
Alamo Drafthouse South Lamar, 1120 S Lamar Blvd
In: Kevin, Josh. Maybe: Dana.
$10 · lot parking · loud
https://<app>/#/plan/<plan_id>
```

- Line 5 is the four answers, only those with `confidence >= 0.6`, only the ones the plan's view surfaces first (§3.2). Unknowns are omitted, never printed as "unknown."
- The link opens the plan for members (they already have their token on device) and shows nothing to anyone else. No token in the link.
- This block is the app's actual output. It is what goes into the group text, which is where plans happen.

### 5.9 Interactions

- **Calendar:** plans appear on every member's calendar in a distinct style. The `.ics` download (§4.8) includes plans the person is `in` for.
- **Map:** a plan's place shows a "planned" pin state for members while the plan is `open`.
- **Events:** if the target event later becomes `rejected` or `expired`, the plan persists and shows a one-line notice. No cascade, ever.
- **Removal (§1.2):** a removed person's `plan_member` rows stay; their name renders as "someone" in old plans. History keeps its shape.

---

## 6. Explicitly NOT decided here (and should not be by Opus without asking)

- The app's name.
- Whether `groups` ever becomes a table.
- Any push or notification channel. There is none. Do not invent one.
- Any ranking of people against each other. There is none.
- A calendar subscription token (§4.8). Not now.
- Photos on reviews. That is an R2 bucket, an upload path, EXIF stripping, and a new privacy surface. Text only until someone actually asks.
- Reviews on events. Events pass; the place is what you would go back to, and `went` already records the night.

---

## 7. Contract for the Opus build pass

Everything below derives from §0–§5 and `CONTRACTS.md`. Build in this order. Each item is independently deployable and none is thrown away later.

1. **Repo skeleton**: Vite + React PWA (matches his other apps), `wrangler.jsonc`, `.assetsignore`, D1 binding, always-load-newest mechanism, the test gate wired into `npm run build`, `HANDOFF.md` per `CONTRACTS.md` §6.
2. **`src/lib/gate.js` and `tests/visibility.test.js`** before any route exists. The wall goes up first.
3. **Auth middleware**: bearer token → `person` → `room`. Owner-only routes for create-person, regenerate-token, remove-person, mute.
4. **People tab**: roster with the "open" label, tick, own row (groups, default_view, kid_ages, visibility, availability). This is "Who's Free" and it ships first because it is the only part that tests whether friends open the app at all.
5. **Places, vouches, and reviews**: place create (long-press on map), vouch upsert, review create/edit/delete with the three verdicts, Census geocode on create. Map tab with MapLibre + OpenFreeMap, vouch pins, been-there pins (empty until plans exist), place card with counts and tally, home anchor client-side, drive-time rings.
6. **Plans**: §5 in full, including the text block and the vouch-once and review prompts. Plans before the pipeline, because a plan from a vouched place is a complete product with zero scraped data.
7. **The Thursday read**: `GET /api/night` per §3.5, and the client's day panel that renders it. Built before the pipeline so it works on vouches alone; events simply start appearing in it once step 8 runs.
8. **Pipeline**: one adapter per source, in this order of fit: Do512 Family, Alamo Drafthouse, Austin Public Library, museum calendars, Kids Out and About, then Do512 main and the Chronicle last (highest volume, lowest yield). Mute rule → dedupe on `canonical_key` and `dedupe_key` → attach step → geocode new places once → classify into groups → extract the four answers → score. Reuse the survivors Runner (self-scheduling Durable Object draining one batch per alarm), spend meter, monthly cap, never-reprocess. Every stage has an explicit button; cron is a convenience on top. Cron on Cloudflare, not GitHub Actions.
9. **Map, full**: event pins, time scrubber (tonight / weekend / two weeks), view presets from §3.2, neighborhood mode, pin clustering.
10. **Calendar tab**: week and month views, availability overlay, plan overlay, backward-running, `.ics` download, annual layer as a static config to start.
11. **Interest**: tag, count display, gated names, decay dimming, re-ask near date.
12. **UI pass** per the design direction: schedule board, dense, monospace times, no hero images, neutral chrome, pins are the only saturated color, high contrast for sun. Tabs named Map, Calendar, People, Plans. Nothing that reads as Claude-styled.

Deliverable shape: one zip of the whole repo for the first push, deltas after, per Kevin's standing rule. Any zip that changes `package.json`'s test script carries every test file that script names.

---

## 8. Where this document lives

Repo root as `ARCHITECTURE.md`, beside `CONTRACTS.md`. Update this file when a §1–§5 decision changes; nothing else goes in it. Build-progress notes go in `HANDOFF.md`, not here.
