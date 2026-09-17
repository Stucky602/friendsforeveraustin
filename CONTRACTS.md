# CONTRACTS.md

Interface-level detail that both halves of the build (Worker and client) must agree on. Derived from `ARCHITECTURE.md`; if the two ever disagree, `ARCHITECTURE.md` wins and this file is wrong.

Everything here is a contract, not a suggestion. Opus builds to it. Changing a contract means editing this file first.

---

## 1. API

All routes: `Authorization: Bearer <token>`. No cookies, no sessions. The Worker hashes the token, resolves `person` (with `removed_at IS NULL`) and `room`, or returns `401 {"error":"token"}`. The client's only response to a 401 is one sentence: ask the room owner for a new link.

Markers: **[gate]** = response passes through `gate.js` and gated fields appear only for `visible(viewer, p)`. **[owner]** = `room.owner_person_id == viewer` or `403`. **[members]** = viewer must have a `plan_member` row or `404` (not 403; a plan you are not in does not exist to you).

The token is read from the `Authorization` header only. Never from path, query, or body. `tests/tokenTransport.test.js` asserts this.

### Bootstrap (one time)
- `POST /api/bootstrap` — no bearer; requires header `x-bootstrap-secret` equal to the `BOOTSTRAP_SECRET` Worker secret. Body `{room_name?, owner_name?}`. Creates the room and the owner, seeds mutes `live_music`, `concert`, returns `{room_id, person_id, link}`. `409` once any room exists. After bootstrap the secret can be deleted from the dashboard.

### Self
- `GET /api/me` → `{person, room, default_view, mutual_ids, version}`. Own row is complete (self is always visible). `mutual_ids` is the derived list; it exists so the client can render "edge lit" without ever seeing a one-directional tick.
- `PUT /api/me` body `{groups?, default_view?, kid_ages?, display_name?, visibility?}`. `visibility` ∈ `{mutual, public}`; any other value is `400`.

### People
- `GET /api/people` **[gate]** → roster of non-removed people: `{id, display_name, visibility}` for everyone (the `visibility` value is what renders the "open" label); plus `{groups, kid_ages, availability[]}` for visible people only.
- `PUT /api/tick/:person_id` → `204`. Idempotent. Response body is empty on purpose: it must not reveal whether the reverse tick exists.
- `DELETE /api/tick/:person_id` → `204`.

### Availability (own rows only)
- `GET /api/availability` → own rows.
- `POST /api/availability` body `{kind, start_date, end_date, note?}` → row.
- `DELETE /api/availability/:id` → `204`. `404` if not own.

### Places and vouches
- `GET /api/places?bbox=w,s,e,n&groups=` **[gate]** → places with `vouch_count`, `interest_count`, `review_count`, and `verdicts {loved, fine, bounced}` (all public), plus `vouchers[]`, `interested[]`, and `reviews[] {id, person_id, display_name, visited_on, verdict, text}` (gated, newest first, own reviews always included), `merged_into` never returned (merged places are resolved server-side).
- `GET /api/places/:id` **[gate]** → one place, same shape, full `reviews[]`.
- `POST /api/places` body `{name, address?, lat?, lng?, groups?}` → place. If `address` and no coords, the Worker geocodes synchronously via Census; on failure the place is created with null coords and `geocode_source = 'failed'` so it can be fixed, never silently dropped.
- `PUT /api/vouch/:place_id` body `{line}` → upsert, `204`.
- `DELETE /api/vouch/:place_id` → `204`.

### Reviews (own rows only for write)
- `POST /api/places/:place_id/reviews` body `{verdict, text?, visited_on?}` → review. `verdict` ∈ `{loved, fine, bounced}` or `400`. Many per (person, place) allowed.
- `PUT /api/reviews/:id` body `{verdict?, text?, visited_on?}` → review. `404` if not own.
- `DELETE /api/reviews/:id` → `204`. `404` if not own. Real delete.
- `POST /api/places/:place_id/vouch-prompt` → `{offer}`. Offers once per (person, place) when the viewer has `went` there or has a `loved` review there, has no vouch there, and has not been offered before; writing `prompt_seen` on the offer is what makes it once-only across devices.
- Reading reviews happens only through the place routes above; there is no `GET /api/reviews` and no per-person review listing, so nobody can pull one person's whole trail in a single request even when mutual.

