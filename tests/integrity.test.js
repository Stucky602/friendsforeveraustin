import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, IDS } from './helpers.js';

// ARCHITECTURE.md §1.3: no FK constraints are declared; integrity is a test.
test('fixture: every foreign key resolves and no merge chains exist', async () => {
  const { repo } = await seed();
  const t = repo._t;
  const persons = new Set(t.person.map((p) => p.id));
  const places = new Set(t.place.map((p) => p.id));
  const events = new Set(t.event.map((e) => e.id));
  const plans = new Set(t.plan.map((p) => p.id));
  for (const e of t.event) assert.ok(places.has(e.place_id), `event ${e.id} place`);
  for (const v of t.vouch) { assert.ok(places.has(v.place_id)); assert.ok(persons.has(v.person_id)); }
  for (const r of t.review) { assert.ok(places.has(r.place_id)); assert.ok(persons.has(r.person_id)); }
  for (const i of t.interest) assert.ok((i.target_type === 'event' ? events : places).has(i.target_id));
  for (const tk of t.tick) { assert.ok(persons.has(tk.from_person_id)); assert.ok(persons.has(tk.to_person_id)); }
  for (const p of t.plan) assert.ok((p.target_type === 'event' ? events : places).has(p.target_id));
  for (const m of t.plan_member) { assert.ok(plans.has(m.plan_id)); assert.ok(persons.has(m.person_id)); }
  for (const p of t.place) if (p.merged_into) { const target = t.place.find((x) => x.id === p.merged_into); assert.ok(target && !target.merged_into, 'no merge chains'); }
  assert.ok(persons.has(t.room[0].owner_person_id));
});

test('placeById follows a merge to the survivor and never returns merged_into', async () => {
  const { repo, app } = await seed();
  repo._t.place.push({ id: 'PL_OLD', name: 'Alamo S Lamar', address: null, lat: null, lng: null, neighborhood: null, groups: '[]', canonical_key: 'alamo s lamar|', geocode_source: null, geocoded_at: null, created_by: 'pipeline', merged_into: IDS.place, created_at: '2026-09-01T00:00:00Z' });
  const p = await repo.placeById('PL_OLD');
  assert.equal(p.id, IDS.place);
});
