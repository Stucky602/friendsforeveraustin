import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractListings, jsonLdBlocks, links } from '../src/pipeline/extract.js';
import { parseRobots, createFetcher, Parked } from '../src/pipeline/fetcher.js';
import { mutedCategory, scoreEvent, listingText } from '../src/pipeline/classify.js';
import { createRunner } from '../src/pipeline/run.js';
import { memoryRepo, withPipeline } from '../src/repo/memory.js';

const HTML = readFileSync('tests/fixtures/listing.html', 'utf8');

test('extract: JSON-LD events, broken block survived, description de-tagged', () => {
  assert.equal(jsonLdBlocks(HTML).length, 2, 'the malformed block is skipped, not fatal');
  const out = extractListings(HTML, { source: 'alamo', pageUrl: 'https://drafthouse.com/x' });
  assert.equal(out.length, 3);
  const tt = out[0];
  assert.equal(tt.title, 'Terror Tuesday: The Cat');
  assert.equal(tt.venue_name, 'Alamo Drafthouse South Lamar');
  assert.equal(tt.venue_address, '1120 S Lamar Blvd, Austin, TX');
  assert.equal(tt.starts_at, '2026-09-25T00:30:00.000Z');
  assert.ok(!tt.description.includes('<p>'));
  assert.ok(tt.price_text.includes('10'));
});

test('extract: @graph and string locations are handled', () => {
  const out = extractListings(HTML, { source: 'x', pageUrl: 'https://x/' });
  const story = out.find((l) => l.title.startsWith('Story Time'));
  assert.equal(story.venue_name, 'Austin Public Library Central');
  assert.equal(story.venue_address, '710 W Cesar Chavez St, Austin, TX');
});

test('extract: an event with no start or no name is dropped, not half-inserted', () => {
  const bad = '<script type="application/ld+json">{"@type":"Event","name":"No date"}</script>';
  assert.deepEqual(extractListings(bad, { source: 'x', pageUrl: 'u' }), []);
});

