import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(jsx?|css|html)$/.test(p)) out.push(p); } return out; }
const client = walk('client').map((f) => [f, readFileSync(f, 'utf8')]);

test('four tabs for everyone, a fifth only for the owner', () => {
  const app = client.find(([f]) => f.endsWith('App.jsx'))[1];
  const ids = [...app.matchAll(/\{ id: '(\w+)', label: '([\w ]+)' \}/g)].map((m) => m[2]);
  assert.deepEqual(ids, ['Map', 'Calendar', 'People', 'Plans', 'Sources']);
  assert.match(app, /me\.is_owner \? \[\.\.\.TABS, \{ id: 'pipeline'/, 'the fifth tab is owner-gated');
  for (const id of ['map', 'calendar', 'people', 'plans', 'pipeline']) {
    assert.ok(app.includes(`tab === '${id}'`), `no panel rendered for ${id}`);
  }
});

test('every tab file the shell imports exists', () => {
  const files = new Set(client.map(([f]) => f.replace(/\\/g, '/')));
  for (const [file, src] of client) {
    for (const m of src.matchAll(/from '(\.[^']+\.jsx?)'/g)) {
      const base = file.split('/').slice(0, -1).join('/');
      const target = new URL(m[1], `file:///${base}/`).pathname.slice(1);
      assert.ok(files.has(target), `${file} imports missing ${m[1]}`);
    }
  }
});

test('no copy names a surface that does not exist', () => {
  const all = client.map(([, s]) => s).join('\n');
  for (const ghost of ['Notifications', 'Settings tab', 'Subscribe to calendar', 'Sign in', 'Log in', 'Sign up', 'friend request', 'Accept request']) {
    assert.ok(!all.includes(ghost), `copy mentions ${ghost}, which does not exist`);
  }
});

test('the client never sends the home anchor to the server', () => {
  for (const [file, src] of client) {
    if (file.endsWith('data.js')) continue;
    assert.ok(!/body:\s*\{[^}]*anchor/i.test(src), `${file} may be sending the home anchor`);
  }
});
