// CONTRACTS.md §3. Deterministic normalization that feeds UNIQUE keys,
// plus the fuzzy attach test that never feeds a key.

const CHICAGO = 'America/Chicago';

function collapse(s) {
  return s.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** §3.1 name half of canonical_key */
export function normName(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/^\s*the\s+/, '');
  s = s.replace(/\s*[-–—]\s*austin\s*$/, '');
  s = s.replace(/\s*\(austin\)\s*$/, '');
  s = s.replace(/\s+austin\s*$/, '');
  s = s.replace(/\s+atx\s*$/, '');
  return collapse(s);
}

const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);

/** §3.1 address half: leading street number + first street token, directionals dropped */
export function normAddr(address) {
  if (!address) return '';
  const s = collapse(String(address).toLowerCase());
  const parts = s.split(' ').filter(Boolean);
  const num = parts.find((p) => /^\d+[a-z]?$/.test(p));
  if (!num) return '';
  const i = parts.indexOf(num);
  const rest = parts.slice(i + 1).filter((p) => !DIRECTIONALS.has(p));
  const street = rest[0] || '';
  return street ? `${num} ${street}` : num;
}

export function canonicalKey(name, address) {
  return `${normName(name)}|${normAddr(address)}`;
}

const TITLE_DROP = new Set(['presents', 'present', 'w/', 'with', 'featuring', 'feat', 'ft', 'and', '&', 'the', 'a', 'an']);

/** §3.2 title half of dedupe_key */
export function normTitle(title) {
  let s = String(title || '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  // drop tokens before stripping punctuation so "w/" and "&" can match
  s = s
    .split(/\s+/)
    .filter((t) => t && !TITLE_DROP.has(t))
    .join(' ');
  return collapse(s);
}

/** YYYY-MM-DD of an ISO instant rendered in America/Chicago */
export function chicagoDate(isoInstant) {
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) throw new Error('bad instant');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CHICAGO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function dedupeKey(placeId, startsAt, title) {
  return `${placeId}|${chicagoDate(startsAt)}|${normTitle(title)}`;
}

/** §3.3 attach step. Token Jaccard on normalized titles. */
export const ATTACH_THRESHOLD = 0.6;

export function titleTokens(title) {
  return new Set(normTitle(title).split(' ').filter(Boolean));
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Should a new listing attach to an existing live event (same place, same Chicago date)? */
export function shouldAttach(newTitle, existingTitle) {
  return jaccard(titleTokens(newTitle), titleTokens(existingTitle)) >= ATTACH_THRESHOLD;
}
