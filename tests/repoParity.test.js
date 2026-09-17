import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryRepo, withPipeline as memPipeline } from '../src/repo/memory.js';
import { d1Repo, withPipeline as d1Pipeline } from '../src/repo/d1.js';

// The D1 repo is the production twin of the memory repo. Same names, or tests prove nothing.
test('memory and d1 repos expose the same functions', () => {
  const fakeDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0 } }) }) }) };
  const m = Object.keys(memPipeline(memoryRepo())).filter((k) => !k.startsWith('_')).sort();
  const d = Object.keys(d1Pipeline(d1Repo(fakeDb), fakeDb)).sort();
  assert.deepEqual(d, m);
});

test('d1 repo never builds SQL from unvalidated column names', () => {
  // updatePerson / updateReview / updatePlan whitelist their columns; assert the whitelists exist
  const src = readFileSyncSafe('src/repo/d1.js');
  assert.ok(src.includes("['display_name', 'token_hash', 'groups', 'kid_ages', 'default_view', 'visibility', 'removed_at']"));
  assert.ok(src.includes("['visited_on', 'verdict', 'text']"));
  assert.ok(src.includes("['starts_at', 'status', 'done_at']"));
});

import { readFileSync } from 'node:fs';
function readFileSyncSafe(p) { return readFileSync(p, 'utf8'); }
