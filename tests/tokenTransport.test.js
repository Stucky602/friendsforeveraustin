import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seed, call, TOKENS } from './helpers.js';

test('token is read from the Authorization header only', () => {
  const src = readFileSync('src/app.js', 'utf8') + readFileSync('src/lib/auth.js', 'utf8');
  assert.ok(!/searchParams\.get\(\s*['"]token['"]/.test(src));
  assert.ok(!/params\.token/.test(src));
  assert.ok(!/body\.token/.test(src));
  assert.ok(!/pathname.*token/.test(src));
});

test('a token in the query string is ignored', async () => {
  const { app } = await seed();
  const r = await call(app, null, 'GET', `/api/me?token=${TOKENS.kevin}`);
  assert.equal(r.status, 401);
});

test('personal link puts the token in the fragment, never the path or query', async () => {
  const { app } = await seed();
  const r = await call(app, TOKENS.kevin, 'POST', '/api/admin/people', { display_name: 'New' });
  assert.equal(r.status, 201);
  const u = new URL(r.data.link);
  assert.equal(u.pathname, '/');
  assert.equal(u.search, '');
  assert.match(u.hash, /^#\/join\/[a-z2-7]{26}$/);
});

test('the token hash never reaches the client', async () => {
  const { app } = await seed();
  for (const path of ['/api/me', '/api/people']) {
    const r = await call(app, TOKENS.kevin, 'GET', path);
    assert.ok(!JSON.stringify(r.data).includes('token_hash'), `${path} leaks token_hash`);
  }
  const put = await call(app, TOKENS.kevin, 'PUT', '/api/me', { display_name: 'Kevin' });
  assert.ok(!JSON.stringify(put.data).includes('token_hash'));
  const made = await call(app, TOKENS.kevin, 'POST', '/api/admin/people', { display_name: 'New' });
  assert.ok(!JSON.stringify(made.data.person).includes('token_hash'));
});
