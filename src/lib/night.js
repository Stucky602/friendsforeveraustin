// ARCHITECTURE.md §3.5. One read, four ordered parts: who, what's on, fallback, plans.
// Home anchor never reaches the server, so fallback places carry coordinates and no distance.

import { whoOnDate, decorateEvents, decoratePlaces, planForViewer } from './gate.js';
import { chicagoDate } from './normalize.js';

export const VIEWS = Object.freeze(['foodie', 'kids', 'odd']);

export const VIEW_SORT = Object.freeze({
  foodie: (a, b) => (b.vouch_count - a.vouch_count) || ((b.verdicts?.loved ?? 0) - (a.verdicts?.loved ?? 0)),
  kids: (a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0),
  odd: (a, b) => b.score - a.score,
});

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Wide UTC window guaranteed to contain every instant whose Chicago date is `date`. */
export function utcWindowFor(date) {
  const day = Date.parse(`${date}T00:00:00Z`);
  return { from: new Date(day - 12 * 3600e3).toISOString(), to: new Date(day + 36 * 3600e3).toISOString() };
}

export async function nightRead(ctx, repo, room, { date, view }) {
  if (!isDate(date)) throw Object.assign(new Error('bad date'), { status: 400, code: 'bad_request' });
  if (!VIEWS.includes(view)) throw Object.assign(new Error('bad view'), { status: 400, code: 'bad_request' });

  // 1. Who. Visible people only; non-visible people are not counted, not even in a total.
  const who = await whoOnDate(ctx, repo, date);

  // 2. What's on. Live events on that Chicago date, groups ∩ view, score >= bar.
  const bar = Number.isFinite(room?.bar) ? room.bar : 50;
  const { from, to } = utcWindowFor(date);
  const raw = await repo.events({ from, to, groups: [view] });
  const onDate = raw.filter((e) => chicagoDate(e.starts_at) === date && e.score >= bar);
  const events = (await decorateEvents(ctx, repo, onDate)).sort(VIEW_SORT[view] === VIEW_SORT.foodie ? VIEW_SORT.odd : VIEW_SORT[view]);

  // 3. Fallback. Only when nothing is on. Vouched places for the view; the client trims by drive time.
  let fallback_places = [];
  if (events.length === 0) {
    const candidates = await repo.places(view === 'foodie' ? {} : { groups: [view] });
    const decorated = await decoratePlaces(ctx, repo, candidates);
    fallback_places = decorated
      .filter((p) => p.vouch_count > 0)
      .sort(VIEW_SORT.foodie)
      .map((p) => ({
        id: p.id, name: p.name, address: p.address, lat: p.lat, lng: p.lng, neighborhood: p.neighborhood,
        groups: p.groups, vouch_count: p.vouch_count, review_count: p.review_count, verdicts: p.verdicts,
        vouchers: p.vouchers, reviews: p.reviews,
      }));
  }

  // 4. Plans. Open plans the viewer is a member of on that date, pinned above everything.
  const mine = await repo.plansForMember(ctx.viewer.id);
  const plans = [];
  for (const p of mine) {
    if (p.status !== 'open') continue;
    if (chicagoDate(p.starts_at) !== date) continue;
    const full = await planForViewer(ctx, repo, p);
    if (full) plans.push(full);
  }

  return { date, view, bar, who, events, fallback_places, plans };
}