### Events and interest
- `GET /api/events?from=&to=&view=&bbox=` **[gate]** → `status = 'live'` events with `place`, `answers`, `score`, `groups`, `interest_count` (public), `interested[]` (gated), `sources[]` (url only). `view` applies the §3.2 defaults server-side so the client's first paint needs no local filtering.
- `PUT /api/interest/:type/:id` → sets or refreshes (`refreshed_at = now`). `204`.
- `DELETE /api/interest/:type/:id` → `204`.

### Plans
Plan completion (§5.6) runs lazily at the top of every plan read and of `GET /api/night`, and on the cron; there is no separate endpoint for it.
- `GET /api/plans` **[members]** → plans the viewer is a member of, any status except `dropped`.
- `POST /api/plans` body `{target_type, target_id, starts_at?, member_ids[]}` → plan. Every `member_id` must be in the creator's `mutual_ids` or `400`. Creator is owner and `in`.
- `GET /api/plans/:id` **[members]** → plan with `members[] {person_id, display_name, state}` and the target.
- `PUT /api/plans/:id` **[members, owner of plan]** body `{starts_at?, add_member_ids?, remove_member_ids?, status?}`. `status` may only be set to `dropped`.
- `PUT /api/plans/:id/me` **[members]** body `{state}` where state ∈ `{in, out}` (and `went -> out` after done). `400` for any other transition.
- `GET /api/plans/:id/text` **[members]** → `text/plain`, the §5.8 block, exactly.

### The Thursday read
- `GET /api/night?date=YYYY-MM-DD&view=` **[gate]** → `{who: {around[], free[]}, events[], fallback_places[], plans[]}` per `ARCHITECTURE.md` §3.5. `around` and `free` contain only visible people. `fallback_places` is empty when `events` is non-empty. `fallback_places` carries coordinates and no distance; the client trims by its own drive-time ring.
- `GET /api/room` → `{bar, mutes[]}`; `PUT /api/room` **[owner]** body `{bar?}`. `bar` is an integer 0–100.

### Calendar
- `GET /api/calendar.ics` → `text/calendar`, one-shot, own `in` plans plus own event interests. Fetched by the app with the bearer header and saved. No subscription URL exists.

### Owner
- `POST /api/admin/people` **[owner]** body `{display_name, groups?, default_view?}` → `{person, link}`. The raw token appears in this response once and never again.
- `POST /api/admin/people/:id/regenerate` **[owner]** → `{link}`. Old hash replaced immediately.
- `POST /api/admin/people/:id/remove` **[owner]** → `204`. Sets `removed_at`, deletes ticks both directions. Nothing else changes.
- `GET /api/admin/mute` **[owner]**, `PUT /api/admin/mute` **[owner]** body `{categories[]}`.

### Pipeline (explicit buttons; cron calls the same handlers)
- `POST /api/run/:stage` **[owner]** where stage ∈ `{discover, dedupe, geocode, classify, score, expire, all}` → `202 {run_id}`.
- `GET /api/run/status` **[owner]** → per-stage counts, last run, errors, parked-until.
- `GET /api/run/spend` **[owner]** → month-to-date model spend, cap, remaining.

Scraping conduct, every adapter: identify with a fixed `User-Agent` naming the app and a contact address; honor `robots.txt`; at most one request every 3 seconds per host; cache each fetched page for 24 hours so a re-run never re-fetches; stop the stage on the first `429` or `403` and park it until the next cron, never retry in a loop. Getting a source blocked is a permanent loss; the polite rate is the cheap one.

Stage behaviors that are rules, not tuning: `expire` sets `expired` at `ends_at` or `starts_at + 6h`; `discover` updates `last_seen` on every listing it sees; a nightly `withdraw` pass (inside `expire`) marks `live` future events unseen for 7 days as `rejected / withdrawn` and restores them to `live` if seen again. `classify` skips any event that already has a non-empty `groups` (never-reprocess).

### Errors
`{"error": "<short_code>", "detail": "<plain sentence>"}`. Codes: `token`, `forbidden`, `not_found`, `bad_request`, `offline_write` (client-side only), `spend_cap`.

---

## 2. Model output schema (classify + answers)

One call per event. Input is the listing's title, description, venue name, source category, and price text. Output must validate against this before any write; an invalid response leaves the event `status = live, groups = []` and unclassified for the next run, never partially written.

```json
{
  "groups": ["foodie" | "kids" | "odd"],
  "reject": null | { "reason": "mute" | "no_group" },
  "answers": {
    "cost":    { "value": "free" | "$" | "$$" | "$$$" | "unknown",       "confidence": 0.0, "evidence": "" },
    "parking": { "value": "lot" | "street" | "garage" | "hard" | "unknown", "confidence": 0.0, "evidence": "" },
    "loud":    { "value": "quiet" | "normal" | "loud" | "unknown",        "confidence": 0.0, "evidence": "" },
    "kid_ok":  { "value": "yes" | "no" | "older" | "unknown",             "confidence": 0.0, "evidence": "" }
  }
}
```

