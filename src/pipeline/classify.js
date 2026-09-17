// Mute rule (cheap, before any model call), then the two-tier model pass.
import { validateAnswers } from '../lib/answers.js';

// The single largest cost saver in the pipeline. Rules, not preferences.
const MUTE_PATTERNS = {
  live_music: /\b(live music|concert|dj set|open mic|singer.songwriter|band|tour\b|residency|karaoke|jam session|acoustic set|album release)\b/i,
  concert: /\b(concert|tickets? on sale now|doors \d|presented by c3|acl fest|sxsw music)\b/i,
};

/** Returns the muted category, or null. Runs on the raw listing, before any model call. */
export function mutedCategory(listing, categories) {
  const hay = `${listing.title} ${listing.description} ${listing.category_hint || ''}`;
  for (const c of categories) {
    const re = MUTE_PATTERNS[c];
    if (re && re.test(hay)) return c;
  }
  return null;
}

export const PROMPT = `You classify local event listings for a small group of friends in Austin, Texas.

Return ONLY a JSON object, no prose and no markdown fences:
{"groups":[...],"reject":null,"answers":{"cost":{...},"parking":{...},"loud":{...},"kid_ok":{...}}}

groups: any of "foodie" (food and drink is the point), "kids" (a child would be the reason to go), "odd" (museums, unusual screenings, talks, oddities). Use [] with reject {"reason":"no_group"} if none fit. Use reject {"reason":"mute"} if it is a concert or live music event.

Each answer is {"value":..,"confidence":0..1,"evidence":".."}.
  cost: free | $ | $$ | $$$ | unknown
  parking: lot | street | garage | hard | unknown
  loud: quiet | normal | loud | unknown
  kid_ok: yes | no | older | unknown

evidence MUST be a verbatim substring copied from the listing text, or "" when you do not know. Never paraphrase and never invent evidence. If the listing does not say, the value is "unknown", evidence is "", and confidence is at most 0.2. Do not guess.`;

export function listingText(l) {
  return [l.title, l.venue_name, l.description, l.price_text].filter(Boolean).join('\n');
}

function parseJson(raw) {
  const s = String(raw).replace(/```json|```/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/**
 * Two tiers: Workers AI first, the good model only when tier 1 is unsure.
 * Spend is charged for tier 2 only. Returns { value, tier } or { error }.
 */
export async function classifyOne(listing, { ai, anthropic, spend }) {
  const text = listingText(listing);
  const ask = async (fn) => {
    const raw = await fn(`${PROMPT}\n\nListing:\n${text}`);
    const parsed = parseJson(raw);
    if (!parsed) return { ok: false, error: 'unparseable' };
    return validateAnswers(parsed, text);
  };

  let first = { ok: false, error: 'no_tier1' };
  if (ai) { try { first = await ask(ai); } catch { first = { ok: false, error: 'tier1_threw' }; } }

  const unsure = !first.ok || first.value.groups.length === 0 ||
    Object.values(first.value.answers).every((a) => a.value === 'unknown');

  if (!unsure) return { value: first.value, tier: 1 };
  if (!anthropic || !(await spend.allowed())) return first.ok ? { value: first.value, tier: 1 } : { error: first.error };

  let second;
  try { second = await ask(anthropic); } catch { second = { ok: false, error: 'tier2_threw' }; }
  await spend.charge(2);
  if (second.ok) return { value: second.value, tier: 2 };
  return first.ok ? { value: first.value, tier: 1 } : { error: second.error };
}

/**
 * Room-wide score (ARCHITECTURE.md §1.2). One number per event, never per viewer.
 * Inputs: source fit, groups matched, mean answer confidence, vouches at the place.
 */
export const SOURCE_FIT = { alamo: 30, apl: 28, do512family: 26, kidsoutandabout: 22, do512: 12, chronicle: 12 };
export function scoreEvent({ source, groups, answers, vouchCount = 0 }) {
  const fit = source?.startsWith('museum:') ? 28 : (SOURCE_FIT[source] ?? 15);
  const groupPoints = Math.min(groups.length, 2) * 12;
  const confs = Object.values(answers || {}).map((a) => Number(a.confidence) || 0);
  const meanConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  const known = Math.round(meanConf * 25);
  const vouch = Math.min(vouchCount, 3) * 5;
  return Math.max(0, Math.min(100, fit + groupPoints + known + vouch));
}
