import test from 'node:test';
import assert from 'node:assert/strict';
import { newToken, isTokenShape, hashToken, bearerFrom } from '../src/lib/auth.js';
import { seed, call, TOKENS, IDS } from './helpers.js';

test('token is 26 lowercase base32 chars and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const t = newToken(); assert.ok(isTokenShape(t), t); seen.add(t); }
  assert.equal(seen.size, 200);
});

test('hash is sha256 hex and stable', async () => {
  const h = await hashToken('aaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await hashToken('aaaaaaaaaaaaaaaaaaaaaaaaaa'));
});

test('bearer parsing is strict', () => {
  const mk = (v) => new Request('https://x/', { headers: v ? { authorization: v } : {} });
  assert.equal(bearerFrom(mk()), null);
  assert.equal(bearerFrom(mk('Bearer short')), null);
  assert.equal(bearerFrom(mk('Bearer AAAAAAAAAAAAAAAAAAAAAAAAAA')), 'aaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(bearerFrom(mk('Token aaaaaaaaaaaaaaaaaaaaaaaaaa')), null);
});

test('regenerate kills the old token immediately; owner only', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.josh, 'POST', `/api/admin/people/${IDS.dana}/regenerate`)).status, 403);
  const r = await call(app, TOKENS.kevin, 'POST', `/api/admin/people/${IDS.josh}/regenerate`);
  assert.equal(r.status, 200);
  assert.equal((await call(app, TOKENS.josh, 'GET', '/api/me')).status, 401);
  const newTok = new URL(r.data.link).hash.split('/').pop();
  assert.equal((await call(app, newTok, 'GET', '/api/me')).status, 200);
});

test('remove: owner only, cannot remove self, ticks die both ways', async () => {
  const { app, repo } = await seed();
  assert.equal((await call(app, TOKENS.josh, 'POST', `/api/admin/people/${IDS.dana}/remove`)).status, 403);
  assert.equal((await call(app, TOKENS.kevin, 'POST', `/api/admin/people/${IDS.kevin}/remove`)).status, 404);
  assert.equal((await call(app, TOKENS.kevin, 'POST', `/api/admin/people/${IDS.josh}/remove`)).status, 204);
  assert.deepEqual(await repo.ticksFrom(IDS.josh), []);
  assert.deepEqual(await repo.ticksTo(IDS.josh), []);
  assert.equal((await call(app, TOKENS.josh, 'GET', '/api/me')).status, 401);
  const me = (await call(app, TOKENS.kevin, 'GET', '/api/me')).data;
  assert.deepEqual(me.mutual_ids, []);
});

test('bootstrap: secret-guarded, once only', async () => {
  const { app } = await seed();
  assert.equal((await call(app, null, 'POST', '/api/bootstrap', { owner_name: 'X' })).status, 403);
  const r = await call(app, null, 'POST', '/api/bootstrap', { owner_name: 'X' }, { 'x-bootstrap-secret': 'boot' });
  assert.equal(r.status, 409, 'a room already exists in the fixture');
});

test('adding a person: owner only, validated, link is usable immediately', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.josh, 'POST', '/api/admin/people', { display_name: 'Nope' })).status, 403);
  assert.equal((await call(app, TOKENS.kevin, 'POST', '/api/admin/people', { display_name: '' })).status, 400);
  const r = await call(app, TOKENS.kevin, 'POST', '/api/admin/people', { display_name: 'Dana R', groups: ['kids', 'bogus'] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.person.groups, ['kids'], 'unknown groups are dropped, not rejected');
  assert.equal(r.data.person.default_view, 'kids', 'defaults to the first group picked');
  const token = new URL(r.data.link).hash.split('/').pop();
  const me = await call(app, token, 'GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.person.display_name, 'Dana R');
  assert.equal(me.data.is_owner, false);
  assert.ok((await call(app, TOKENS.kevin, 'GET', '/api/people')).data.people.some((p) => p.display_name === 'Dana R'));
});
