import test from 'node:test';
import assert from 'node:assert/strict';
import { normName, normAddr, canonicalKey, normTitle, chicagoDate, dedupeKey, shouldAttach, jaccard, titleTokens } from '../src/lib/normalize.js';

test('normName strips the, trailing austin/atx, punctuation', () => {
  assert.equal(normName('The Alamo Drafthouse - Austin'), 'alamo drafthouse');
  assert.equal(normName("Franklin's BBQ (Austin)"), 'franklin s bbq');
  assert.equal(normName('Thicket Food Park ATX'), 'thicket food park');
  assert.equal(normName('  Blanton   Museum  '), 'blanton museum');
});

test('normAddr keeps number + first street token, drops directionals', () => {
  assert.equal(normAddr('1120 S Lamar Blvd, Austin, TX 78704'), '1120 lamar');
  assert.equal(normAddr('7800 S 1st St'), '7800 1st');
  assert.equal(normAddr('200 E Riverside Dr'), '200 riverside');
  assert.equal(normAddr(''), '');
  assert.equal(normAddr('Downtown'), '');
});

test('canonicalKey: same venue from two sources collides, chains do not', () => {
  assert.equal(canonicalKey('Alamo Drafthouse South Lamar', '1120 S Lamar Blvd'), canonicalKey('The Alamo Drafthouse South Lamar - Austin', '1120 South Lamar Boulevard'));
  assert.notEqual(canonicalKey('Torchys Tacos', '1822 S Congress'), canonicalKey('Torchys Tacos', '2801 Guadalupe'));
});

test('normTitle drops filler tokens and parentheticals', () => {
  assert.equal(normTitle('Alamo presents Terror Tuesday: The Cat (35mm)'), 'alamo terror tuesday cat 35mm'.replace(' 35mm', ''));
  assert.equal(normTitle('Weird Wednesday w/ Gremlins 2 [sold out]'), 'weird wednesday gremlins 2');
  assert.equal(normTitle('A Night & The Day featuring X'), 'night day x');
});

test('chicagoDate: 12:30am UTC-5 show is the previous local day', () => {
  assert.equal(chicagoDate('2026-09-25T00:30:00Z'), '2026-09-24');
  assert.equal(chicagoDate('2026-09-25T06:00:00Z'), '2026-09-25');
  assert.equal(chicagoDate('2026-01-15T05:30:00Z'), '2026-01-14'); // CST, UTC-6
  assert.throws(() => chicagoDate('garbage'));
});

test('dedupeKey is deterministic and date-aware', () => {
  const a = dedupeKey('PL1', '2026-09-25T00:30:00Z', 'Terror Tuesday: The Cat');
  const b = dedupeKey('PL1', '2026-09-25T01:00:00Z', 'The Terror Tuesday - The Cat');
  assert.equal(a, b);
  assert.equal(a, 'PL1|2026-09-24|terror tuesday cat');
  assert.notEqual(a, dedupeKey('PL1', '2026-09-26T00:30:00Z', 'Terror Tuesday: The Cat'));
});

test('attach: the three pinned cases', () => {
  assert.ok(shouldAttach('Terror Tuesday: The Cat', 'Terror Tuesday: The Cat'), 'identical');
  assert.ok(shouldAttach('Alamo presents Terror Tuesday: The Cat', 'Terror Tuesday: The Cat'), 'X presents Y vs Y');
  assert.ok(!shouldAttach('Terror Tuesday: The Cat', 'Weird Wednesday: Gremlins 2'), 'two different shows');
  assert.equal(jaccard(titleTokens('x y z'), titleTokens('x y w')), 0.5);
});