Rules the prompt must state and the validator must enforce:
- `evidence` is a **verbatim substring** of the input text, or the empty string. Never a paraphrase, never inferred. Same ruling as the survivors `plans` stage: read, don't guess.
- `value = "unknown"` requires `evidence = ""` and `confidence <= 0.2`.
- `groups = []` and `reject = null` together is invalid; empty groups must come with `reject.reason = "no_group"`.
- The mute rule runs *before* this call. If the model still returns `reject.reason = "mute"`, the pipeline records it as `reject_reason = mute` and counts a miss against the cheap rule, so the rule can be tightened.

Two-tier cost pattern (from survivors): Workers AI 8B runs first; only events it marks `confidence < 0.5` on `groups` go to the Anthropic model. Spend meter and monthly cap apply to the second tier only.

---

## 3. Normalization (deterministic; these feed UNIQUE keys)

### 3.1 `place.canonical_key`
```
norm_name  = lowercase(name)
           | strip leading "the "
           | strip trailing " - austin", " austin", " atx", " (austin)"
           | remove all characters not [a-z0-9 ]
           | collapse whitespace, trim
norm_addr  = lowercase(address)
           | keep only the leading street number and the first street token
             ("1120 S Lamar Blvd" -> "1120 lamar"; directionals N/S/E/W dropped)
           | "" if no address
canonical_key = norm_name + "|" + norm_addr
```
Two places with the same `norm_name` and different `norm_addr` are different places (chains). Same `norm_name`, one with empty `norm_addr`: the merge job proposes them, a human confirms; never auto-merged.

### 3.2 `event.dedupe_key`
```
chicago_date = starts_at rendered as YYYY-MM-DD in America/Chicago
norm_title   = lowercase(title)
             | remove parentheticals "( ... )" and bracketed "[ ... ]"
             | remove tokens: presents, present, w/, with, featuring, feat, ft, and, &, the, a, an
             | remove all characters not [a-z0-9 ]
             | collapse whitespace, trim
dedupe_key   = place_id + "|" + chicago_date + "|" + norm_title
```

### 3.3 The attach step (fuzzy, never feeds a key)
Before inserting a new event, look for a `live` event at the same `place_id` on the same `chicago_date`. If one exists and `jaccard(tokens(norm_title_new), tokens(norm_title_existing)) >= 0.6`, do **not** insert: write an `event_source` row pointing at the existing event and update its `last_seen`. Otherwise insert. The threshold is a constant in one file with a test that pins the three cases: identical, "X presents Y" vs "Y", and two different shows same night.

---

## 4. Client state and sync

IndexedDB stores: `events`, `places`, `me` (own person row, mutual_ids, home_anchor), `plans`, `meta` (last sync per store, app version). `home_anchor` exists only in `me` and is never included in any request body; a test greps the request layer for it.

- **Reads offline: yes.** Every tab renders from IndexedDB first, then reconciles.
- **Writes offline: no.** Any write with no network shows `offline_write` as one plain sentence and does nothing. No queue, no retry, no conflict handling.
- Re-read triggers: window focus, after any successful write, every 10 minutes while visible.
- Always load the newest, three parts that must all be present: the Worker sets `cache-control: no-store, must-revalidate` on any HTML asset response; Vite emits hashed filenames under `/a/`; the client compares `/api/version` against the version it booted with on focus, on visibility change, and every 10 minutes, and shows a tap-to-reload bar rather than reloading under the person's thumb.
- Token lives in `localStorage` with an IndexedDB mirror; whichever is present wins; if both exist and differ, `localStorage` wins and the mirror is rewritten.

---

## 5. Mandatory test gates (all run inside `npm run build`)

A red test takes the site down on Cloudflare. That is the point. Every test below must exist before the feature it guards ships. The runner is `node --test "tests/*.test.js"` (Node 22 takes a glob, not a directory).

