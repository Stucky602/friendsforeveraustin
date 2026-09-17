// Cross-reference ltbaustin.com for party-mode days.
//
// Kevin owns both ends of this, so the primary path is a CONTRACT, not a scrape: LTB emits a
// schema.org/Event JSON-LD block when party mode is on, and this reads it. See PARTY_MODE.md.
//
// The fallback path exists so this works before LTB is touched at all. It is a heuristic and it
// is allowed to find nothing. What it is NOT allowed to do is invent a date, and it must be able
// to tell "no party day is set" apart from "the page changed and I can no longer see one".

import { jsonLdBlocks } from '../extract.js';

export const LTB_SOURCE = 'ltb';
export const LTB_URL = 'https://ltbaustin.com/order.html';
export const LTB_PLACE_NAME = 'Lettuce, Turnip, The Beet';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const PARTY_RE = /party\s*mode/i;
const PARTY_RE_G = /party\s*mode/gi;
const DEFAULT_HOUR = 18; // 6pm Chicago when the page gives a day but no time

const stripTags = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Chicago wall-clock to a UTC instant. CST is -6, CDT is -5; Austin is on CDT Mar to Nov. */
export function chicagoToIso(y, m, d, hour = DEFAULT_HOUR, minute = 0) {
  const guess = Date.UTC(y, m - 1, d, hour + 5, minute);
  const offsetHours = isChicagoDst(new Date(guess)) ? 5 : 6;
  return new Date(Date.UTC(y, m - 1, d, hour + offsetHours, minute)).toISOString();
}

function isChicagoDst(date) {
  const jan = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const tz = (d) => {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName');
    return s ? s.value : 'CST';
  };
  return tz(date) !== tz(jan);
}

/**
 * Parse a date out of free text. Returns {y, m, d} or null.
 * Never guesses: if it cannot find a month and a day number, it returns null.
 * A bare month/day resolves to the next occurrence within the coming 12 months.
 */
export function parseLooseDate(text, now = new Date()) {
  const t = String(text);

  const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };

  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (slash) {
    const m = +slash[1], d = +slash[2];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      if (slash[3]) { const y = +slash[3]; return { y: y < 100 ? 2000 + y : y, m, d }; }
      return withInferredYear(m, d, now);
    }
  }

  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/i.exec(t);
  if (named) {
    const m = MONTHS[named[1].toLowerCase()];
    const d = +named[2];
    if (d >= 1 && d <= 31) return named[3] ? { y: +named[3], m, d } : withInferredYear(m, d, now);
  }

  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*/i.exec(t);
  if (dayFirst) {
    const d = +dayFirst[1];
    const m = MONTHS[dayFirst[2].toLowerCase()];
    if (d >= 1 && d <= 31) return withInferredYear(m, d, now);
  }

  return null;
}

function withInferredYear(m, d, now) {
  const y = now.getUTCFullYear();
  const candidate = Date.UTC(y, m - 1, d, 23, 59);
  return { y: candidate < now.getTime() - 2 * 86400e3 ? y + 1 : y, m, d };
}

export function parseLooseTime(text) {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(String(text));
  if (!m) return null;
  let hour = +m[1] % 12;
  if (/pm/i.test(m[3])) hour += 12;
  return { hour, minute: m[2] ? +m[2] : 0 };
}

/**
 * Read party-mode days off the LTB front page.
 * Returns { listings, diagnostics }. Diagnostics are the point: they say WHY nothing was found.
 */
export function readPartyMode(html, { now = new Date(), url = LTB_URL } = {}) {
  const diagnostics = { path: null, saw_party_text: false, saw_party_text_without_date: false, blocks: 0 };
  if (!html) return { listings: [], diagnostics: { ...diagnostics, path: 'no_page' } };

  // ---- path 1: the contract ----
  const blocks = jsonLdBlocks(html);
  diagnostics.blocks = blocks.length;
  const fromLd = [];
  for (const block of blocks) {
    for (const node of flatten(block)) {
      const types = [].concat(node['@type'] ?? []);
      if (!types.some((x) => typeof x === 'string' && /Event/i.test(x))) continue;
      const name = String(node.name ?? '');
      const desc = String(node.description ?? '');
      if (!PARTY_RE.test(name) && !PARTY_RE.test(desc) && node.eventStatus !== 'PartyMode') continue;
      const start = node.startDate ? new Date(node.startDate) : null;
      if (!start || Number.isNaN(start.getTime())) continue;
      fromLd.push({
        source: LTB_SOURCE,
        source_id: String(node['@id'] || `ltb-party-${start.toISOString().slice(0, 10)}`),
        source_url: String(node.url || url),
        title: name || 'LTB party mode',
        description: desc,
        venue_name: LTB_PLACE_NAME,
        venue_address: '',
        starts_at: start.toISOString(),
        ends_at: node.endDate && !Number.isNaN(new Date(node.endDate).getTime()) ? new Date(node.endDate).toISOString() : null,
        price_text: '',
        category_hint: 'ltb party mode',
      });
    }
  }
  if (fromLd.length) return { listings: dedupe(fromLd), diagnostics: { ...diagnostics, path: 'jsonld' } };

  // ---- path 2: the heuristic ----
  const attr = [...String(html).matchAll(/data-party-mode\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const attrListings = [];
  for (const value of attr) {
    const d = parseLooseDate(value, now);
    if (!d) { diagnostics.saw_party_text = true; diagnostics.saw_party_text_without_date = true; continue; }
    const t = parseLooseTime(value);
    attrListings.push(makeListing(d, t, 'LTB party mode', value, url));
  }
  if (attrListings.length) return { listings: dedupe(attrListings), diagnostics: { ...diagnostics, path: 'data_attr', saw_party_text: true } };

  const text = stripTags(html);
  if (!PARTY_RE.test(text)) return { listings: [], diagnostics: { ...diagnostics, path: 'clean_no_party' } };
  diagnostics.saw_party_text = true;

  const out = [];
  for (const m of text.matchAll(PARTY_RE_G)) {
    // Dates sit next to the words, not across the page. Look 120 chars either side.
    const window = text.slice(Math.max(0, m.index - 120), m.index + 200);
    const d = parseLooseDate(window, now);
    if (!d) continue;
    out.push(makeListing(d, parseLooseTime(window), 'LTB party mode', window.trim().slice(0, 300), url));
  }
  if (!out.length) diagnostics.saw_party_text_without_date = true;
  return { listings: dedupe(out), diagnostics: { ...diagnostics, path: out.length ? 'text' : 'party_text_no_date' } };
}

function makeListing(d, t, title, description, url) {
  const starts_at = chicagoToIso(d.y, d.m, d.d, t?.hour ?? DEFAULT_HOUR, t?.minute ?? 0);
  return {
    source: LTB_SOURCE,
    source_id: `ltb-party-${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`,
    source_url: url,
    title,
    description,
    venue_name: LTB_PLACE_NAME,
    venue_address: '',
    starts_at,
    ends_at: null,
    price_text: '',
    category_hint: 'ltb party mode',
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((l) => (seen.has(l.source_id) ? false : (seen.add(l.source_id), true)));
}

function* flatten(node) {
  if (Array.isArray(node)) { for (const n of node) yield* flatten(n); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  if (node['@graph']) yield* flatten(node['@graph']);
  for (const k of ['subEvent', 'subEvents', 'event', 'events', 'itemListElement']) if (node[k]) yield* flatten(node[k]);
  if (node.item) yield* flatten(node.item);
}
