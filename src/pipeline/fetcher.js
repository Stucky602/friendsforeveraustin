// Polite fetching. CONTRACTS.md §1 scraping conduct.
// Fixed UA, robots honored, 1 request / 3s per host, 24h cache, stop the stage on 429/403.

export const USER_AGENT = 'RoomApp/0.1 (friends-only local events calendar; contact: room-app@users.noreply.github.com)';
export const MIN_INTERVAL_MS = 3000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class Parked extends Error {
  constructor(host, status) { super(`parked:${host}:${status}`); this.host = host; this.status = status; }
}

export function createFetcher({ repo, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const lastHit = new Map();
  const robots = new Map();

  async function raw(url) {
    const host = new URL(url).host;
    const wait = (lastHit.get(host) ?? 0) + MIN_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, now());
    const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json' } });
    if (res.status === 429 || res.status === 403) throw new Parked(host, res.status);
    return { status: res.status, body: res.ok ? await res.text() : '' };
  }

  async function allowed(url) {
    const u = new URL(url);
    const origin = u.origin;
    if (!robots.has(origin)) {
      let rules = { disallow: [] };
      try {
        const r = await raw(`${origin}/robots.txt`);
        if (r.status === 200) rules = parseRobots(r.body, USER_AGENT);
      } catch (e) { if (e instanceof Parked) throw e; }
      robots.set(origin, rules);
    }
    const rules = robots.get(origin);
    return !rules.disallow.some((p) => p && u.pathname.startsWith(p));
  }

  /**
   * Cached, polite GET. Returns body string, or null if disallowed or not ok.
   * maxAgeMs overrides the 24h cache; pass 0 for a source whose absence is meaningful today.
   */
  async function get(url, { maxAgeMs = CACHE_TTL_MS } = {}) {
    const hit = maxAgeMs > 0 ? await repo.cacheGet(url) : null;
    if (hit && now() - Date.parse(hit.fetched_at) < maxAgeMs) return hit.status === 200 ? hit.body : null;
    if (!(await allowed(url))) return null;
    const r = await raw(url);
    await repo.cachePut(url, r.body, r.status);
    return r.status === 200 ? r.body : null;
  }

  return { get, allowed, raw };
}

/** Minimal robots.txt: the wildcard group plus any group naming our UA token. */
export function parseRobots(text, ua = USER_AGENT) {
  const token = ua.split('/')[0].toLowerCase();
  const lines = String(text).split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const groups = [];
  let current = null;
  for (const line of lines) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'disallow' || key === 'allow')) {
      current.rules.push({ key, value });
    }
  }
  const mine = groups.filter((g) => g.agents.includes('*') || g.agents.some((a) => token.startsWith(a) || a.startsWith(token)));
  const disallow = [];
  for (const g of mine) for (const r of g.rules) if (r.key === 'disallow' && r.value) disallow.push(r.value);
  return { disallow };
}
