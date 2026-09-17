import test from 'node:test';
import assert from 'node:assert/strict';
import { canSelfTransition, completeMembers, isDue, inReaskWindow, planText } from '../src/lib/plans.js';
import { seed, call, TOKENS, IDS } from './helpers.js';

test('open plan: exactly the allowed self transitions', () => {
  const ok = [['maybe', 'in'], ['maybe', 'out'], ['in', 'out'], ['out', 'in']];
  for (const [f, t] of ok) assert.ok(canSelfTransition('open', f, t), `${f}->${t}`);
  const bad = [['maybe', 'went'], ['in', 'went'], ['out', 'went'], ['went', 'out'], ['in', 'maybe'], ['out', 'maybe'], ['in', 'in']];
  for (const [f, t] of bad) assert.ok(!canSelfTransition('open', f, t), `${f}->${t} must be refused`);
});

test('done plan: only went -> out', () => {
  assert.ok(canSelfTransition('done', 'went', 'out'));
  for (const [f, t] of [['maybe', 'in'], ['in', 'out'], ['out', 'in'], ['went', 'in'], ['maybe', 'went']]) assert.ok(!canSelfTransition('done', f, t));
  assert.ok(!canSelfTransition('dropped', 'maybe', 'in'));
});

test('completion: in -> went, maybe and out untouched', () => {
  const r = completeMembers([{ person_id: 'a', state: 'in' }, { person_id: 'b', state: 'maybe' }, { person_id: 'c', state: 'out' }]);
  assert.deepEqual(r.map((m) => m.state), ['went', 'maybe', 'out']);
});

test('due at starts_at + 6h; re-ask window is (0, 48h]', () => {
  const p = { status: 'open', starts_at: '2026-09-25T00:30:00Z' };
  const start = Date.parse(p.starts_at);
  assert.ok(!isDue(p, start + 5 * 3600e3));
  assert.ok(isDue(p, start + 6 * 3600e3));
  assert.ok(inReaskWindow(p, 'maybe', start - 47 * 3600e3));
  assert.ok(!inReaskWindow(p, 'maybe', start - 49 * 3600e3));
  assert.ok(!inReaskWindow(p, 'out', start - 1 * 3600e3));
  assert.ok(!inReaskWindow(p, 'in', start + 1));
});

test('route: transitions enforced, owner-only edits, add requires mutual', async () => {
  const { app } = await seed();
  // Josh is 'maybe'
  assert.equal((await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}/me`, { state: 'went' })).status, 400);
  assert.equal((await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}/me`, { state: 'in' })).status, 200);
  assert.equal((await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}/me`, { state: 'in' })).status, 400, 'in->in refused');
  assert.equal((await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}`, { starts_at: '2026-09-26T00:00:00Z' })).status, 403);
  assert.equal((await call(app, TOKENS.kevin, 'PUT', `/api/plans/${IDS.plan}`, { add_member_ids: [IDS.dana] })).status, 400, 'Dana is not mutual with Kevin');
  assert.equal((await call(app, TOKENS.kevin, 'PUT', `/api/plans/${IDS.plan}`, { status: 'done' })).status, 400, 'only dropped');
});

test('done: automatic at +6h, in becomes went, maybe untouched, then only went->out', async () => {
  const { app, repo } = await seed();
  await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}/me`, { state: 'in' });
  await repo.insertPlan({ id: 'PLAN2', room_id: IDS.room, owner_person_id: IDS.kevin, target_type: 'place', target_id: IDS.place, starts_at: '2026-09-25T00:30:00Z', status: 'open', created_at: '2026-09-10T00:00:00Z', done_at: null }, [{ person_id: IDS.kevin, state: 'in' }, { person_id: IDS.josh, state: 'maybe' }]);
  const n = await repo.completeDuePlans(Date.parse('2026-09-25T07:00:00Z'));
  assert.equal(n, 2);
  const p1 = (await call(app, TOKENS.kevin, 'GET', `/api/plans/${IDS.plan}`)).data.plan;
  assert.equal(p1.status, 'done');
  assert.deepEqual(Object.fromEntries(p1.members.map((m) => [m.person_id, m.state])), { [IDS.kevin]: 'went', [IDS.josh]: 'went' });
  const p2 = (await call(app, TOKENS.kevin, 'GET', '/api/plans/PLAN2')).data.plan;
  assert.deepEqual(Object.fromEntries(p2.members.map((m) => [m.person_id, m.state])), { [IDS.kevin]: 'went', [IDS.josh]: 'maybe' });
  assert.equal((await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}/me`, { state: 'out' })).status, 200, 'went->out correction');
  assert.equal((await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}/me`, { state: 'in' })).status, 400);
});

test('vouch prompt fires once per (person, place) and never twice', async () => {
  const { app, repo } = await seed();
  await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}/me`, { state: 'in' });
  // before done: not earned via went, but Josh has a loved review of PL1 -> earned; he already vouched PL1 though -> no offer
  assert.deepEqual((await call(app, TOKENS.josh, 'POST', `/api/places/${IDS.place}/vouch-prompt`)).data, { offer: false });
  // Kevin: no review, plan not done -> not earned
  assert.deepEqual((await call(app, TOKENS.kevin, 'POST', `/api/places/${IDS.place}/vouch-prompt`)).data, { offer: false });
  await repo.completeDuePlans(Date.parse('2026-09-25T07:00:00Z'));
  assert.deepEqual((await call(app, TOKENS.kevin, 'POST', `/api/places/${IDS.place}/vouch-prompt`)).data, { offer: true });
  assert.deepEqual((await call(app, TOKENS.kevin, 'POST', `/api/places/${IDS.place}/vouch-prompt`)).data, { offer: false }, 'second ask never offers');
});

test('pasteable block matches the fixed format', async () => {
  const { app } = await seed();
  await call(app, TOKENS.josh, 'PUT', `/api/plans/${IDS.plan}/me`, { state: 'in' });
  const r = await call(app, TOKENS.kevin, 'GET', `/api/plans/${IDS.plan}/text`);
  assert.equal(r.status, 200);
  const lines = r.data.split('\n');
  assert.equal(lines[0], 'Thu Sep 24, 7:30 PM');
  assert.equal(lines[1], 'Terror Tuesday: The Cat');
  assert.equal(lines[2], 'Alamo Drafthouse South Lamar, 1120 S Lamar Blvd, Austin, TX');
  assert.equal(lines[3], 'In: Kevin, Josh.');
  assert.equal(lines[4], '$ · loud');
  assert.match(lines[5], /^https:\/\/room\.test\/#\/plan\/PLAN1$/);
  assert.ok(!r.data.includes('unknown'));
});

test('planText omits empty who and answers lines', () => {
  const t = planText({ whenLabel: 'W', title: 'T', locationLine: '', members: [{ display_name: 'A', state: 'out' }], answerLabels: [], link: 'L' });
  assert.equal(t, 'W\nT\nL');
});
