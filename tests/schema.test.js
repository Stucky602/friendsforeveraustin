import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const migrations = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(`migrations/${f}`, 'utf8')).join('\n');

test('migrations are D1-console safe: one statement per line, no comments, no trailing whitespace', () => {
  for (const line of migrations.split('\n')) {
    if (!line) continue;
    assert.ok(!line.startsWith('--'), 'no comments');
    assert.equal(line, line.trimEnd(), 'no trailing whitespace');
    assert.ok(line.endsWith(';'), `statement must end with ; : ${line.slice(0, 40)}`);
  }
});

test('every CREATE TABLE in ARCHITECTURE.md §1.5 appears verbatim in migrations', () => {
  const doc = readFileSync('ARCHITECTURE.md', 'utf8');
  const block = doc.split('### 1.5 Initial schema')[1].split('```')[1];
  for (const line of block.split('\n').filter((l) => l.startsWith('CREATE '))) assert.ok(migrations.includes(line), `doc/schema drift: ${line.slice(0, 60)}`);
});

test('schema snapshot matches (regenerate with: node scripts/schema-snapshot.mjs)', () => {
  const hash = createHash('sha256').update(migrations).digest('hex');
  const snap = JSON.parse(readFileSync('tests/schema.snapshot.json', 'utf8'));
  assert.equal(hash, snap.sha256, 'migrations changed; regenerate the snapshot on purpose');
});
