import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAnswers, answerLabels } from '../src/lib/answers.js';

const TEXT = 'Terror Tuesday: The Cat. $10 tickets. Lot parking behind the theater. It gets loud.';
const good = () => ({
  groups: ['odd'],
  reject: null,
  answers: {
    cost: { value: '$', confidence: 0.9, evidence: '$10' },
    parking: { value: 'lot', confidence: 0.8, evidence: 'Lot parking' },
    loud: { value: 'loud', confidence: 0.7, evidence: 'loud' },
    kid_ok: { value: 'unknown', confidence: 0.1, evidence: '' },
  },
});

test('valid response passes and is normalized', () => {
  const r = validateAnswers(good(), TEXT);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.value.groups, ['odd']);
  assert.equal(r.value.answers.cost.confidence, 0.9);
});

test('invented evidence is rejected', () => {
  const g = good(); g.answers.cost.evidence = 'ten dollars';
  assert.equal(validateAnswers(g, TEXT).error, 'evidence_not_verbatim:cost');
});

test('unknown with evidence or high confidence is rejected', () => {
  let g = good(); g.answers.kid_ok = { value: 'unknown', confidence: 0.1, evidence: 'loud' };
  assert.equal(validateAnswers(g, TEXT).error, 'unknown_with_evidence:kid_ok');
  g = good(); g.answers.kid_ok = { value: 'unknown', confidence: 0.5, evidence: '' };
  assert.equal(validateAnswers(g, TEXT).error, 'unknown_with_evidence:kid_ok');
});

test('empty groups without reject is rejected; with reject passes', () => {
  let g = good(); g.groups = [];
  assert.equal(validateAnswers(g, TEXT).error, 'empty_groups_without_reject');
  g.reject = { reason: 'no_group' };
  assert.ok(validateAnswers(g, TEXT).ok);
});

test('unknown enum values, extra keys, bad groups', () => {
  let g = good(); g.answers.cost.value = 'cheap';
  assert.equal(validateAnswers(g, TEXT).error, 'bad_value:cost');
  g = good(); g.answers.vibe = { value: 'x', confidence: 1, evidence: '' };
  assert.equal(validateAnswers(g, TEXT).error, 'extra_answer:vibe');
  g = good(); g.groups = ['music'];
  assert.equal(validateAnswers(g, TEXT).error, 'bad_group:music');
  g = good(); g.reject = { reason: 'boring' };
  assert.equal(validateAnswers(g, TEXT).error, 'bad_reject');
});

test('labels: view keys only, confidence floor, unknown never rendered', () => {
  const a = good().answers;
  assert.deepEqual(answerLabels(a, 'odd'), ['$', 'loud']);
  assert.deepEqual(answerLabels(a, 'kids'), ['$']); // kid_ok unknown omitted
  assert.deepEqual(answerLabels(a, 'foodie'), ['$']);
  a.loud.confidence = 0.5;
  assert.deepEqual(answerLabels(a, 'odd'), ['$']);
});
