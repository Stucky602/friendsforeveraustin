import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readPartyMode, parseLooseDate, parseLooseTime, chicagoToIso, LTB_PLACE_NAME } from '../src/pipeline/sources/ltb.js';
import { createRunner } from '../src/pipeline/run.js';
import { createFetcher } from '../src/pipeline/fetcher.js';
import { memoryRepo, withPipeline } from '../src/repo/memory.js';
import { chicagoDate } from '../src/lib/normalize.js';

const fx = (n) => readFileSync(`tests/fixtures/ltb-${n}.html`, 'utf8');
const NOW = new Date('2026-09-16T12:00:00Z');

test('date parsing: the shapes a human writes, and nothing else', () => {
  assert.deepEqual(parseLooseDate('2026-10-11', NOW), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(parseLooseDate('Saturday, October 11', NOW), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(parseLooseDate('Oct 11th', NOW), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(parseLooseDate('11 October', NOW), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(parseLooseDate('10/11', NOW), { y: 2026, m: 10, d: 11 });
  assert.deepEqual(parseLooseDate('Jan 3', NOW), { y: 2027, m: 1, d: 3 }, 'a past month rolls to next year');
  assert.equal(parseLooseDate('coming soon', NOW), null);
  assert.equal(parseLooseDate('order by Wednesday', NOW), null, 'a weekday alone is not a date');
  assert.deepEqual(parseLooseTime('7pm'), { hour: 19, minute: 0 });
  assert.deepEqual(parseLooseTime('6:30 PM'), { hour: 18, minute: 30 });
  assert.equal(parseLooseTime('Saturday'), null);
});

test('Chicago wall clock converts across the DST boundary', () => {
  assert.equal(chicagoToIso(2026, 10, 11, 18), '2026-10-11T23:00:00.000Z', 'CDT, UTC-5');
  assert.equal(chicagoToIso(2026, 1, 10, 18), '2026-01-11T00:00:00.000Z', 'CST, UTC-6');
});

test('the live page as it stands today yields nothing, and says so cleanly', () => {
  const { listings, diagnostics } = readPartyMode(fx('none'), { now: NOW });
  assert.deepEqual(listings, []);
  assert.equal(diagnostics.path, 'clean_no_party');
  assert.equal(diagnostics.saw_party_text, false);
});

test('JSON-LD is the primary path and needs no guessing', () => {
  const { listings, diagnostics } = readPartyMode(fx('jsonld'), { now: NOW });
  assert.equal(diagnostics.path, 'jsonld');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].starts_at, '2026-10-11T23:00:00.000Z');
  assert.equal(listings[0].ends_at, '2026-10-12T03:00:00.000Z');
  assert.equal(listings[0].venue_name, LTB_PLACE_NAME);
  assert.equal(chicagoDate(listings[0].starts_at), '2026-10-11');
});

test('data attribute path, with a time', () => {
  const { listings, diagnostics } = readPartyMode(fx('attr'), { now: NOW });
  assert.equal(diagnostics.path, 'data_attr');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].starts_at, '2026-10-12T00:00:00.000Z', '7pm Chicago on Oct 11');
});

test('plain text path finds the date beside the words', () => {
  const { listings, diagnostics } = readPartyMode(fx('text'), { now: NOW });
  assert.equal(diagnostics.path, 'text');
  assert.equal(listings.length, 1);
  assert.equal(chicagoDate(listings[0].starts_at), '2026-10-11');
});

test('party text with no date invents nothing and raises the flag', () => {
  const { listings, diagnostics } = readPartyMode(fx('vague'), { now: NOW });
  assert.deepEqual(listings, []);
  assert.equal(diagnostics.path, 'party_text_no_date');
  assert.equal(diagnostics.saw_party_text, true);
  assert.equal(diagnostics.saw_party_text_without_date, true, 'this is the signal that the page changed');
});

test('an unreachable page is distinguished from an empty one', () => {
  assert.equal(readPartyMode(null, { now: NOW }).diagnostics.path, 'no_page');
});

function runnerFor(repo, html, env = {}) {
  const fetchImpl = async (u) => (u.endsWith('/robots.txt')
    ? { ok: true, status: 200, text: async () => '' }
    : u.includes('ltbaustin.com') && html != null
      ? { ok: true, status: 200, text: async () => html }
      : { ok: false, status: 404, text: async () => '' });
  return createRunner({
    repo, roomId: 'R1', env,
    deps: { fetcher: createFetcher({ repo, fetchImpl, sleep: async () => {} }), geocode: async () => null, now: () => Date.parse('2026-09-16T12:00:00Z') },
  });
}

