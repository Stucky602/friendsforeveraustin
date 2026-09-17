import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, call, TOKENS, IDS } from './helpers.js';

test('night: who never counts a non-visible person, not even in a total', async () => {
  const { app } = await seed();
  // Kevin sees: self, Josh (mutual), Pat (public). Dana is one-way and invisible.
  const r = await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-24&view=odd');
  assert.equal(r.status, 200);
  const ids = r.data.who.around.map((p) => p.person_id).sort();
  assert.deepEqual(ids, [IDS.kevin, IDS.josh, IDS.pat].sort());
  assert.deepEqual(r.data.who.free.map((p) => p.person_id).sort(), [IDS.kevin, IDS.pat].sort());
  assert.ok(!JSON.stringify(r.data.who).includes('P_DANA'));
  assert.ok(!('total' in r.data.who) && !('count' in r.data.who));
});

test('night: away block removes a person from around', async () => {
  const { app } = await seed();
  const r = await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-21&view=odd');
  assert.ok(!r.data.who.around.some((p) => p.person_id === IDS.josh), 'Josh is away Sep 20-22');
});

test('night: events on the Chicago date above the bar; fallback empty when events exist', async () => {
  const { app } = await seed();
  const r = await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-24&view=odd');
  assert.equal(r.data.events.length, 1);
  assert.equal(r.data.events[0].id, IDS.event);
  assert.deepEqual(r.data.fallback_places, []);
  assert.equal(r.data.events[0].interest_count, 3);
  // Sep 25 in Chicago: the 00:30Z show belongs to the 24th, so nothing on the 25th
  const r2 = await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-25&view=odd');
  assert.equal(r2.data.events.length, 0);
});

test('night: bar filters; raising it drops the event and triggers fallback', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.josh, 'PUT', '/api/room', { bar: 90 })).status, 403);
  assert.equal((await call(app, TOKENS.kevin, 'PUT', '/api/room', { bar: 90 })).status, 200);
  const r = await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-24&view=odd');
  assert.equal(r.data.events.length, 0);
  assert.ok(r.data.fallback_places.length >= 1);
  const alamo = r.data.fallback_places.find((p) => p.id === IDS.place);
  assert.ok(alamo, 'vouched odd place appears');
  assert.ok(!('distance' in alamo) && !('drive_minutes' in alamo), 'no distance: home anchor never reaches the server');
  assert.ok('lat' in alamo && 'lng' in alamo);
});

test('night: fallback is view-scoped and vouched-only; foodie takes all vouched places', async () => {
  const { app, repo } = await seed();
  await repo.updateRoom(IDS.room, { bar: 100 });
  const kids = (await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-24&view=kids')).data.fallback_places.map((p) => p.id);
  assert.deepEqual(kids, [IDS.place2]);
  const foodie = (await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-24&view=foodie')).data.fallback_places.map((p) => p.id);
  assert.deepEqual(foodie, [IDS.place, IDS.place2], 'sorted by vouch count then loved');
});

test('night: includes my open plan on that date, excludes a non-member plan', async () => {
  const { app } = await seed();
  const k = await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-24&view=odd');
  assert.deepEqual(k.data.plans.map((p) => p.id), [IDS.plan]);
  const p = await call(app, TOKENS.pat, 'GET', '/api/night?date=2026-09-24&view=odd');
  assert.deepEqual(p.data.plans, []);
});

test('night: bad date or view is 400', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.kevin, 'GET', '/api/night?date=tomorrow&view=odd')).status, 400);
  assert.equal((await call(app, TOKENS.kevin, 'GET', '/api/night?date=2026-09-24&view=music')).status, 400);
});

test('upcoming: browses everything ahead and ignores the bar', async () => {
  const { app, repo } = await seed();
  await repo.updateRoom(IDS.room, { bar: 99 });
  const soon = new Date(Date.now() + 3 * 86400e3).toISOString();
  repo._t.event.push({ id: 'EV_LOW', place_id: IDS.place, title: 'Low scoring thing', starts_at: soon, ends_at: null, groups: JSON.stringify(['odd']), answers: '{}', score: 5, status: 'live', reject_reason: null, dedupe_key: 'k-low', raw: '{}', first_seen: 'x', last_seen: 'x' });
  const r = await call(app, TOKENS.kevin, 'GET', '/api/upcoming?view=odd');
  assert.equal(r.status, 200);
  assert.ok(r.data.events.some((e) => e.id === 'EV_LOW'), 'a low score demotes, it must not hide');
  // the night read still respects the bar
  const day = soon.slice(0, 10);
  const n = await call(app, TOKENS.kevin, `GET`, `/api/night?date=${day}&view=odd`);
  assert.equal(n.data.events.length, 0);
});

test('upcoming: view=all crosses every group, and results are date ordered', async () => {
  const { app, repo } = await seed();
  const mk = (id, days, groups, score) => repo._t.event.push({ id, place_id: IDS.place, title: id, starts_at: new Date(Date.now() + days * 86400e3).toISOString(), ends_at: null, groups: JSON.stringify(groups), answers: '{}', score, status: 'live', reject_reason: null, dedupe_key: `k-${id}`, raw: '{}', first_seen: 'x', last_seen: 'x' });
  mk('LATE', 10, ['foodie'], 50);
  mk('EARLY', 2, ['kids'], 50);
  const all = (await call(app, TOKENS.kevin, 'GET', '/api/upcoming?view=all')).data.events.map((e) => e.id);
  assert.ok(all.includes('LATE') && all.includes('EARLY'));
  assert.ok(all.indexOf('EARLY') < all.indexOf('LATE'), 'date order');
  const kids = (await call(app, TOKENS.kevin, 'GET', '/api/upcoming?view=kids')).data.events.map((e) => e.id);
  assert.ok(kids.includes('EARLY') && !kids.includes('LATE'));
});

test('upcoming: past events are excluded, gated names still gated', async () => {
  const { app, repo } = await seed();
  repo._t.event.push({ id: 'OLD', place_id: IDS.place, title: 'Last week', starts_at: new Date(Date.now() - 8 * 86400e3).toISOString(), ends_at: null, groups: JSON.stringify(['odd']), answers: '{}', score: 90, status: 'live', reject_reason: null, dedupe_key: 'k-old', raw: '{}', first_seen: 'x', last_seen: 'x' });
  const r = await call(app, TOKENS.dana, 'GET', '/api/upcoming?view=all');
  assert.ok(!r.data.events.some((e) => e.id === 'OLD'));
  const ev = r.data.events.find((e) => e.id === IDS.event);
  if (ev) assert.ok(!ev.interested.some((p) => p.person_id === IDS.josh), 'Dana is not mutual with Josh');
});