- `visibility.test.js` — for every route in §1 marked **[gate]** or **[members]**: non-mutual viewer receives zero gated fields for a `mutual` subject; mutual viewer receives them; owner-as-non-mutual receives zero; any viewer receives them for a `public` subject; a `public` subject flipped back to `mutual` is re-gated on the very next request; a `public` person cannot be added to a plan by a non-mutual (`400`); a removed person yields nothing regardless of `visibility`; non-member gets `404` on plan routes.
- `gateLint.test.js` — no file outside `src/lib/gate.js` calls the repo functions that return gated rows (`ticksFrom`, `ticksTo`, `availability`, `vouches`, `interests`, `reviews`, `planMembers`). The two repo files are the only other files allowed to name those tables, because that is where SQL lives; they return raw rows and never decide visibility.
- `repoParity.test.js` — `src/repo/memory.js` and `src/repo/d1.js` export exactly the same function names, so a test that passes on memory is a claim about production.
- `reviewOwnership.test.js` — `PUT`/`DELETE` on another person's review is `404`, never `403` (a review you cannot see does not exist to you); a removed person's reviews still count in `review_count` and `verdicts` but never appear in `reviews[]` for any viewer.
- `tokenTransport.test.js` — no route handler reads `token` from `url.pathname`, `url.searchParams`, or the request body; the client never places the token in a URL after the initial `#/join/` strip.
- `noPush.test.js` — `src/` contains no `Notification`, `PushManager`, `pushManager`, or `showNotification`.
- `schema.test.js` — the checked-in `migrations/*.sql` concatenated equals a stored snapshot; any drift fails until the snapshot is regenerated on purpose.
- `integrity.test.js` — against a seeded D1 fixture: every `event.place_id`, `vouch.place_id`, `interest.target_id`, `plan.target_id`, `plan_member.plan_id` resolves; every `place.merged_into` resolves to a place with `merged_into IS NULL` (no chains).
- `answersSchema.test.js` — the §2 validator rejects: invented evidence, `unknown` with evidence, empty groups without reject, unknown enum values.
- `normalization.test.js` — pins §3.1 and §3.2 on a fixture of real Austin venue and event names, plus the three attach cases in §3.3.
- `planStates.test.js` — every transition in `ARCHITECTURE.md` §5.3 allowed, every other transition `400`; done sets `in -> went` and leaves `maybe`/`out` alone; the vouch prompt fires once per (person, place) and never twice.
- `night.test.js` — `GET /api/night` never counts a non-visible person in `who`, not even in a total; returns `fallback_places` only when `events` is empty; returns no distance field; includes a member's open plan on that date and excludes a non-member's.
- `withdraw.test.js` — (lands with the pipeline) a future `live` event unseen 7 days becomes `rejected / withdrawn`; seen again, it returns to `live` with its `groups` and `answers` intact (status changed, classification untouched).
- `staleRefs.test.js` — (lands with the client) exactly four tabs registered (Map, Calendar, People, Plans); no copy string names a surface that does not exist.
- `voice.test.js` — no exclamation marks in UI copy; no string in the banned list (`genuinely`, `vibe`, `curated`, `discover`, `unlock`); no ALL-CAPS sentence ending in `.!?`.

---

## 6. `HANDOFF.md` format and the delta ritual

`HANDOFF.md` at repo root, rewritten each session, five sections in this order and nothing else:

1. **Deployed** — the version Kevin has confirmed is live. Only Kevin moves this line ("everything up til now is deployed").
2. **Since deployed** — what this session's zip contains, file by file.
3. **Migrations pending** — exact single-line SQL to paste into the D1 console, in order, or "none."
4. **Next** — the next item from `ARCHITECTURE.md` §7, by number.
5. **Open** — questions for Kevin, or "none."

Delta ritual, every session: pin `md5sum` of the whole tree before touching anything, diff at the end, ship exactly the changed files with full directory structure. If a zip changes `package.json`'s test script it carries every test file that script names, or the prose says which earlier zip is a prerequisite. Present only the newest zip.

---

## 7. Copy register

One register for the whole app: plain speech, the way a person would say it out loud. No game voice anywhere; this is not DCD. Titles are the plain name of the thing (Map, Calendar, People, Plans, Settings). Buttons are verbs (Copy, Vouch, I'm in, Can't make it). Empty states are one sentence and never apologize. Times render as `Sat Sep 26, 7:00 PM`. Money renders as `free`, `$`, `$$`, `$$$`, never a range. The four answers render as short labels (`lot parking`, `loud`), never as sentences, and an `unknown` is never rendered at all. Verdicts render as the three words themselves: `loved`, `fine`, `bounced`. The visibility toggle is labeled `Open to everyone` and its one explanatory sentence is: "Anyone in the room can see your calendar, reviews, and who you're interested in. Being added to plans still needs you both to have ticked each other."
