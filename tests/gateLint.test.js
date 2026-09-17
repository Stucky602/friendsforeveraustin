import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// CONTRACTS.md §5: nothing outside gate.js may call the repo functions that return gated rows.
const GATED_CALLS = ['ticksFrom', 'ticksTo', 'availability(', '.reviews(', '.vouches(', '.interests(', 'planMembers'];
const ALLOWED = new Set(['src/lib/gate.js', 'src/repo/memory.js', 'src/repo/d1.js']);

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('only gate.js touches gated repo functions', () => {
  const offenders = [];
  for (const file of walk('src')) {
    if (ALLOWED.has(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const call of GATED_CALLS) {
      // repo.X( or repo.X ( — the repo object is always named repo in routes
      const re = new RegExp(`repo\\.${call.replace('(', '\\(').replace('.', '')}`);
      if (re.test(src)) offenders.push(`${file}: repo.${call}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('routes never read kid_ages off a person they did not get from the gate', () => {
  const src = readFileSync('src/app.js', 'utf8');
  // app.js may only mention kid_ages when validating the viewer's own PUT /api/me body
  const lines = src.split('\n').filter((l) => l.includes('kid_ages'));
  for (const l of lines) assert.ok(l.includes("'kid_ages' in b") || l.includes('b.kid_ages'), `unexpected kid_ages use: ${l.trim()}`);
});
