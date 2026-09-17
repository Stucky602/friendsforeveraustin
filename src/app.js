// The API. CONTRACTS.md §1. Every route that returns person-level data goes through src/lib/gate.js.
// createApp(repo, env, deps) -> { handle(request) } so tests run it against the memory repo.

import { resolveViewer, newToken, hashToken, personalLink } from './lib/auth.js';
import { loadContext, roster, decoratePlaces, decorateEvents, planForViewer, ownEventInterestIds } from './lib/gate.js';
import { nightRead, VIEWS } from './lib/night.js';
import { canonicalKey, chicagoDate } from './lib/normalize.js';
import { canSelfTransition, validateCreate, planText } from './lib/plans.js';
import { answerLabels } from './lib/answers.js';
import { ulid, nowIso, json, err, HttpError, readJson, whenLabel, isYmd, neighborhoodFor, censusGeocode } from './lib/util.js';
import { createRunner, STAGES, MONTHLY_CAP_CENTS } from './pipeline/run.js';

const GROUPS = ['foodie', 'kids', 'odd'];
const VISIBILITY = ['mutual', 'public'];
const VERDICTS = ['loved', 'fine', 'bounced'];

export function createApp(repo, env = {}, deps = {}) {
  const geocode = deps.geocode || ((addr) => censusGeocode(addr));
  const neighborhoods = deps.neighborhoods || { type: 'FeatureCollection', features: [] };
  const version = env.APP_VERSION || '0.0.0';

  const routes = [];
  const on = (method, pattern, fn, opts = {}) => routes.push({ method, pattern, re: toRe(pattern), keys: keysOf(pattern), fn, opts });

  // ---------- helpers ----------
  const completeDue = (now = Date.now()) => repo.completeDuePlans(now);
  const requireOwner = (v) => { if (v.room.owner_person_id !== v.person.id) throw new HttpError(403, 'forbidden', 'Owner only.'); };
  const parseBbox = (s) => { if (!s) return null; const a = s.split(',').map(Number); return a.length === 4 && a.every(Number.isFinite) ? a : null; };
  const parseGroups = (s) => (s ? s.split(',').filter((g) => GROUPS.includes(g)) : []);
  const pick = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));

  // ---------- bootstrap (one time, secret-guarded) ----------
  on('POST', '/api/bootstrap', async ({ request }) => {
    const secret = env.BOOTSTRAP_SECRET;
    const given = request.headers.get('x-bootstrap-secret');
    if (!secret || given !== secret) throw new HttpError(403, 'forbidden', 'Bootstrap secret missing or wrong.');
    const body = await readJson(request);
    if (await repo.anyRoom?.()) throw new HttpError(409, 'bad_request', 'A room already exists.');
    const roomId = ulid(), personId = ulid(), token = newToken();
    await repo.insertRoom({ id: roomId, name: String(body.room_name || 'The Room'), owner_person_id: null, bar: 50, created_at: nowIso() });
    await repo.insertPerson({ id: personId, room_id: roomId, display_name: String(body.owner_name || 'Owner'), token_hash: await hashToken(token), groups: [], default_view: 'odd', visibility: 'mutual', created_at: nowIso() });
    await repo.updateRoom(roomId, { owner_person_id: personId });
    await repo.setMutes(roomId, ['live_music', 'concert']);
    return json({ room_id: roomId, person_id: personId, link: personalLink(new URL(request.url).origin, token) }, 201);
  }, { public: true });

  on('GET', '/api/version', async () => json({ version }), { public: true });

  // ---------- self ----------
  const safePerson = (p) => { const { token_hash, ...rest } = p; return rest; };
  on('GET', '/api/me', async ({ v, ctx }) => json({ person: safePerson(v.person), room: pick(v.room, ['id', 'name', 'bar']), default_view: v.person.default_view, mutual_ids: [...ctx.mutuals], version }));
  on('PUT', '/api/me', async ({ v, request }) => {
    const b = await readJson(request);
    const patch = {};
    if ('groups' in b) { if (!Array.isArray(b.groups) || !b.groups.every((g) => GROUPS.includes(g))) throw new HttpError(400, 'bad_request', 'groups'); patch.groups = [...new Set(b.groups)]; }
    if ('default_view' in b) { if (!VIEWS.includes(b.default_view)) throw new HttpError(400, 'bad_request', 'default_view'); patch.default_view = b.default_view; }
    if ('kid_ages' in b) { if (b.kid_ages != null && !(Array.isArray(b.kid_ages) && b.kid_ages.every((n) => Number.isInteger(n) && n >= 0 && n < 30))) throw new HttpError(400, 'bad_request', 'kid_ages'); patch.kid_ages = b.kid_ages ?? null; }
    if ('display_name' in b) { const s = String(b.display_name || '').trim(); if (!s || s.length > 40) throw new HttpError(400, 'bad_request', 'display_name'); patch.display_name = s; }
    if ('visibility' in b) { if (!VISIBILITY.includes(b.visibility)) throw new HttpError(400, 'bad_request', 'visibility'); patch.visibility = b.visibility; }
    return json({ person: safePerson(await repo.updatePerson(v.person.id, patch)) });
  });

  // ---------- people ----------
  on('GET', '/api/people', async ({ ctx }) => json({ people: await roster(ctx, repo) }));
  on('PUT', '/api/tick/:id', async ({ v, params }) => {
    const target = await repo.personById(params.id);
    if (!target || target.room_id !== v.room.id || target.removed_at || target.id === v.person.id) throw new HttpError(404, 'not_found', 'No such person.');
    await repo.setTick(v.person.id, target.id);
    return new Response(null, { status: 204 });
  });
  on('DELETE', '/api/tick/:id', async ({ v, params }) => { await repo.delTick(v.person.id, params.id); return new Response(null, { status: 204 }); });

  // ---------- availability (own) ----------
  on('GET', '/api/availability', async ({ v }) => json({ availability: await repo.ownAvailability(v.person.id) }));
  on('POST', '/api/availability', async ({ v, request }) => {
    const b = await readJson(request);
    if (!['free', 'away'].includes(b.kind)) throw new HttpError(400, 'bad_request', 'kind');
    if (!isYmd(b.start_date) || !isYmd(b.end_date) || b.end_date < b.start_date) throw new HttpError(400, 'bad_request', 'dates');
    const row = { id: ulid(), person_id: v.person.id, kind: b.kind, start_date: b.start_date, end_date: b.end_date, note: b.note ? String(b.note).slice(0, 140) : null };
    return json({ availability: await repo.insertAvailability(row) }, 201);
  });
  on('DELETE', '/api/availability/:id', async ({ v, params }) => { if (!(await repo.delAvailability(params.id, v.person.id))) throw new HttpError(404, 'not_found', 'No such row.'); return new Response(null, { status: 204 }); });

  // ---------- places, vouches, reviews ----------
  on('GET', '/api/places', async ({ ctx, url }) => {
    const places = await repo.places({ bbox: parseBbox(url.searchParams.get('bbox')), groups: parseGroups(url.searchParams.get('groups')) });
    return json({ places: await decoratePlaces(ctx, repo, places) });
  });
  on('GET', '/api/places/:id', async ({ ctx, params }) => {
    const p = await repo.placeById(params.id);
    if (!p) throw new HttpError(404, 'not_found', 'No such place.');
    return json({ place: (await decoratePlaces(ctx, repo, [p]))[0] });
  });
  on('POST', '/api/places', async ({ v, ctx, request }) => {
    const b = await readJson(request);
    const name = String(b.name || '').trim();
    if (!name || name.length > 80) throw new HttpError(400, 'bad_request', 'name');
    const address = b.address ? String(b.address).trim().slice(0, 160) : null;
    const key = canonicalKey(name, address);
    const existing = await repo.placeByKey(key);
    if (existing) return json({ place: (await decoratePlaces(ctx, repo, [await repo.placeById(existing.id)]))[0], existing: true });
    let lat = Number.isFinite(b.lat) ? b.lat : null, lng = Number.isFinite(b.lng) ? b.lng : null, geocode_source = null, geocoded_at = null;
    if (lat != null && lng != null) { geocode_source = 'client'; geocoded_at = nowIso(); }
    else if (address) { const g = await geocode(address); if (g) { lat = g.lat; lng = g.lng; geocode_source = 'census'; } else { geocode_source = 'failed'; } geocoded_at = nowIso(); }
    const groups = Array.isArray(b.groups) ? b.groups.filter((g) => GROUPS.includes(g)) : [];
    const row = { id: ulid(), name, address, lat, lng, neighborhood: lat != null ? neighborhoodFor(lng, lat, neighborhoods) : null, groups, canonical_key: key, geocode_source, geocoded_at, created_by: v.person.id, created_at: nowIso() };
    const place = await repo.insertPlace(row);
    return json({ place: (await decoratePlaces(ctx, repo, [place]))[0] }, 201);
  });
  on('PUT', '/api/vouch/:place_id', async ({ v, params, request }) => {
    if (!(await repo.placeById(params.place_id))) throw new HttpError(404, 'not_found', 'No such place.');
    const b = await readJson(request);
    const line = String(b.line || '').trim();
    if (!line || line.length > 200) throw new HttpError(400, 'bad_request', 'line');
    await repo.upsertVouch(params.place_id, v.person.id, line);
    return new Response(null, { status: 204 });
  });
  on('DELETE', '/api/vouch/:place_id', async ({ v, params }) => { await repo.delVouch(params.place_id, v.person.id); return new Response(null, { status: 204 }); });

  on('POST', '/api/places/:place_id/reviews', async ({ v, params, request }) => {
    if (!(await repo.placeById(params.place_id))) throw new HttpError(404, 'not_found', 'No such place.');
    const b = await readJson(request);
    if (!VERDICTS.includes(b.verdict)) throw new HttpError(400, 'bad_request', 'verdict');
    if (b.visited_on != null && !isYmd(b.visited_on)) throw new HttpError(400, 'bad_request', 'visited_on');
    const n = nowIso();
    const row = { id: ulid(), place_id: params.place_id, person_id: v.person.id, visited_on: b.visited_on ?? null, verdict: b.verdict, text: String(b.text || '').slice(0, 4000), created_at: n, updated_at: n };
    return json({ review: await repo.insertReview(row) }, 201);
  });
  on('PUT', '/api/reviews/:id', async ({ v, params, request }) => {
    const b = await readJson(request);
    const patch = {};
    if ('verdict' in b) { if (!VERDICTS.includes(b.verdict)) throw new HttpError(400, 'bad_request', 'verdict'); patch.verdict = b.verdict; }
    if ('text' in b) patch.text = String(b.text || '').slice(0, 4000);
    if ('visited_on' in b) { if (b.visited_on != null && !isYmd(b.visited_on)) throw new HttpError(400, 'bad_request', 'visited_on'); patch.visited_on = b.visited_on ?? null; }
    const r = await repo.updateReview(params.id, v.person.id, patch);
    if (!r) throw new HttpError(404, 'not_found', 'No such review.');
    return json({ review: r });
  });
  on('DELETE', '/api/reviews/:id', async ({ v, params }) => { if (!(await repo.delReview(params.id, v.person.id))) throw new HttpError(404, 'not_found', 'No such review.'); return new Response(null, { status: 204 }); });

  // The once-only vouch prompt (ARCHITECTURE.md §5.6). Marks seen when it offers.
  on('POST', '/api/places/:place_id/vouch-prompt', async ({ v, params }) => {
    const pid = params.place_id, me = v.person.id;
    if (!(await repo.placeById(pid))) throw new HttpError(404, 'not_found', 'No such place.');
    if (await repo.hasVouch(me, pid) || await repo.promptSeen(me, pid)) return json({ offer: false });
    const earned = (await repo.wentAt(me, pid)) || (await repo.hasLovedReview(me, pid));
    if (!earned) return json({ offer: false });
    await repo.markPromptSeen(me, pid);
    return json({ offer: true });
  });

  // ---------- events + interest ----------
  on('GET', '/api/events', async ({ ctx, url }) => {
    const q = url.searchParams;
    const view = q.get('view');
    const events = await repo.events({ from: q.get('from') || undefined, to: q.get('to') || undefined, groups: view && VIEWS.includes(view) ? [view] : parseGroups(q.get('groups')), bbox: parseBbox(q.get('bbox')) });
    return json({ events: await decorateEvents(ctx, repo, events) });
  });
  on('PUT', '/api/interest/:type/:id', async ({ v, params }) => {
    if (!['event', 'place'].includes(params.type)) throw new HttpError(400, 'bad_request', 'type');
    const exists = params.type === 'event' ? await repo.eventById(params.id) : await repo.placeById(params.id);
    if (!exists) throw new HttpError(404, 'not_found', 'No such target.');
    await repo.upsertInterest(v.person.id, params.type, params.id);
    return new Response(null, { status: 204 });
  });
  on('DELETE', '/api/interest/:type/:id', async ({ v, params }) => { await repo.delInterest(v.person.id, params.type, params.id); return new Response(null, { status: 204 }); });

  // ---------- plans ----------
  const loadPlan = async (ctx, id) => { const full = await planForViewer(ctx, repo, await repo.planById(id)); if (!full) throw new HttpError(404, 'not_found', 'No such plan.'); return full; };
  on('GET', '/api/plans', async ({ v, ctx }) => {
    await completeDue();
    const out = [];
    for (const p of await repo.plansForMember(v.person.id)) { const full = await planForViewer(ctx, repo, p); if (full) out.push(full); }
    return json({ plans: out });
  });
  on('POST', '/api/plans', async ({ v, ctx, request }) => {
    const b = await readJson(request);
    const check = validateCreate(b, ctx.mutuals);
    if (!check.ok) throw new HttpError(400, 'bad_request', check.error);
    const target = b.target_type === 'event' ? await repo.eventById(b.target_id) : await repo.placeById(b.target_id);
    if (!target) throw new HttpError(404, 'not_found', 'No such target.');
    const starts_at = b.starts_at ?? (b.target_type === 'event' ? target.starts_at : null);
    if (!starts_at) throw new HttpError(400, 'bad_request', 'starts_at required for a place plan');
    const plan = { id: ulid(), room_id: v.room.id, owner_person_id: v.person.id, target_type: b.target_type, target_id: b.target_id, starts_at: new Date(starts_at).toISOString(), status: 'open', created_at: nowIso(), done_at: null };
    const members = [{ person_id: v.person.id, state: 'in' }, ...[...new Set(b.member_ids || [])].filter((id) => id !== v.person.id).map((id) => ({ person_id: id, state: 'maybe' }))];
    await repo.insertPlan(plan, members);
    return json({ plan: await loadPlan(ctx, plan.id) }, 201);
  });
  on('GET', '/api/plans/:id', async ({ ctx, params }) => { await completeDue(); return json({ plan: await loadPlan(ctx, params.id) }); });
  on('PUT', '/api/plans/:id', async ({ v, ctx, params, request }) => {
    const plan = await loadPlan(ctx, params.id);
    if (plan.owner_person_id !== v.person.id) throw new HttpError(403, 'forbidden', 'Plan owner only.');
    const b = await readJson(request);
    if ('status' in b) { if (b.status !== 'dropped') throw new HttpError(400, 'bad_request', 'status may only be set to dropped'); await repo.updatePlan(plan.id, { status: 'dropped' }); return new Response(null, { status: 204 }); }
    if (plan.status !== 'open') throw new HttpError(400, 'bad_request', 'Plan is not open.');
    if ('starts_at' in b) { if (Number.isNaN(Date.parse(b.starts_at))) throw new HttpError(400, 'bad_request', 'starts_at'); await repo.updatePlan(plan.id, { starts_at: new Date(b.starts_at).toISOString() }); }
    for (const id of b.add_member_ids || []) { if (!ctx.mutuals.has(id)) throw new HttpError(400, 'bad_request', 'member_not_mutual'); if (!plan.members.some((m) => m.person_id === id)) await repo.setMember(plan.id, id, 'maybe'); }
    for (const id of b.remove_member_ids || []) if (id !== v.person.id) await repo.removeMember(plan.id, id);
    return json({ plan: await loadPlan(ctx, plan.id) });
  });
  on('PUT', '/api/plans/:id/me', async ({ v, ctx, params, request }) => {
    await completeDue();
    const plan = await loadPlan(ctx, params.id);
    const b = await readJson(request);
    const me = plan.members.find((m) => m.person_id === v.person.id);
    if (!canSelfTransition(plan.status, me.state, b.state)) throw new HttpError(400, 'bad_request', `cannot move ${me.state} -> ${b.state}`);
    await repo.setMember(plan.id, v.person.id, b.state);
    return json({ plan: await loadPlan(ctx, plan.id) });
  });
  on('GET', '/api/plans/:id/text', async ({ v, ctx, params, url }) => {
    const plan = await loadPlan(ctx, params.id);
    let title, locationLine, answers = {};
    if (plan.target_type === 'event') {
      const e = await repo.eventById(plan.target_id);
      const p = e ? await repo.placeById(e.place_id) : null;
      title = e?.title ?? 'Event';
      locationLine = p ? [p.name, p.address].filter(Boolean).join(', ') : '';
      answers = e?.answers ?? {};
    } else {
      const p = await repo.placeById(plan.target_id);
      title = p?.name ?? 'Place';
      locationLine = p?.address ?? '';
    }
    const text = planText({ whenLabel: whenLabel(plan.starts_at), title, locationLine, members: plan.members, answerLabels: answerLabels(answers, v.person.default_view), link: `${url.origin}/#/plan/${plan.id}` });
    return new Response(text, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  });

  // ---------- the Thursday read ----------
  on('GET', '/api/night', async ({ v, ctx, url }) => {
    await completeDue();
    const date = url.searchParams.get('date') || chicagoDate(nowIso());
    const view = url.searchParams.get('view') || v.person.default_view;
    return json(await nightRead(ctx, repo, v.room, { date, view }));
  });

  // ---------- room ----------
  on('GET', '/api/room', async ({ v }) => json({ bar: v.room.bar, mutes: await repo.mutes(v.room.id) }));
  on('PUT', '/api/room', async ({ v, request }) => {
    requireOwner(v);
    const b = await readJson(request);
    if (!Number.isInteger(b.bar) || b.bar < 0 || b.bar > 100) throw new HttpError(400, 'bad_request', 'bar');
    await repo.updateRoom(v.room.id, { bar: b.bar });
    return json({ bar: b.bar });
  });

  // ---------- owner ----------
  on('POST', '/api/admin/people', async ({ v, request }) => {
    requireOwner(v);
    const b = await readJson(request);
    const name = String(b.display_name || '').trim();
    if (!name || name.length > 40) throw new HttpError(400, 'bad_request', 'display_name');
    const token = newToken();
    const groups = Array.isArray(b.groups) ? b.groups.filter((g) => GROUPS.includes(g)) : [];
    const person = await repo.insertPerson({ id: ulid(), room_id: v.room.id, display_name: name, token_hash: await hashToken(token), groups, default_view: VIEWS.includes(b.default_view) ? b.default_view : (groups[0] || 'odd'), visibility: 'mutual', created_at: nowIso() });
    return json({ person: safePerson(person), link: personalLink(new URL(request.url).origin, token) }, 201);
  });
  on('POST', '/api/admin/people/:id/regenerate', async ({ v, params, request }) => {
    requireOwner(v);
    const p = await repo.personById(params.id);
    if (!p || p.room_id !== v.room.id) throw new HttpError(404, 'not_found', 'No such person.');
    const token = newToken();
    await repo.updatePerson(p.id, { token_hash: await hashToken(token) });
    return json({ link: personalLink(new URL(request.url).origin, token) });
  });
  on('POST', '/api/admin/people/:id/remove', async ({ v, params }) => {
    requireOwner(v);
    const p = await repo.personById(params.id);
    if (!p || p.room_id !== v.room.id || p.id === v.person.id) throw new HttpError(404, 'not_found', 'No such person.');
    await repo.updatePerson(p.id, { removed_at: nowIso() });
    await repo.delTicksBoth(p.id);
    return new Response(null, { status: 204 });
  });
  on('GET', '/api/admin/mute', async ({ v }) => { requireOwner(v); return json({ categories: await repo.mutes(v.room.id) }); });
  on('PUT', '/api/admin/mute', async ({ v, request }) => {
    requireOwner(v);
    const b = await readJson(request);
    if (!Array.isArray(b.categories) || !b.categories.every((c) => typeof c === 'string' && /^[a-z_]{1,32}$/.test(c))) throw new HttpError(400, 'bad_request', 'categories');
    await repo.setMutes(v.room.id, [...new Set(b.categories)]);
    return json({ categories: await repo.mutes(v.room.id) });
  });

  // ---------- calendar ----------
  on('GET', '/api/calendar.ics', async ({ v, ctx }) => {
    await completeDue();
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Room//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const esc = (s2) => String(s2).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    const add = (uid, startsAt, endsAt, title, where) => {
      lines.push('BEGIN:VEVENT', `UID:${uid}@room`, `DTSTAMP:${stamp(nowIso())}`, `DTSTART:${stamp(startsAt)}`,
        `DTEND:${stamp(endsAt || new Date(Date.parse(startsAt) + 2 * 3600e3).toISOString())}`, `SUMMARY:${esc(title)}`);
      if (where) lines.push(`LOCATION:${esc(where)}`);
      lines.push('END:VEVENT');
    };
    for (const p of await repo.plansForMember(v.person.id)) {
      const full = await planForViewer(ctx, repo, p);
      if (!full) continue;
      const me = full.members.find((m) => m.person_id === v.person.id);
      if (!me || (me.state !== 'in' && me.state !== 'went')) continue;
      const target = p.target_type === 'event' ? await repo.eventById(p.target_id) : await repo.placeById(p.target_id);
      const place = p.target_type === 'event' && target ? await repo.placeById(target.place_id) : target;
      add(`plan-${p.id}`, p.starts_at, null, target?.title || target?.name || 'Plan', [place?.name, place?.address].filter(Boolean).join(', '));
    }
    const events = await repo.events({ from: nowIso() });
    const mine = await ownEventInterestIds(ctx, repo, events.map((e) => e.id));
    for (const e of events) if (mine.has(e.id)) add(`event-${e.id}`, e.starts_at, e.ends_at, e.title, [e.place?.name, e.place?.address].filter(Boolean).join(', '));
    lines.push('END:VCALENDAR');
    return new Response(lines.join('\r\n'), { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="room.ics"', 'cache-control': 'no-store' } });
  });

  // ---------- pipeline (owner; explicit buttons, cron calls the same handlers) ----------
  on('POST', '/api/run/:stage', async ({ v, params, request }) => {
    requireOwner(v);
    if (!STAGES.includes(params.stage)) throw new HttpError(400, 'bad_request', 'unknown stage');
    const r = createRunner({ repo, roomId: v.room.id, env, deps: { ...deps, neighborhoods } });
    const wait = new URL(request.url).searchParams.get('wait') === '1';
    const p = r.run(params.stage);
    if (wait) return json({ stage: params.stage, counts: await p });
    if (deps.waitUntil) deps.waitUntil(p.catch(() => {})); else p.catch(() => {});
    return json({ stage: params.stage, started: true }, 202);
  });
  on('GET', '/api/run/status', async ({ v }) => { requireOwner(v); return json({ stages: await repo.runState() }); });
  on('GET', '/api/run/spend', async ({ v }) => {
    requireOwner(v);
    const month = new Date().toISOString().slice(0, 7);
    const used = await repo.spendMonth(month);
    return json({ month, used_cents: used, cap_cents: MONTHLY_CAP_CENTS, remaining_cents: Math.max(0, MONTHLY_CAP_CENTS - used) });
  });

  // ---------- dispatch ----------
  async function handle(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return null; // not ours; worker serves assets
    const method = request.method.toUpperCase();
    let matched = null, params = {};
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      matched = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      break;
    }
    try {
      if (!matched) throw new HttpError(404, 'not_found', 'No such route.');
      if (matched.opts.public) return await matched.fn({ request, url, params });
      const v = await resolveViewer(repo, request);
      if (!v) return err('token', 'Ask the room owner for a new link.', 401);
      const ctx = await loadContext(repo, v.person);
      return await matched.fn({ request, url, params, v, ctx });
    } catch (e) {
      if (e instanceof HttpError) return err(e.code, e.detail, e.status);
      if (e && e.status && e.code) return err(e.code, e.message, e.status);
      return err('bad_request', 'Something went wrong.', 500);
    }
  }

  return { handle, completeDue, routes: routes.map((r) => ({ method: r.method, pattern: r.pattern })) };
}

function toRe(pattern) { return new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:([a-z_]+)/g, '([^/]+)') + '$'); }
function keysOf(pattern) { return [...pattern.matchAll(/:([a-z_]+)/g)].map((m) => m[1]); }