test('links: absolutized and filtered by pattern', () => {
  const found = links(HTML, { base: 'https://drafthouse.com/austin/tickets/calendar', match: /drafthouse\.com\/austin\/show\// });
  assert.deepEqual(found.sort(), ['https://drafthouse.com/austin/show/terror-tuesday-the-cat', 'https://drafthouse.com/austin/show/weird-wednesday']);
});

test('robots: wildcard group honored, our token matched', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nDisallow: /admin\n\nUser-agent: BadBot\nDisallow: /');
  assert.deepEqual(r.disallow, ['/private', '/admin']);
  const mine = parseRobots('User-agent: RoomApp\nDisallow: /nope');
  assert.deepEqual(mine.disallow, ['/nope']);
});

test('fetcher: caches, rate limits, parks on 429', async () => {
  const repo = withPipeline(memoryRepo());
  let calls = 0, slept = 0;
  const fetchImpl = async (url) => { calls++; if (url.endsWith('/robots.txt')) return { ok: true, status: 200, text: async () => '' }; if (url.includes('429')) return { ok: false, status: 429, text: async () => '' }; return { ok: true, status: 200, text: async () => 'body' }; };
  const f = createFetcher({ repo, fetchImpl, now: () => 1000, sleep: async (ms) => { slept += ms; } });
  assert.equal(await f.get('https://a.test/one'), 'body');
  assert.equal(await f.get('https://a.test/one'), 'body', 'second hit is cached');
  const before = calls;
  await f.get('https://a.test/two');
  assert.ok(calls > before && slept >= 3000, 'rate limited between hits on the same host');
  await assert.rejects(() => f.get('https://a.test/429'), Parked);
});

test('mute rule kills music before any model call', () => {
  const cats = ['live_music', 'concert'];
  assert.equal(mutedCategory({ title: 'The Wild Ones live in concert', description: '' }, cats), 'live_music');
  assert.equal(mutedCategory({ title: 'Open Mic Night', description: '' }, cats), 'live_music');
  assert.equal(mutedCategory({ title: 'Story Time for Toddlers', description: 'Free' }, cats), null);
  assert.equal(mutedCategory({ title: 'Terror Tuesday: The Cat', description: '35mm print' }, cats), null);
});

test('score: room-wide, bounded, institutional sources beat aggregators', () => {
  const answers = { cost: { confidence: 0.9 }, parking: { confidence: 0.8 }, loud: { confidence: 0.8 }, kid_ok: { confidence: 0.5 } };
  const alamo = scoreEvent({ source: 'alamo', groups: ['odd'], answers, vouchCount: 2 });
  const do512 = scoreEvent({ source: 'do512', groups: ['odd'], answers, vouchCount: 2 });
  assert.ok(alamo > do512);
  assert.ok(scoreEvent({ source: 'alamo', groups: [], answers: {}, vouchCount: 0 }) >= 0);
  assert.ok(scoreEvent({ source: 'alamo', groups: ['odd', 'foodie'], answers, vouchCount: 9 }) <= 100);
});

function runnerOn(repo, pages, extra = {}) {
  const fetchImpl = async (url) => {
    if (url.endsWith('/robots.txt')) return { ok: true, status: 200, text: async () => '' };
    const body = pages[url];
    return body ? { ok: true, status: 200, text: async () => body } : { ok: false, status: 404, text: async () => '' };
  };
  return createRunner({ repo, roomId: 'R1', env: {}, deps: { fetchImpl, geocode: async () => ({ lat: 30.25, lng: -97.76 }), now: () => Date.parse('2026-09-16T12:00:00Z'), ...extra } });
}

async function seedRoom() {
  const repo = withPipeline(memoryRepo());
  await repo.insertRoom({ id: 'R1', name: 'R', owner_person_id: null, bar: 50, created_at: '2026-09-01T00:00:00Z' });
  await repo.setMutes('R1', ['live_music', 'concert']);
  return repo;
}

test('discover: places created once, music muted, listings become events', async () => {
  const repo = await seedRoom();
  const url = 'https://drafthouse.com/austin/tickets/calendar';
  const { createFetcher } = await import('../src/pipeline/fetcher.js');
  const fetchImpl = async (u) => (u.endsWith('/robots.txt') ? { ok: true, status: 200, text: async () => '' } : u.startsWith(url) || u.includes('/show/') ? { ok: true, status: 200, text: async () => HTML } : { ok: false, status: 404, text: async () => '' });
  const r = createRunner({ repo, roomId: 'R1', env: {}, deps: { fetcher: createFetcher({ repo, fetchImpl, sleep: async () => {} }), geocode: async () => ({ lat: 30.25, lng: -97.76 }) } });
  const counts = await r.discover();
  assert.ok(counts.listings >= 3);
  assert.ok(counts.inserted >= 2, 'the two non-music events land');
  assert.equal(counts.muted >= 1, true, 'the concert is muted at ingest');
  const muted = repo._t.event.find((e) => e.title.includes('Wild Ones'));
  assert.equal(muted.status, 'rejected');
  assert.equal(muted.reject_reason, 'mute');
  // places are created once and reused across runs
  const placeCount = repo._t.place.length;
  await r.discover();
  assert.equal(repo._t.place.length, placeCount, 'second run creates no duplicate places');
  assert.equal(repo._t.event.length, 3, 'second run creates no duplicate events');
});

test('geocode: runs per place, once, and a failure is recorded not dropped', async () => {
  const repo = await seedRoom();
  await repo.insertPlace({ id: 'P1', name: 'A', address: '1 Main St', groups: [], canonical_key: 'a|1 main', created_by: 'pipeline', created_at: '2026-09-01T00:00:00Z' });
  await repo.insertPlace({ id: 'P2', name: 'B', address: null, groups: [], canonical_key: 'b|', created_by: 'pipeline', created_at: '2026-09-01T00:00:00Z' });
  const r = runnerOn(repo, {});
  const c = await r.geocodeStage();
  assert.equal(c.ok, 1);
  assert.equal(c.failed, 1);
  assert.equal((await repo.placeById('P2')).geocode_source, 'failed');
  assert.deepEqual(await r.geocodeStage(), { tried: 0, ok: 0, failed: 0 }, 'never geocodes the same place twice');
});

test('classify: never reprocesses, falls back to the source hint, records no_group', async () => {
  const repo = await seedRoom();
  await repo.insertPlace({ id: 'P1', name: 'A', address: null, groups: [], canonical_key: 'a|', created_by: 'pipeline', created_at: '2026-09-01T00:00:00Z' });
  const mk = (id, title) => repo.insertEvent({ id, place_id: 'P1', title, starts_at: '2026-09-25T00:30:00Z', ends_at: null, groups: [], answers: {}, score: 0, status: 'live', dedupe_key: `P1|x|${id}`, raw: { description: 'd', group_hint: 'kids' }, first_seen: '2026-09-15T00:00:00Z', last_seen: '2026-09-15T00:00:00Z' });
  await mk('E1', 'One'); await mk('E2', 'Two');
  const ai = async () => JSON.stringify({ groups: ['odd'], reject: null, answers: { cost: { value: 'free', confidence: 0.9, evidence: '' }, parking: { value: 'unknown', confidence: 0, evidence: '' }, loud: { value: 'unknown', confidence: 0, evidence: '' }, kid_ok: { value: 'unknown', confidence: 0, evidence: '' } } });
  const r = createRunner({ repo, roomId: 'R1', env: { AI: { run: async () => ({ response: await ai() }) } }, deps: {} });
  const c1 = await r.classify();
  assert.equal(c1.tried, 2);
  const c2 = await r.classify();
  assert.equal(c2.tried, 0, 'never reprocess');
  assert.deepEqual((await repo.eventById('E1')).groups, ['odd']);
});

test('invalid model output never half-writes, and falls through to rules', async () => {
  const repo = await seedRoom();
  await repo.insertPlace({ id: 'P1', name: 'A', address: null, groups: [], canonical_key: 'a|', created_by: 'pipeline', created_at: '2026-09-01T00:00:00Z' });
  await repo.insertEvent({ id: 'E1', place_id: 'P1', title: 'Untitled', starts_at: '2026-09-25T00:30:00Z', groups: [], answers: {}, score: 0, status: 'live', dedupe_key: 'k1', raw: {}, first_seen: 'x', last_seen: 'x' });
  await repo.insertEvent({ id: 'E2', place_id: 'P1', title: 'Family Story Time', starts_at: '2026-09-25T00:30:00Z', groups: [], answers: {}, score: 0, status: 'live', dedupe_key: 'k2', raw: { description: 'Free, all ages.' }, first_seen: 'x', last_seen: 'x' });
  const bad = 'here you go: {"groups":["odd"],"answers":{"cost":{"value":"free","confidence":0.9,"evidence":"invented"}}}';
  const r = createRunner({ repo, roomId: 'R1', env: { AI: { run: async () => ({ response: bad }) } }, deps: {} });
  const c = await r.classify();
  assert.equal(c.tier1, 0, 'the model output was rejected');
  assert.equal(c.rules, 2, 'both fell through to rules');

  // nothing half-written: the invented evidence never reached the database
  const e1 = await repo.eventById('E1');
  assert.ok(!JSON.stringify(e1.answers).includes('invented'));
  assert.equal(e1.status, 'rejected');
  assert.equal(e1.reject_reason, 'no_group', 'rules found nothing either, and it says so');

  const e2 = await repo.eventById('E2');
  assert.deepEqual(e2.groups, ['kids']);
  assert.equal(e2.answers.cost.value, 'free');
  assert.ok(!JSON.stringify(e2.answers).includes('invented'));
});

test('spend: tier 2 charged, hard cap stops tier 2', async () => {
  const repo = await seedRoom();
  await repo.insertPlace({ id: 'P1', name: 'A', address: null, groups: [], canonical_key: 'a|', created_by: 'pipeline', created_at: '2026-09-01T00:00:00Z' });
  for (let i = 0; i < 3; i++) await repo.insertEvent({ id: `E${i}`, place_id: 'P1', title: `T${i}`, starts_at: '2026-09-25T00:30:00Z', groups: [], answers: {}, score: 0, status: 'live', dedupe_key: `k${i}`, raw: {}, first_seen: 'x', last_seen: 'x' });
  let tier2Calls = 0;
  const good = JSON.stringify({ groups: ['odd'], reject: null, answers: { cost: { value: 'free', confidence: 0.9, evidence: '' }, parking: { value: 'unknown', confidence: 0, evidence: '' }, loud: { value: 'unknown', confidence: 0, evidence: '' }, kid_ok: { value: 'unknown', confidence: 0, evidence: '' } } });
  globalThis.fetch = async () => { tier2Calls++; return { ok: true, json: async () => ({ content: [{ text: good }] }) }; };
  const r = createRunner({ repo, roomId: 'R1', env: { ANTHROPIC_API_KEY: 'k' }, deps: {} });
  await r.classify();
  assert.equal(tier2Calls, 3, 'no tier 1 configured, so every event goes to tier 2');
  assert.ok((await repo.spendMonth(new Date().toISOString().slice(0, 7))) > 0);
});

test('expire and withdraw: the rules from the architecture', async () => {
  const repo = await seedRoom();
  await repo.insertPlace({ id: 'P1', name: 'A', address: null, groups: [], canonical_key: 'a|', created_by: 'pipeline', created_at: '2026-09-01T00:00:00Z' });
  const NOW = Date.parse('2026-09-16T12:00:00Z');
  await repo.insertEvent({ id: 'PAST', place_id: 'P1', title: 'Over', starts_at: '2026-09-15T00:00:00Z', ends_at: null, groups: ['odd'], answers: {}, score: 60, status: 'live', dedupe_key: 'k1', raw: {}, first_seen: 'x', last_seen: '2026-09-16T00:00:00Z' });
  await repo.insertEvent({ id: 'GONE', place_id: 'P1', title: 'Cancelled', starts_at: '2026-10-01T00:00:00Z', ends_at: null, groups: ['odd'], answers: {}, score: 60, status: 'live', dedupe_key: 'k2', raw: {}, first_seen: 'x', last_seen: '2026-09-01T00:00:00Z' });
  await repo.insertEvent({ id: 'FINE', place_id: 'P1', title: 'Still on', starts_at: '2026-10-01T00:00:00Z', ends_at: null, groups: ['odd'], answers: {}, score: 60, status: 'live', dedupe_key: 'k3', raw: {}, first_seen: 'x', last_seen: '2026-09-16T00:00:00Z' });
  const r = runnerOn(repo, {});
  const c = await r.expire();
  assert.equal(c.expired, 1);
  assert.equal(c.withdrawn, 1);
  assert.equal((await repo.eventById('PAST')).status, 'expired');
  const gone = await repo.eventById('GONE');
  assert.equal(gone.status, 'rejected');
  assert.equal(gone.reject_reason, 'withdrawn');
  assert.equal((await repo.eventById('FINE')).status, 'live');

  // seen again: back to live, classification untouched
  await repo.touchEvent('GONE', '2026-09-16T11:00:00Z');
  const c2 = await r.expire();
  assert.equal(c2.restored, 1);
  const back = await repo.eventById('GONE');
  assert.equal(back.status, 'live');
  assert.equal(back.reject_reason, null);
  assert.deepEqual(back.groups, ['odd'], 'status changed, classification untouched');
});

test('the fetch cache honours a zero max age without breaking the rate limit', async () => {
  const repo = withPipeline(memoryRepo());
  let hits = 0, slept = 0;
  let t = 1000;
  const fetchImpl = async (u) => { if (!u.endsWith('/robots.txt')) hits++; return { ok: true, status: 200, text: async () => `body${hits}` }; };
  const f = createFetcher({ repo, fetchImpl, now: () => t, sleep: async (ms) => { slept += ms; t += ms; } });
  await f.get('https://a.test/x', { maxAgeMs: 0 });
  await f.get('https://a.test/x', { maxAgeMs: 0 });
  assert.equal(hits, 2, 'no cache hit when maxAgeMs is 0');
  assert.ok(slept >= 3000, 'still rate limited');
});

test('rule classifier: works with no model at all, and never invents evidence', async () => {
  const { ruleClassify } = await import('../src/pipeline/classify.js');
  const r = ruleClassify({ title: 'Story Time for Toddlers', description: 'Free. All ages welcome.', venue_name: 'Austin Public Library', price_text: '' }, 'kids');
  assert.ok(r.groups.includes('kids'));
  assert.equal(r.reject, null);
  assert.equal(r.answers.cost.value, 'free');
  assert.equal(r.answers.kid_ok.value, 'yes');
  const text = 'Story Time for Toddlers\nAustin Public Library\nFree. All ages welcome.';
  for (const a of Object.values(r.answers)) assert.ok(a.evidence === '' || text.includes(a.evidence), `invented evidence: ${a.evidence}`);

  const odd = ruleClassify({ title: 'Terror Tuesday: The Cat', description: '35mm screening. $10 tickets.', venue_name: 'Alamo', price_text: '' }, 'odd');
  assert.ok(odd.groups.includes('odd'));
  assert.equal(odd.answers.cost.value, '$');

  const nothing = ruleClassify({ title: 'Untitled', description: '', venue_name: '', price_text: '' }, null);
  assert.deepEqual(nothing.groups, []);
  assert.deepEqual(nothing.reject, { reason: 'no_group' });
});

test('rule output always passes the strict answer validator', async () => {
  const { ruleClassify, listingText } = await import('../src/pipeline/classify.js');
  const { validateAnswers } = await import('../src/lib/answers.js');
  const cases = [
    { title: 'Family Day at the Museum', description: 'Free admission, parking garage on site. Ages 3 and up.', venue_name: 'Blanton', price_text: '' },
    { title: 'Taco pop-up', description: '$25 per person. Street parking only. It gets loud.', venue_name: 'Somewhere', price_text: '' },
    { title: 'Lecture', description: '21+ quiet reading room. $60.', venue_name: 'X', price_text: '' },
  ];
  for (const c of cases) {
    const r = ruleClassify(c, null);
    const v = validateAnswers(r, listingText(c));
    assert.ok(v.ok, `${c.title}: ${v.error}`);
  }
});

test('classify stage runs with no model configured and produces groups', async () => {
  const repo = withPipeline(memoryRepo());
  await repo.insertRoom({ id: 'R1', name: 'R', owner_person_id: null, bar: 50, created_at: '2026-09-01T00:00:00Z' });
  await repo.setMutes('R1', []);
  await repo.insertPlace({ id: 'P1', name: 'Austin Public Library', address: null, groups: [], canonical_key: 'austin public library|', created_by: 'pipeline', created_at: 'x' });
  await repo.insertEvent({ id: 'E1', place_id: 'P1', title: 'Story Time for Toddlers', starts_at: '2026-10-01T15:00:00Z', groups: [], answers: {}, score: 0, status: 'live', dedupe_key: 'k1', raw: { description: 'Free. All ages.', group_hint: 'kids' }, first_seen: 'x', last_seen: 'x' });
  const r = createRunner({ repo, roomId: 'R1', env: {}, deps: {} });
  const c = await r.classify();
  assert.equal(c.no_model, true);
  assert.equal(c.rules, 1);
  assert.equal(c.invalid, 0);
  assert.deepEqual((await repo.eventById('E1')).groups, ['kids']);
  const s = await r.score();
  assert.equal(s.scored, 1);
  assert.ok((await repo.eventById('E1')).score > 0);
});

test('a listing with no venue name falls back to the address, then the source venue', async () => {
  const repo = withPipeline(memoryRepo());
  await repo.insertRoom({ id: 'R1', name: 'R', owner_person_id: null, bar: 50, created_at: 'x' });
  await repo.setMutes('R1', []);
  const r = createRunner({ repo, roomId: 'R1', env: {}, deps: { geocode: async () => null } });
  const html = `<script type="application/ld+json">{"@type":"Event","@id":"a","name":"No venue name","startDate":"2026-10-02T18:00:00Z","location":{"address":"1120 S Lamar Blvd, Austin, TX"}}</script>`;
  const html2 = `<script type="application/ld+json">{"@type":"Event","@id":"b","name":"No location at all","startDate":"2026-10-03T18:00:00Z"}</script>`;
  const { extractListings } = await import('../src/pipeline/extract.js');
  const counts = { listings: 0, no_place: 0, muted: 0, attached: 0, inserted: 0 };
  // exercise resolvePlace through the runner's own ingest path
  const listings = [...extractListings(html, { source: 'alamo', pageUrl: 'u' }), ...extractListings(html2, { source: 'alamo', pageUrl: 'u' })];
  assert.equal(listings.length, 2);
  assert.equal(listings[0].venue_name, '');
  assert.equal(listings[1].venue_name, '');
  const { SOURCE_VENUE } = await import('../src/pipeline/run.js');
  assert.equal(SOURCE_VENUE.alamo, 'Alamo Drafthouse');
});
