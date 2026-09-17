import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; }

test('no push channel exists anywhere in src', () => {
  for (const f of walk('src')) {
    const s = readFileSync(f, 'utf8');
    for (const bad of ['Notification', 'PushManager', 'pushManager', 'showNotification']) assert.ok(!s.includes(bad), `${f} mentions ${bad}`);
  }
});
