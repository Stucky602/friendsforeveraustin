const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()) {
  let t = now, time = '';
  for (let i = 0; i < 10; i++) { time = CROCK[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let rand = '';
  for (const b of bytes) rand += CROCK[b % 32] + CROCK[(b >> 3) % 32];
  return time + rand.slice(0, 16);
}

export const nowIso = () => new Date().toISOString();

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function err(code, detail, status) {
  return json({ error: code, detail }, status);
}

export class HttpError extends Error {
  constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail || code; }
}

export async function readJson(request) {
  try { const t = await request.text(); return t ? JSON.parse(t) : {}; } catch { throw new HttpError(400, 'bad_request', 'Body is not JSON.'); }
}

/** "Sat Sep 26, 7:00 PM" in America/Chicago */
export function whenLabel(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

export function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)); }

/** Ray-cast point in polygon (GeoJSON ring: [[lng,lat],...]) */
export function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const hit = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Name of the first neighborhood feature containing the point, else null. */
export function neighborhoodFor(lng, lat, geojson) {
  for (const f of geojson?.features ?? []) {
    const g = f.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) if (poly[0] && pointInRing(lng, lat, poly[0])) return f.properties?.name ?? null;
  }
  return null;
}

/** Census geocoder, one address. Returns {lat,lng} or null. Never throws. */
export async function censusGeocode(address, fetchImpl = fetch) {
  try {
    const u = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
    u.searchParams.set('address', address);
    u.searchParams.set('benchmark', 'Public_AR_Current');
    u.searchParams.set('format', 'json');
    const r = await fetchImpl(u.toString(), { headers: { 'user-agent': 'room-app (friends-only local events; contact via repo)' } });
    if (!r.ok) return null;
    const j = await r.json();
    const m = j?.result?.addressMatches?.[0]?.coordinates;
    if (!m) return null;
    return { lat: Number(m.y), lng: Number(m.x) };
  } catch { return null; }
}
