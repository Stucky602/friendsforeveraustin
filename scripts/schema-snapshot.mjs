import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const migrations = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(`migrations/${f}`, 'utf8')).join('\n');
writeFileSync('tests/schema.snapshot.json', JSON.stringify({ sha256: createHash('sha256').update(migrations).digest('hex'), files: readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort() }, null, 2) + '\n');
console.log('snapshot written');
