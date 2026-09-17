import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, call, TOKENS, IDS } from './helpers.js';

test('edit/delete another person\'s review is 404, never 403', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.kevin, 'PUT', '/api/reviews/RV_JOSH', { text: 'x' })).status, 404);
  assert.equal((await call(app, TOKENS.kevin, 'DELETE', '/api/reviews/RV_JOSH')).status, 404);
  assert.equal((await call(app, TOKENS.josh, 'PUT', '/api/reviews/RV_JOSH', { verdict: 'fine' })).status, 200);
  assert.equal((await call(app, TOKENS.josh, 'DELETE', '/api/reviews/RV_JOSH')).status, 204);
});

test('create review validates verdict and date; many per person per place', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.kevin, 'POST', `/api/places/${IDS.place}/reviews`, { verdict: 'great' })).status, 400);
  assert.equal((await call(app, TOKENS.kevin, 'POST', `/api/places/${IDS.place}/reviews`, { verdict: 'loved', visited_on: 'yesterday' })).status, 400);
  assert.equal((await call(app, TOKENS.kevin, 'POST', `/api/places/${IDS.place}/reviews`, { verdict: 'loved', visited_on: '2026-09-01', text: 'a' })).status, 201);
  assert.equal((await call(app, TOKENS.kevin, 'POST', `/api/places/${IDS.place}/reviews`, { verdict: 'fine', text: 'b' })).status, 201);
  const p = (await call(app, TOKENS.kevin, 'GET', `/api/places/${IDS.place}`)).data.place;
  assert.equal(p.review_count, 4);
  assert.deepEqual(p.verdicts, { loved: 2, fine: 1, bounced: 1 });
});

test('a removed person\'s reviews still count but never appear', async () => {
  const { app, repo } = await seed();
  await repo.insertReview({ id: 'RV_GONE', place_id: IDS.place2, person_id: IDS.gone, visited_on: null, verdict: 'loved', text: 'secret', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' });
  for (const t of [TOKENS.kevin, TOKENS.pat, TOKENS.dana]) {
    const p = (await call(app, t, 'GET', `/api/places/${IDS.place2}`)).data.place;
    assert.equal(p.review_count, 2);
    assert.equal(p.verdicts.loved, 1);
    assert.ok(!p.reviews.some((r) => r.person_id === IDS.gone));
    assert.ok(!JSON.stringify(p).includes('secret'));
  }
});

test('no per-person review listing route exists', async () => {
  const { app } = await seed();
  assert.equal((await call(app, TOKENS.kevin, 'GET', '/api/reviews')).status, 404);
  assert.equal((await call(app, TOKENS.kevin, 'GET', `/api/people/${IDS.josh}/reviews`)).status, 404);
});
