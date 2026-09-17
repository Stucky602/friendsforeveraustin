import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, call, TOKENS, IDS, GATED_PERSON_KEYS } from './helpers.js';

const byId = (rows, id) => rows.find((r) => r.id === id || r.person_id === id);

test('roster: gated fields only for self, mutual, and public subjects', async () => {
  const { app } = await seed();
  const { status, data } = await call(app, TOKENS.kevin, 'GET', '/api/people');
  assert.equal(status, 200);
  const people = data.people;
  assert.ok(!byId(people, IDS.gone), 'removed person is off the roster');
  for (const id of [IDS.kevin, IDS.josh, IDS.pat]) {
    const row = byId(people, id);
    for (const k of GATED_PERSON_KEYS) assert.ok(k in row, `${id} should expose ${k}`);
  }
  const dana = byId(people, IDS.dana);
  for (const k of GATED_PERSON_KEYS) assert.ok(!(k in dana), `one-way tick must not expose ${k}`);
  assert.equal(dana.visibility, 'mutual');
  assert.equal(byId(people, IDS.pat).visibility, 'public');
});

test('one-way tick reveals nothing in either direction', async () => {
  const { app } = await seed();
  // Dana ticked Kevin. Kevin sees nothing of Dana; Dana sees nothing of Kevin.
  const k = (await call(app, TOKENS.kevin, 'GET', '/api/people')).data.people;
  const d = (await call(app, TOKENS.dana, 'GET', '/api/people')).data.people;
  for (const key of GATED_PERSON_KEYS) {
    assert.ok(!(key in byId(k, IDS.dana)));
    assert.ok(!(key in byId(d, IDS.kevin)));
  }
  // and the API never says "they ticked you"
  const me = (await call(app, TOKENS.kevin, 'GET', '/api/me')).data;
  assert.deepEqual(me.mutual_ids, [IDS.josh]);
  assert.ok(!('ticked_you' in me) && !JSON.stringify(me).includes('P_DANA'));
});

test('owner has no extra read access', async () => {
  const { app } = await seed();
  const people = (await call(app, TOKENS.kevin, 'GET', '/api/people')).data.people;
  const dana = byId(people, IDS.dana);
  for (const k of GATED_PERSON_KEYS) assert.ok(!(k in dana));
});

test('places: counts public, identities gated, public subject visible to a stranger', async () => {
  const { app } = await seed();
  // Dana is mutual with nobody. She should see counts and Pat's rows only.
  const { data } = await call(app, TOKENS.dana, 'GET', '/api/places');
  const alamo = byId(data.places, IDS.place);
  assert.equal(alamo.vouch_count, 2);
  assert.equal(alamo.review_count, 2);
  assert.deepEqual(alamo.verdicts, { loved: 1, fine: 0, bounced: 1 });
  // her own review is visible to her; Josh's is not
  assert.deepEqual(alamo.reviews.map((r) => r.person_id), [IDS.dana]);
  assert.deepEqual(alamo.vouchers.map((r) => r.person_id), [IDS.dana]);
  const thicket = byId(data.places, IDS.place2);
  assert.equal(thicket.vouch_count, 2, 'removed person still counts');
  assert.deepEqual(thicket.vouchers.map((r) => r.person_id), [IDS.pat], 'public Pat visible, removed Gone never');
  assert.deepEqual(thicket.reviews.map((r) => r.person_id), [IDS.pat]);
  assert.ok(!('merged_into' in alamo));
});

test('events: interest count public, interested rows gated', async () => {
  const { app } = await seed();
  const k = (await call(app, TOKENS.kevin, 'GET', '/api/events?view=odd')).data.events;
  const ev = byId(k, IDS.event);
  assert.equal(ev.interest_count, 3);
  assert.deepEqual(ev.interested.map((r) => r.person_id).sort(), [IDS.josh, IDS.pat].sort());
  const d = (await call(app, TOKENS.dana, 'GET', '/api/events?view=odd')).data.events;
  assert.deepEqual(byId(d, IDS.event).interested.map((r) => r.person_id).sort(), [IDS.dana, IDS.pat].sort(), 'self is always visible; Josh is not');
});

test('public flag: flipping back re-gates on the very next request', async () => {
  const { app } = await seed();
  let d = (await call(app, TOKENS.dana, 'GET', '/api/people')).data.people;
  assert.ok('groups' in byId(d, IDS.pat));
  assert.equal((await call(app, TOKENS.pat, 'PUT', '/api/me', { visibility: 'mutual' })).status, 200);
  d = (await call(app, TOKENS.dana, 'GET', '/api/people')).data.people;
  assert.ok(!('groups' in byId(d, IDS.pat)));
  assert.equal((await call(app, TOKENS.pat, 'PUT', '/api/me', { visibility: 'everyone' })).status, 400);
});

test('public person cannot be added to a plan by a non-mutual', async () => {
  const { app } = await seed();
  const r = await call(app, TOKENS.dana, 'POST', '/api/plans', { target_type: 'place', target_id: IDS.place, starts_at: '2026-09-30T01:00:00Z', member_ids: [IDS.pat] });
  assert.equal(r.status, 400);
  assert.equal(r.data.detail, 'member_not_mutual');
});

test('plans: members only, 404 not 403 for outsiders, unaffected by public', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.josh, 'GET', `/api/plans/${IDS.plan}`)).status, 200);
  assert.equal((await call(app, TOKENS.pat, 'GET', `/api/plans/${IDS.plan}`)).status, 404);
  assert.equal((await call(app, TOKENS.dana, 'GET', `/api/plans/${IDS.plan}`)).status, 404);
  assert.equal((await call(app, TOKENS.dana, 'GET', `/api/plans/${IDS.plan}/text`)).status, 404);
  const list = (await call(app, TOKENS.pat, 'GET', '/api/plans')).data.plans;
  assert.equal(list.length, 0);
});

test('plan membership discloses names and states, nothing else', async () => {
  const { app } = await seed();
  const plan = (await call(app, TOKENS.josh, 'GET', `/api/plans/${IDS.plan}`)).data.plan;
  for (const m of plan.members) assert.deepEqual(Object.keys(m).sort(), ['display_name', 'person_id', 'state']);
});

test('removed person: token dead, invisible everywhere', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.gone, 'GET', '/api/me')).status, 401);
  const people = (await call(app, TOKENS.kevin, 'GET', '/api/people')).data.people;
  assert.ok(!byId(people, IDS.gone));
});

test('a removed public person is still invisible', async () => {
  const { app, repo } = await seed();
  await repo.updatePerson(IDS.gone, { visibility: 'public' });
  const { data } = await call(app, TOKENS.dana, 'GET', '/api/places');
  assert.deepEqual(byId(data.places, IDS.place2).vouchers.map((r) => r.person_id), [IDS.pat]);
});

test('bad or missing token is 401 with the one sentence', async () => {
  const { app } = await seed();
  const r = await call(app, null, 'GET', '/api/me');
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'token');
  assert.equal((await call(app, 'zzzzzzzzzzzzzzzzzzzzzzzzzz', 'GET', '/api/me')).status, 401);
});

test('is_owner is true only for the room owner', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.kevin, 'GET', '/api/me')).data.is_owner, true);
  assert.equal((await call(app, TOKENS.josh, 'GET', '/api/me')).data.is_owner, false);
});
