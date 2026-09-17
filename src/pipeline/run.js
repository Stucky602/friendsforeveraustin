// The stages. Every stage is a function the owner can trigger with a button; cron calls the same ones.
import { createFetcher, Parked } from './fetcher.js';
import { extractListings, links } from './extract.js';
import { SOURCES } from './sources/index.js';
import { readPartyMode, LTB_SOURCE, LTB_URL, LTB_PLACE_NAME } from './sources/ltb.js';
import { mutedCategory, classifyOne, scoreEvent } from './classify.js';
import { canonicalKey, dedupeKey, chicagoDate, shouldAttach } from '../lib/normalize.js';
import { ulid, nowIso, neighborhoodFor, censusGeocode } from '../lib/util.js';

export const STAGES = ['discover', 'dedupe', 'geocode', 'classify', 'score', 'expire', 'all'];
export const WITHDRAW_AFTER_DAYS = 7;
export const MONTHLY_CAP_CENTS = 500;
const TIER2_CENTS = 0.6;

export function createRunner({ repo, roomId, env = {}, deps = {} }) {
  const fetcher = deps.fetcher || createFetcher({ repo, fetchImpl: deps.fetchImpl || fetch });
  const geocode = deps.geocode || ((a) => censusGeocode(a, deps.fetchImpl || fetch));
  const neighborhoods = deps.neighborhoods || { type: 'FeatureCollection', features: [] };
  const now = deps.now || (() => Date.now());
  const month = () => new Date(now()).toISOString().slice(0, 7);

  const spend = {
    async allowed() { return (await repo.spendMonth(month())) < MONTHLY_CAP_CENTS; },
    async charge(tier) { if (tier === 2) await repo.addSpend({ id: ulid(), month: month(), tier: 't2', cents: TIER2_CENTS, created_at: nowIso() }); },
  };

  const ai = env.AI ? async (prompt) => {
    const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 700 });
    return r.response ?? '';
  } : null;

  const anthropic = env.ANTHROPIC_API_KEY ? async (prompt) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}`);
    const j = await r.json();
    return (j.content || []).map((c) => c.text || '').join('\n');
  } : null;

  // ---- discover: fetch, extract, insert raw listings (place resolved, event attached) ----
  async function discover() {
    const counts = { pages: 0, listings: 0, muted: 0, no_place: 0, attached: 0, inserted: 0, parked: [] };
    const mutes = await repo.mutes(roomId);
    counts.ltb = await discoverLtb(counts, mutes);
    for (const src of SOURCES) {
      try {
        const pages = [...src.index_urls];
        for (const idx of src.index_urls) {
          const html = await fetcher.get(idx);
          if (!html) continue;
          counts.pages++;
          if (src.detail_match) for (const u of links(html, { base: idx, match: src.detail_match }).slice(0, 60)) pages.push(u);
          await ingest(extractListings(html, { source: src.name, pageUrl: idx }), src, mutes, counts);
        }
        for (const u of pages.slice(src.index_urls.length)) {
          const html = await fetcher.get(u);
          if (!html) continue;
          counts.pages++;
          await ingest(extractListings(html, { source: src.name, pageUrl: u }), src, mutes, counts);
        }
      } catch (e) {
        if (e instanceof Parked) { counts.parked.push(src.name); await park(src.name); continue; }
        throw e;
      }
    }
    return counts;
  }

  /**
   * ltbaustin.com, Kevin's own site. Two things make this different from every other source:
   * the listing is authoritative (he controls it, so absence means cancelled RIGHT NOW, not in
   * seven days), and a party-mode day is never rejected, muted, or classified by a model.
   */
  async function discoverLtb(counts, mutes) {
    let html;
    try {
      // No cache: this page's ABSENCE of a party day is a same-day signal, so a stale copy is wrong.
      html = await fetcher.get(LTB_URL, { maxAgeMs: 0 });
    } catch (e) {
      if (e instanceof Parked) { counts.parked.push(LTB_SOURCE); await park(LTB_SOURCE); return { path: 'parked' }; }
      throw e;
    }
    const { listings, diagnostics } = readPartyMode(html, { now: new Date(now()) });
    counts.pages++;
    counts.listings += listings.length;

    const place = await ltbPlace();
    const keep = new Set();
    for (const l of listings) {
      const key = dedupeKey(place.id, l.starts_at, l.title);
      keep.add(key);
      const existing = await repo.eventByDedupeKey(key);
      if (existing) {
        if (existing.status !== 'live') await repo.setEventStatus(existing.id, 'live', null);
        await repo.touchEvent(existing.id, nowIso());
        continue;
      }
      const id = ulid();
      await repo.insertEvent({
        id, place_id: place.id, title: l.title, starts_at: l.starts_at, ends_at: l.ends_at,
        // Classified at ingest, so the model pass skips it and nothing can reject it as no_group.
        groups: ['foodie'], answers: {}, score: 100,
        status: 'live', reject_reason: null, dedupe_key: key,
        first_seen: nowIso(), last_seen: nowIso(),
        raw: { description: l.description, price_text: '', category_hint: l.category_hint, venue_name: l.venue_name, group_hint: 'foodie' },
      });
      await repo.addEventSource({ event_id: id, source: LTB_SOURCE, source_id: l.source_id, source_url: l.source_url, seen_at: nowIso() });
      counts.inserted++;
    }

    // Immediate withdraw. A cancelled party day must not linger for a week on his own listing.
    let withdrawn = 0;
    if (diagnostics.path === 'jsonld' || diagnostics.path === 'data_attr' || diagnostics.path === 'clean_no_party' || diagnostics.path === 'text') {
      for (const e of await repo.liveEventsAtPlace(place.id, new Date(now() - 86400e3).toISOString(), new Date(now() + 365 * 86400e3).toISOString())) {
        if (keep.has(e.dedupe_key)) continue;
        await repo.setEventStatus(e.id, 'rejected', 'withdrawn');
        withdrawn++;
      }
    }
    return { ...diagnostics, found: listings.length, withdrawn };
  }

  async function ltbPlace() {
    const key = canonicalKey(LTB_PLACE_NAME, env.LTB_ADDRESS || null);
    const found = await repo.placeByKey(key);
    if (found) return repo.placeById(found.id);
    const lat = Number(env.LTB_LAT), lng = Number(env.LTB_LNG);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    return repo.insertPlace({
      id: ulid(), name: LTB_PLACE_NAME, address: env.LTB_ADDRESS || null,
      lat: hasCoords ? lat : null, lng: hasCoords ? lng : null,
      neighborhood: hasCoords ? neighborhoodFor(lng, lat, neighborhoods) : null,
      groups: ['foodie'], canonical_key: key,
      geocode_source: hasCoords ? 'config' : null, geocoded_at: hasCoords ? nowIso() : null,
      created_by: 'pipeline', created_at: nowIso(),
    });
  }

  async function park(name) {
    await repo.setRunState('discover', { parked_until: new Date(now() + 6 * 3600e3).toISOString(), error: `parked:${name}` });
  }

  async function ingest(listings, src, mutes, counts) {
    for (const l of listings) {
      counts.listings++;
      const already = await repo.eventBySource(l.source, l.source_id);
      if (already) { await repo.touchEvent(already.event_id, nowIso()); continue; }

      const muted = mutedCategory(l, mutes);
      const place = await resolvePlace(l);
      if (!place) { counts.no_place++; continue; }

      const key = dedupeKey(place.id, l.starts_at, l.title);
      const existing = await repo.eventByDedupeKey(key);
      if (existing) {
        await repo.addEventSource({ event_id: existing.id, source: l.source, source_id: l.source_id, source_url: l.source_url, seen_at: nowIso() });
        await repo.touchEvent(existing.id, nowIso());
        counts.attached++;
        continue;
      }
      // §3.3 attach step: same place, same Chicago date, fuzzy title
      const day = chicagoDate(l.starts_at);
      const t0 = Date.parse(`${day}T00:00:00Z`);
      const sameNight = (await repo.liveEventsAtPlace(place.id, new Date(t0 - 12 * 3600e3).toISOString(), new Date(t0 + 36 * 3600e3).toISOString()))
        .filter((e) => chicagoDate(e.starts_at) === day);
      const match = sameNight.find((e) => shouldAttach(l.title, e.title));
      if (match) {
        await repo.addEventSource({ event_id: match.id, source: l.source, source_id: l.source_id, source_url: l.source_url, seen_at: nowIso() });
        await repo.touchEvent(match.id, nowIso());
        counts.attached++;
        continue;
      }

      const id = ulid();
      await repo.insertEvent({
        id, place_id: place.id, title: l.title, starts_at: l.starts_at, ends_at: l.ends_at,
        groups: [], answers: {}, score: 0,
        status: muted ? 'rejected' : 'live', reject_reason: muted ? 'mute' : null,
        dedupe_key: key, first_seen: nowIso(), last_seen: nowIso(),
        raw: { description: l.description, price_text: l.price_text, category_hint: l.category_hint, venue_name: l.venue_name, group_hint: src.group_hint },
      });
      await repo.addEventSource({ event_id: id, source: l.source, source_id: l.source_id, source_url: l.source_url, seen_at: nowIso() });
      if (muted) counts.muted++; else counts.inserted++;
    }
  }

  async function resolvePlace(l) {
    const name = (l.venue_name || '').trim();
    if (!name) return null;
    const key = canonicalKey(name, l.venue_address);
    const found = await repo.placeByKey(key);
    if (found) return repo.placeById(found.id);
    const row = {
      id: ulid(), name: name.slice(0, 80), address: (l.venue_address || '').slice(0, 160) || null,
      lat: null, lng: null, neighborhood: null, groups: [], canonical_key: key,
      geocode_source: null, geocoded_at: null, created_by: 'pipeline', created_at: nowIso(),
    };
    return repo.insertPlace(row);
  }

  // ---- geocode: places only, once, ever ----
  async function geocodeStage() {
    const counts = { tried: 0, ok: 0, failed: 0 };
    for (const p of await repo.placesNeedingGeocode(50)) {
      counts.tried++;
      if (!p.address) { await repo.updatePlaceGeo(p.id, { geocode_source: 'failed', geocoded_at: nowIso() }); counts.failed++; continue; }
      const g = await geocode(p.address);
      if (g) {
        await repo.updatePlaceGeo(p.id, { lat: g.lat, lng: g.lng, neighborhood: neighborhoodFor(g.lng, g.lat, neighborhoods), geocode_source: 'census', geocoded_at: nowIso() });
        counts.ok++;
      } else {
        await repo.updatePlaceGeo(p.id, { geocode_source: 'failed', geocoded_at: nowIso() });
        counts.failed++;
      }
    }
    return counts;
  }

  // ---- classify: never reprocess (skips any event with non-empty groups) ----
  async function classify(limit = 40) {
    const counts = { tried: 0, tier1: 0, tier2: 0, no_group: 0, muted: 0, invalid: 0 };
    for (const e of await repo.eventsNeedingClassify(limit)) {
      counts.tried++;
      const raw = e.raw || {};
      const listing = { title: e.title, description: raw.description || '', venue_name: raw.venue_name || '', price_text: raw.price_text || '', category_hint: raw.category_hint || '' };
      const r = await classifyOne(listing, { ai, anthropic, spend });
      if (r.error) { counts.invalid++; continue; }
      counts[`tier${r.tier}`]++;
      const { groups, reject, answers } = r.value;
      if (reject?.reason === 'mute') { await repo.setEventStatus(e.id, 'rejected', 'mute'); counts.muted++; continue; }
      if (groups.length === 0) {
        const hinted = raw.group_hint ? [raw.group_hint] : [];
        if (hinted.length) { await repo.setEventClassification(e.id, hinted, answers); continue; }
        await repo.setEventStatus(e.id, 'rejected', 'no_group');
        counts.no_group++;
        continue;
      }
      await repo.setEventClassification(e.id, groups, answers);
    }
    return counts;
  }

  // ---- score ----
  async function score() {
    let n = 0;
    for (const e of await repo.eventsNeedingScore(500)) {
      const sources = await repo.sourcesFor(e.id);
      const vouchCount = (await repo.vouchCounts([e.place_id])).get(e.place_id) ?? 0;
      await repo.setEventScore(e.id, scoreEvent({ source: sources[0]?.source, groups: e.groups, answers: e.answers, vouchCount }));
      n++;
    }
    return { scored: n };
  }

  // ---- expire + withdraw ----
  async function expire() {
    const t = now();
    const expired = await repo.expireEvents(new Date(t).toISOString());
    const cutoff = new Date(t - WITHDRAW_AFTER_DAYS * 86400e3).toISOString();
    // LTB is handled in discover, where absence is authoritative the same day.
    const withdrawn = await repo.withdrawUnseen(cutoff, new Date(t).toISOString());
    const restored = await repo.restoreWithdrawn(cutoff);
    const plansDone = await repo.completeDuePlans(t);
    return { expired, withdrawn, restored, plansDone };
  }

  async function run(stage) {
    const started = nowIso();
    try {
      let counts;
      if (stage === 'discover') counts = await discover();
      else if (stage === 'dedupe') counts = { note: 'dedupe runs inside discover' };
      else if (stage === 'geocode') counts = await geocodeStage();
      else if (stage === 'classify') counts = await classify();
      else if (stage === 'score') counts = await score();
      else if (stage === 'expire') counts = await expire();
      else if (stage === 'all') counts = { discover: await discover(), geocode: await geocodeStage(), classify: await classify(), score: (await score()).scored, expire: await expire() };
      else throw new Error('unknown stage');
      await repo.setRunState(stage, { last_run: started, last_ok: nowIso(), counts, error: null });
      return counts;
    } catch (e) {
      await repo.setRunState(stage, { last_run: started, error: String(e.message || e) });
      throw e;
    }
  }

  return { run, discover, geocodeStage, classify, score, expire, spend, STAGES };
}
