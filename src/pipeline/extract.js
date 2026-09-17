// Listing extraction. JSON-LD schema.org/Event first, because it is what these sites actually emit
// and it survives a redesign that would break any CSS selector.

const SCRIPT_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export function jsonLdBlocks(html) {
  const out = [];
  for (const m of String(html).matchAll(SCRIPT_RE)) {
    const text = m[1].trim().replace(/^\uFEFF/, '');
    try { out.push(JSON.parse(text)); } catch { /* a broken block is not a reason to lose the page */ }
  }
  return out;
}

function* flatten(node) {
  if (Array.isArray(node)) { for (const n of node) yield* flatten(n); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  if (node['@graph']) yield* flatten(node['@graph']);
  for (const k of ['subEvent', 'subEvents', 'event', 'events', 'itemListElement']) if (node[k]) yield* flatten(node[k]);
  if (node.item) yield* flatten(node.item);
}

const isEvent = (n) => {
  const t = n['@type'];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && /Event/i.test(x));
};

function text(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return text(v[0]);
  if (v && typeof v === 'object') return text(v.name ?? v['@value'] ?? '');
  return '';
}

function priceText(offers) {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  const parts = [];
  for (const o of list) {
    if (o == null) continue;
    if (o.price != null && o.price !== '') parts.push(String(o.price));
    if (o.lowPrice != null) parts.push(String(o.lowPrice));
    if (typeof o.description === 'string') parts.push(o.description);
  }
  return parts.join(' ');
}

function venue(loc) {
  const l = Array.isArray(loc) ? loc[0] : loc;
  if (!l) return { name: '', address: '' };
  if (typeof l === 'string') return { name: l, address: '' };
  const a = l.address;
  let address = '';
  if (typeof a === 'string') address = a;
  else if (a && typeof a === 'object') address = [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', ');
  return { name: text(l.name), address };
}

function toIso(v) {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Extract normalized listings from a page. Returns [] rather than throwing. */
export function extractListings(html, { source, pageUrl }) {
  const out = [];
  for (const block of jsonLdBlocks(html)) {
    for (const node of flatten(block)) {
      if (!isEvent(node)) continue;
      const starts_at = toIso(node.startDate);
      const title = text(node.name).trim();
      if (!starts_at || !title) continue;
      const v = venue(node.location);
      const url = text(node.url) || pageUrl;
      out.push({
        source,
        source_id: String(node['@id'] || url || `${title}|${starts_at}`).slice(0, 200),
        source_url: url,
        title,
        description: text(node.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
        venue_name: v.name,
        venue_address: v.address,
        starts_at,
        ends_at: toIso(node.endDate),
        price_text: priceText(node.offers),
        category_hint: [text(node.eventAttendanceMode), ...(Array.isArray(node.keywords) ? node.keywords : [text(node.keywords)])].filter(Boolean).join(' '),
      });
    }
  }
  // de-dupe within the page by source_id
  const seen = new Set();
  return out.filter((l) => (seen.has(l.source_id) ? false : (seen.add(l.source_id), true)));
}

/** Links matching a pattern, absolutized. For index pages that list event detail URLs. */
export function links(html, { base, match }) {
  const out = new Set();
  for (const m of String(html).matchAll(/href=["']([^"']+)["']/gi)) {
    let href = m[1];
    if (href.startsWith('#') || href.startsWith('mailto:')) continue;
    try { href = new URL(href, base).toString(); } catch { continue; }
    if (match.test(href)) out.add(href.split('#')[0]);
  }
  return [...out];
}
