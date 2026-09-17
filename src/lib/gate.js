// The wall. ARCHITECTURE.md §2.
//
//   mutual(viewer, p)  = tick(viewer, p) AND tick(p, viewer)
//   visible(viewer, p) = (p == viewer) OR (p.visibility == 'public') OR mutual(viewer, p)
//
// Every read of person-level data goes through here. Routes never decide
// visibility themselves; they call a function in this file and get back
// rows that are already safe to send. tests/gateLint.test.js enforces that
// nothing outside this file calls the repo functions that return gated data.

export const GATED_PERSON_FIELDS = Object.freeze(['groups', 'kid_ages', 'availability']);

/** Derive the mutual set from two directed lists. Never stored. */
export function mutualSet(ticksFrom, ticksTo) {
  const to = new Set(ticksTo);
  const out = new Set();
  for (const id of ticksFrom) if (to.has(id)) out.add(id);
  return out;
}

/** The predicate. `subject` is a person row (needs id, visibility, removed_at). */
export function isVisible(viewerId, subject, mutuals) {
  if (!subject) return false;
  if (subject.removed_at) return false;
  if (subject.id === viewerId) return true;
  if (subject.visibility === 'public') return true;
  return mutuals.has(subject.id);
}

/**
 * A viewer context: everything the gate needs for one request, loaded once.
 * repo must expose: people(roomId), ticksFrom(id), ticksTo(id).
 */
export async function loadContext(repo, viewer) {
  const [people, from, to] = await Promise.all([
    repo.people(viewer.room_id),
    repo.ticksFrom(viewer.id),
    repo.ticksTo(viewer.id),
  ]);
  const mutuals = mutualSet(from, to);
  const byId = new Map(people.map((p) => [p.id, p]));
  if (!byId.has(viewer.id)) byId.set(viewer.id, viewer);
  const visibleIds = new Set();
  for (const p of byId.values()) if (isVisible(viewer.id, p, mutuals)) visibleIds.add(p.id);
  return { viewer, mutuals, byId, visibleIds, people };
}

/** Ungated shape of a person: what the whole room sees on the roster. */
export function publicPerson(p) {
  return { id: p.id, display_name: p.display_name, visibility: p.visibility };
}

/** Roster rows for GET /api/people. Gated fields only for visible subjects. */
export async function roster(ctx, repo) {
  const ids = [...ctx.visibleIds];
  const avail = ids.length ? await repo.availability(ids) : [];
  const availBy = new Map();
  for (const a of avail) {
    if (!availBy.has(a.person_id)) availBy.set(a.person_id, []);
    availBy.get(a.person_id).push(a);
  }
  return ctx.people
    .filter((p) => !p.removed_at)
    .map((p) => {
      const row = publicPerson(p);
      if (ctx.visibleIds.has(p.id)) {
        row.groups = p.groups;
        row.kid_ages = p.kid_ages ?? null;
        row.availability = availBy.get(p.id) ?? [];
      }
      return row;
    });
}

/** Keep only rows whose person_id is visible to the viewer; attach display_name. */
export function filterIdentityRows(ctx, rows) {
  const out = [];
  for (const r of rows) {
    if (!ctx.visibleIds.has(r.person_id)) continue;
    const p = ctx.byId.get(r.person_id);
    out.push({ ...r, display_name: p ? p.display_name : 'someone' });
  }
  return out;
}

/**
 * Decorate places with public aggregates and gated identity rows.
 * repo must expose: vouchCounts(ids), vouches(ids), interestCounts(type, ids),
 * interests(type, ids), reviewAgg(ids), reviews(ids).
 */
export async function decoratePlaces(ctx, repo, places) {
  if (!places.length) return [];
  const ids = places.map((p) => p.id);
  const [vc, vs, ic, is, ra, rs] = await Promise.all([
    repo.vouchCounts(ids),
    repo.vouches(ids),
    repo.interestCounts('place', ids),
    repo.interests('place', ids),
    repo.reviewAgg(ids),
    repo.reviews(ids),
  ]);
  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r[key])) m.set(r[key], []);
      m.get(r[key]).push(r);
    }
    return m;
  };
  const vsBy = group(filterIdentityRows(ctx, vs), 'place_id');
  const isBy = group(filterIdentityRows(ctx, is), 'place_id');
  const rsBy = group(filterIdentityRows(ctx, rs), 'place_id');
  return places.map((p) => {
    const agg = ra.get(p.id) ?? { count: 0, verdicts: { loved: 0, fine: 0, bounced: 0 } };
    const { merged_into, ...rest } = p; // never returned
    return {
      ...rest,
      vouch_count: vc.get(p.id) ?? 0,
      interest_count: ic.get(p.id) ?? 0,
      review_count: agg.count,
      verdicts: agg.verdicts,
      vouchers: vsBy.get(p.id) ?? [],
      interested: (isBy.get(p.id) ?? []).map(({ person_id, display_name }) => ({ person_id, display_name })),
      reviews: (rsBy.get(p.id) ?? []).sort((a, b) => (b.created_at < a.created_at ? -1 : 1)),
    };
  });
}

/** Decorate events with public interest counts and gated interested rows. */
export async function decorateEvents(ctx, repo, events) {
  if (!events.length) return [];
  const ids = events.map((e) => e.id);
  const [ic, is] = await Promise.all([repo.interestCounts('event', ids), repo.interests('event', ids)]);
  const isBy = new Map();
  for (const r of filterIdentityRows(ctx, is)) {
    if (!isBy.has(r.target_id)) isBy.set(r.target_id, []);
    isBy.get(r.target_id).push({ person_id: r.person_id, display_name: r.display_name });
  }
  return events.map((e) => ({
    ...e,
    interest_count: ic.get(e.id) ?? 0,
    interested: isBy.get(e.id) ?? [],
  }));
}

/**
 * Plans: members only (stricter than mutual, unaffected by public).
 * Returns null when the viewer is not a member, which the route turns into 404.
 * Member names are disclosed to members; nothing else about them is.
 */
export async function planForViewer(ctx, repo, plan) {
  if (!plan || plan.status === 'dropped') return null;
  const members = await repo.planMembers(plan.id);
  if (!members.some((m) => m.person_id === ctx.viewer.id)) return null;
  return {
    ...plan,
    members: members.map((m) => {
      const p = ctx.byId.get(m.person_id);
      const name = p && !p.removed_at ? p.display_name : 'someone';
      return { person_id: m.person_id, display_name: name, state: m.state };
    }),
  };
}

/** The viewer's own event interests. Self is always visible; exists so routes never call repo.interests. */
export async function ownEventInterestIds(ctx, repo, eventIds) {
  if (!eventIds.length) return new Set();
  const rows = await repo.interests('event', eventIds);
  return new Set(rows.filter((r) => r.person_id === ctx.viewer.id).map((r) => r.target_id));
}

/** Availability for the night read: only visible people, only rows in range. */
export async function whoOnDate(ctx, repo, date) {
  const ids = [...ctx.visibleIds];
  const rows = ids.length ? await repo.availability(ids, date, date) : [];
  const away = new Set();
  const free = new Set();
  for (const r of rows) {
    if (r.start_date <= date && date <= r.end_date) {
      if (r.kind === 'away') away.add(r.person_id);
      if (r.kind === 'free') free.add(r.person_id);
    }
  }
  const name = (id) => ({ person_id: id, display_name: ctx.byId.get(id)?.display_name ?? 'someone' });
  return {
    around: ids.filter((id) => !away.has(id)).map(name),
    free: ids.filter((id) => free.has(id) && !away.has(id)).map(name),
  };
}
