import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(jsx?|html|css)$/.test(p)) out.push(p); } return out; }
const BANNED = ['genuinely', 'vibe', 'curated', 'unlock'];

test('no banned words or exclamation marks in user-facing strings', () => {
  for (const f of [...walk('src'), ...walk('client'), 'index.html']) {
    const s = readFileSync(f, 'utf8');
    for (const w of BANNED) assert.ok(!new RegExp(`(?<![\\w-])${w}(?![\\w-])`, 'i').test(s), `${f} contains ${w}`);
    // exclamation marks inside string literals only
    for (const m of s.matchAll(/(['"`])((?:\\\1|.)*?)\1/g)) assert.ok(!m[2].replace(/!=/g, '').includes('!'), `${f}: exclamation in string: ${m[2].slice(0, 40)}`);
  }
});
