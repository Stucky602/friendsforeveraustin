# HANDOFF.md

## 1. Deployed
Nothing yet. Kevin moves this line once it is live.

## 2. Since deployed (v0.1.0, full repo)
Everything in ARCHITECTURE.md §7, steps 1 through 12. Server, client, and pipeline.

**Server**
- `src/worker.js` fetch + scheduled. Cron every 6h: complete due plans, expire and withdraw, then discover, geocode, classify, score.
- `src/app.js` every route in CONTRACTS.md §1, including `calendar.ics`, `/api/version`, and the owner-only `/api/run/*`.
- `src/lib/` gate (the wall), auth, normalize, plans, answers, night, util.
- `src/repo/memory.js` and `src/repo/d1.js`, same interface, parity enforced by test.

**Pipeline**
- `src/pipeline/fetcher.js` fixed UA, robots.txt honored, one request per 3s per host, 24h cache, parks the stage on 429 or 403.
- `src/pipeline/extract.js` JSON-LD schema.org/Event extraction. Selector-free on purpose: JSON-LD survives a redesign, CSS selectors do not.
- `src/pipeline/sources/index.js` ten adapters in order of fit, Do512 Family and Alamo first, Do512 main and the Chronicle last.
- `src/pipeline/classify.js` mute rule before any model call, two-tier classify, room-wide score.
- `src/pipeline/run.js` discover, geocode, classify, score, expire. Spend meter with a hard 500-cent monthly cap.
- `src/pipeline/sources/ltb.js` cross-references ltbaustin.com for party-mode days. Three read paths (JSON-LD, `data-party-mode`, plain text), classified `foodie` at ingest with score 100 so no model ever sees it and no bar hides it. Absence is same-day authoritative, so the LTB fetch bypasses the 24h scrape cache, but an unreachable or ambiguous page withdraws nothing. See `PARTY_MODE.md`.

**Client** (Vite + React, `client/`)
- Four tabs: Map, Calendar, People, Plans. First-open is one screen, three taps.
- Map is MapLibre on OpenFreeMap. Long-press to drop a place. Pins: events in the view hue, vouches in ink, been-there hollow.
- Bottom sheet for the night read, bottom sheet for detail. Nothing closes from a top corner.
- Home anchor lives in IndexedDB and is never sent to the server; drive-time trimming happens on device.
- MapLibre is lazy-loaded: 76 kB gzip first paint, the map's 282 kB only when the Map tab opens.

**Tests: 100, all inside `npm run build`.** visibility (13 incl. public flip-back, one-way tick, owner-as-stranger, removed public), gateLint, tokenTransport (incl. token-hash never leaves), noPush, auth, normalization, answersSchema, planStates, night, reviewOwnership, schema drift, integrity, repoParity, voice, staleRefs, pipeline (15 incl. robots, rate limit, discover idempotence, geocode-once, never-reprocess, spend cap, withdraw and restore), ltb (16, covering all five page states and both withdraw refusals).

**Found while building**
- `event.raw` was needed: classification retries, and re-fetching a page to reclassify would be a second scrape of someone else's site. Added to the schema and the doc.
- The gate lint caught the calendar route calling `repo.interests` directly. Added `ownEventInterestIds` to the gate instead.
- `/api/me` was returning `token_hash`. Now stripped, with a test.
- A real SQLite bug: `datetime(starts_at,'+6 hours')` returns `YYYY-MM-DD HH:MM:SS`, which does not string-compare against an ISO instant with `T` and `Z`. Expiry now compares like against like.
- MapLibre 6 has no default export.
- The LTB withdraw test caught the 24h fetch cache making "same day" a lie. `fetcher.get` now takes `maxAgeMs`, and LTB passes 0.

## 3. Migrations pending
Paste into the D1 console in order. Both files are already one-statement-per-line.
1. `migrations/0001_init.sql`
2. `migrations/0002_pipeline.sql`

## 4. Next
- Fill `config/neighborhoods.json` with real polygons (City of Austin planning areas plus hand-drawn rings for Cedar Park, Leander, Round Rock). It is an empty FeatureCollection now, so `place.neighborhood` stays null and neighborhood mode does nothing. Nothing else depends on it.
- Verify each adapter against live HTML once deployed. The extractor is tested against fixtures, but no site was reachable from the build environment, so per-source index URLs need one confirmation pass. `POST /api/run/discover?wait=1` reports per-source counts.
- Map clustering and the neighborhood mode from §7 step 9 are not built.

## 5. Open
- `starts_at + 6h` treats a midnight screening as over at 6 AM. Fine?
- Party mode currently lands in the `foodie` view only. Say if it should also show in `kids`.
- The monthly model cap is 500 cents. Say if you want it lower.