async function room() {
  const repo = withPipeline(memoryRepo());
  await repo.insertRoom({ id: 'R1', name: 'R', owner_person_id: null, bar: 50, created_at: '2026-09-01T00:00:00Z' });
  await repo.setMutes('R1', ['live_music', 'concert']);
  return repo;
}

test('discover: a party day lands classified, scored, and above any bar', async () => {
  const repo = await room();
  const counts = await runnerFor(repo, fx('jsonld')).discover();
  assert.equal(counts.ltb.path, 'jsonld');
  assert.equal(counts.ltb.found, 1);
  const ev = repo._t.event.find((e) => e.title.includes('party mode'));
  assert.ok(ev);
  assert.equal(ev.status, 'live');
  assert.equal(ev.score, 100);
  assert.deepEqual(JSON.parse(ev.groups), ['foodie'], 'classified at ingest, so no model call and no no_group rejection');
  const place = repo._t.place.find((p) => p.name === LTB_PLACE_NAME);
  assert.ok(place);
  assert.equal(place.lat, null, 'no coordinates unless LTB_LAT and LTB_LNG are configured');
});

test('LTB_LAT and LTB_LNG put it on the map', async () => {
  const repo = await room();
  await runnerFor(repo, fx('jsonld'), { LTB_LAT: '30.505', LTB_LNG: '-97.82' }).discover();
  const place = repo._t.place.find((p) => p.name === LTB_PLACE_NAME);
  assert.equal(place.lat, 30.505);
  assert.equal(place.geocode_source, 'config');
});

test('the classify stage never touches a party day', async () => {
  const repo = await room();
  const r = runnerFor(repo, fx('jsonld'));
  await r.discover();
  const c = await r.classify();
  assert.equal(c.tried, 0, 'groups are already set, so never-reprocess skips it');
});

test('turning party mode off withdraws it the same day, not in seven', async () => {
  const repo = await room();
  await runnerFor(repo, fx('jsonld')).discover();
  const id = repo._t.event.find((e) => e.title.includes('party mode')).id;
  assert.equal((await repo.eventById(id)).status, 'live');

  await runnerFor(repo, fx('none')).discover();
  const gone = await repo.eventById(id);
  assert.equal(gone.status, 'rejected');
  assert.equal(gone.reject_reason, 'withdrawn');

  // back on: restored, same row, same id
  await runnerFor(repo, fx('jsonld')).discover();
  const back = await repo.eventById(id);
  assert.equal(back.status, 'live');
  assert.equal(repo._t.event.filter((e) => e.title.includes('party mode')).length, 1, 'no duplicate row');
});

test('a page that half-matches withdraws nothing, because it cannot be trusted', async () => {
  const repo = await room();
  await runnerFor(repo, fx('jsonld')).discover();
  const id = repo._t.event.find((e) => e.title.includes('party mode')).id;
  const counts = await runnerFor(repo, fx('vague')).discover();
  assert.equal(counts.ltb.path, 'party_text_no_date');
  assert.equal(counts.ltb.withdrawn, 0);
  assert.equal((await repo.eventById(id)).status, 'live', 'an ambiguous page must not delete a real party day');
});

test('an unreachable LTB withdraws nothing', async () => {
  const repo = await room();
  await runnerFor(repo, fx('jsonld')).discover();
  const id = repo._t.event.find((e) => e.title.includes('party mode')).id;
  const counts = await runnerFor(repo, null).discover();
  assert.equal(counts.ltb.path, 'no_page');
  assert.equal((await repo.eventById(id)).status, 'live');
});

test('the party day shows up in the night read above the bar', async () => {
  const repo = await room();
  await repo.updateRoom('R1', { bar: 90 });
  await runnerFor(repo, fx('jsonld')).discover();
  const { createApp } = await import('../src/app.js');
  const { hashToken } = await import('../src/lib/auth.js');
  await repo.insertPerson({ id: 'P1', room_id: 'R1', display_name: 'Kevin', token_hash: await hashToken('aaaaaaaaaaaaaaaaaaaaaaaaaa'), groups: ['foodie'], default_view: 'foodie', visibility: 'mutual', created_at: '2026-09-01T00:00:00Z' });
  const app = createApp(repo, { APP_VERSION: 't' }, {});
  const res = await app.handle(new Request('https://x/api/night?date=2026-10-11&view=foodie', { headers: { authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaa' } }));
  const data = await res.json();
  assert.equal(data.events.length, 1);
  assert.ok(data.events[0].title.includes('party mode'));
  assert.deepEqual(data.fallback_places, [], 'a real event suppresses the fallback');
});
