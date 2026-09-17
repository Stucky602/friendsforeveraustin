import { isDue, completeMembers } from '../lib/plans.js';

// In-memory repo. Reference implementation of the repo interface; tests run against this.
// Every function here has a twin in ./d1.js with the same name, arguments, and return shape.

const nowIso = () => new Date().toISOString();

export function memoryRepo(seed = {}) {
  const t = {
    room: [], person: [], place: [], event: [], event_source: [], vouch: [], review: [],
    interest: [], tick: [], availability: [], plan: [], plan_member: [], mute: [], prompt_seen: [],
    ...seed,
  };
  const parse = (p) => ({ ...p, groups: Array.isArray(p.groups) ? p.groups : JSON.parse(p.groups || '[]'), kid_ages: p.kid_ages == null ? null : (Array.isArray(p.kid_ages) ? p.kid_ages : JSON.parse(p.kid_ages)) });

  return {
    _t: t,

    // auth
    async personByTokenHash(hash) { const p = t.person.find((x) => x.token_hash === hash); return p ? parse(p) : null; },
    async personById(id) { const p = t.person.find((x) => x.id === id); return p ? parse(p) : null; },
    async room(id) { return t.room.find((r) => r.id === id) || null; },
    async anyRoom() { return t.room.length > 0; },
    async anyRoomRow() { return t.room[0] || null; },
    async updateRoom(id, patch) { const r = t.room.find((x) => x.id === id); if (r) Object.assign(r, patch); return r; },
    async insertRoom(row) { t.room.push(row); return row; },
    async insertPerson(row) { t.person.push({ ...row, groups: JSON.stringify(row.groups ?? []), kid_ages: row.kid_ages == null ? null : JSON.stringify(row.kid_ages) }); return parse(t.person.at(-1)); },
    async updatePerson(id, patch) {
      const p = t.person.find((x) => x.id === id); if (!p) return null;
      const q = { ...patch };
      if ('groups' in q) q.groups = JSON.stringify(q.groups);
      if ('kid_ages' in q) q.kid_ages = q.kid_ages == null ? null : JSON.stringify(q.kid_ages);
      Object.assign(p, q); return parse(p);
    },

    // people + ticks (gated tables: only gate.js may call ticksFrom/ticksTo/availability)
    async people(roomId) { return t.person.filter((p) => p.room_id === roomId).map(parse); },
    async ticksFrom(id) { return t.tick.filter((x) => x.from_person_id === id).map((x) => x.to_person_id); },
    async ticksTo(id) { return t.tick.filter((x) => x.to_person_id === id).map((x) => x.from_person_id); },
    async setTick(from, to) { if (!t.tick.some((x) => x.from_person_id === from && x.to_person_id === to)) t.tick.push({ from_person_id: from, to_person_id: to, created_at: nowIso() }); },
    async delTick(from, to) { t.tick = t.tick.filter((x) => !(x.from_person_id === from && x.to_person_id === to)); },
    async delTicksBoth(id) { t.tick = t.tick.filter((x) => x.from_person_id !== id && x.to_person_id !== id); },

    async availability(personIds, from, to) {
      const ids = new Set(personIds);
      return t.availability.filter((a) => ids.has(a.person_id) && (!from || a.end_date >= from) && (!to || a.start_date <= to));
    },
    async ownAvailability(id) { return t.availability.filter((a) => a.person_id === id); },
    async insertAvailability(row) { t.availability.push(row); return row; },
    async delAvailability(id, personId) { const n = t.availability.length; t.availability = t.availability.filter((a) => !(a.id === id && a.person_id === personId)); return t.availability.length < n; },

    // places
    async places({ bbox, groups } = {}) {
      return t.place.filter((p) => !p.merged_into).filter((p) => {
        if (bbox && p.lat != null) { const [w, s, e, n] = bbox; if (p.lng < w || p.lng > e || p.lat < s || p.lat > n) return false; }
        if (groups?.length) { const g = JSON.parse(p.groups || '[]'); if (!groups.some((x) => g.includes(x))) return false; }
        return true;
      }).map((p) => ({ ...p, groups: JSON.parse(p.groups || '[]') }));
    },
    async placeById(id) { let p = t.place.find((x) => x.id === id); while (p?.merged_into) p = t.place.find((x) => x.id === p.merged_into); return p ? { ...p, groups: JSON.parse(p.groups || '[]') } : null; },
    async placeByKey(key) { const p = t.place.find((x) => x.canonical_key === key); return p ? { ...p, groups: JSON.parse(p.groups || '[]') } : null; },
    async insertPlace(row) { t.place.push({ ...row, groups: JSON.stringify(row.groups ?? []) }); return { ...row, groups: row.groups ?? [] }; },

    async vouchCounts(ids) { const m = new Map(); for (const v of t.vouch) if (ids.includes(v.place_id)) m.set(v.place_id, (m.get(v.place_id) || 0) + 1); return m; },
    async vouches(ids) { return t.vouch.filter((v) => ids.includes(v.place_id)); },
    async upsertVouch(placeId, personId, line) { const v = t.vouch.find((x) => x.place_id === placeId && x.person_id === personId); if (v) v.line = line; else t.vouch.push({ place_id: placeId, person_id: personId, line, created_at: nowIso() }); },
    async delVouch(placeId, personId) { t.vouch = t.vouch.filter((x) => !(x.place_id === placeId && x.person_id === personId)); },

    async reviewAgg(ids) {
      const m = new Map();
      for (const r of t.review) {
        if (!ids.includes(r.place_id)) continue;
        if (!m.has(r.place_id)) m.set(r.place_id, { count: 0, verdicts: { loved: 0, fine: 0, bounced: 0 } });
        const a = m.get(r.place_id); a.count++; a.verdicts[r.verdict]++;
      }
      return m;
    },
    async reviews(ids) { return t.review.filter((r) => ids.includes(r.place_id)); },
    async reviewById(id) { return t.review.find((r) => r.id === id) || null; },
    async insertReview(row) { t.review.push(row); return row; },
    async updateReview(id, personId, patch) { const r = t.review.find((x) => x.id === id && x.person_id === personId); if (!r) return null; Object.assign(r, patch, { updated_at: nowIso() }); return r; },
    async delReview(id, personId) { const n = t.review.length; t.review = t.review.filter((x) => !(x.id === id && x.person_id === personId)); return t.review.length < n; },
    async hasLovedReview(personId, placeId) { return t.review.some((r) => r.person_id === personId && r.place_id === placeId && r.verdict === 'loved'); },

    // interest
    async interestCounts(type, ids) { const m = new Map(); for (const i of t.interest) if (i.target_type === type && ids.includes(i.target_id)) m.set(i.target_id, (m.get(i.target_id) || 0) + 1); return m; },
    async interests(type, ids) { return t.interest.filter((i) => i.target_type === type && ids.includes(i.target_id)); },
    async upsertInterest(personId, type, id) { const i = t.interest.find((x) => x.person_id === personId && x.target_type === type && x.target_id === id); const n = nowIso(); if (i) i.refreshed_at = n; else t.interest.push({ person_id: personId, target_type: type, target_id: id, created_at: n, refreshed_at: n }); },
    async delInterest(personId, type, id) { t.interest = t.interest.filter((x) => !(x.person_id === personId && x.target_type === type && x.target_id === id)); },

    // events
    async events({ from, to, groups, bbox } = {}) {
      const byPlace = new Map(t.place.map((p) => [p.id, p]));
      return t.event.filter((e) => e.status === 'live')
        .filter((e) => (!from || e.starts_at >= from) && (!to || e.starts_at <= to))
        .filter((e) => { if (!groups?.length) return true; const g = JSON.parse(e.groups || '[]'); return groups.some((x) => g.includes(x)); })
        .filter((e) => { if (!bbox) return true; const p = byPlace.get(e.place_id); if (!p || p.lat == null) return false; const [w, s, en, n] = bbox; return !(p.lng < w || p.lng > en || p.lat < s || p.lat > n); })
        .map((e) => ({ ...e, groups: JSON.parse(e.groups || '[]'), answers: typeof e.answers === 'string' ? JSON.parse(e.answers || '{}') : e.answers, place: (() => { const p = byPlace.get(e.place_id); return p ? { id: p.id, name: p.name, address: p.address, lat: p.lat, lng: p.lng, neighborhood: p.neighborhood } : null; })(), sources: t.event_source.filter((s) => s.event_id === e.id).map((s) => ({ url: s.source_url })) }));
    },
    async eventById(id) { const e = t.event.find((x) => x.id === id); return e ? { ...e, groups: JSON.parse(e.groups || '[]'), answers: typeof e.answers === 'string' ? JSON.parse(e.answers || '{}') : e.answers } : null; },

    // plans (gated: only gate.js may call planMembers; plansForMember is gate-adjacent and used only by gate/routes through gate)
    async plansForMember(personId) { const ids = new Set(t.plan_member.filter((m) => m.person_id === personId).map((m) => m.plan_id)); return t.plan.filter((p) => ids.has(p.id) && p.status !== 'dropped'); },
    async planById(id) { return t.plan.find((p) => p.id === id) || null; },
    async planMembers(planId) { return t.plan_member.filter((m) => m.plan_id === planId); },
    async insertPlan(row, members) { t.plan.push(row); for (const m of members) t.plan_member.push({ plan_id: row.id, ...m, updated_at: nowIso() }); return row; },
    async updatePlan(id, patch) { const p = t.plan.find((x) => x.id === id); if (p) Object.assign(p, patch); return p; },
    async setMember(planId, personId, state) { const m = t.plan_member.find((x) => x.plan_id === planId && x.person_id === personId); if (m) { m.state = state; m.updated_at = nowIso(); } else t.plan_member.push({ plan_id: planId, person_id: personId, state, updated_at: nowIso() }); },
    async removeMember(planId, personId) { t.plan_member = t.plan_member.filter((x) => !(x.plan_id === planId && x.person_id === personId)); },
    async completeDuePlans(nowMs) {
      let n = 0;
      for (const p of t.plan) {
        if (!isDue(p, nowMs)) continue;
        const updated = completeMembers(t.plan_member.filter((m) => m.plan_id === p.id));
        for (const m of updated) { const row = t.plan_member.find((x) => x.plan_id === p.id && x.person_id === m.person_id); row.state = m.state; }
        p.status = 'done'; p.done_at = new Date(nowMs).toISOString(); n++;
      }
      return n;
    },

    async promptSeen(personId, placeId) { return t.prompt_seen.some((x) => x.person_id === personId && x.place_id === placeId); },
    async markPromptSeen(personId, placeId) { if (!(await this.promptSeen(personId, placeId))) t.prompt_seen.push({ person_id: personId, place_id: placeId, created_at: nowIso() }); },
    async hasVouch(personId, placeId) { return t.vouch.some((v) => v.person_id === personId && v.place_id === placeId); },
    async wentAt(personId, placeId) {
      const planIds = new Set(t.plan.filter((p) => p.status === 'done' && p.target_type === 'place' && p.target_id === placeId).map((p) => p.id));
      for (const e of t.event) if (e.place_id === placeId) for (const p of t.plan) if (p.status === 'done' && p.target_type === 'event' && p.target_id === e.id) planIds.add(p.id);
      return t.plan_member.some((m) => planIds.has(m.plan_id) && m.person_id === personId && m.state === 'went');
    },

    async mutes(roomId) { return t.mute.filter((m) => m.room_id === roomId).map((m) => m.category); },
    async setMutes(roomId, categories) { t.mute = t.mute.filter((m) => m.room_id !== roomId); for (const c of categories) t.mute.push({ room_id: roomId, category: c }); },
  };
}

// ---- pipeline additions (kept out of memoryRepo's literal for readability) ----
export function withPipeline(repo) {
  const t = repo._t;
  t.fetch_cache ||= []; t.run_state ||= []; t.spend_log ||= [];
  const nowIso = () => new Date().toISOString();
  const parseEvent = (e) => ({ ...e, groups: JSON.parse(e.groups || '[]'), answers: JSON.parse(e.answers || '{}'), raw: JSON.parse(e.raw || '{}') });
  return Object.assign(repo, {
    async cacheGet(url) { return t.fetch_cache.find((c) => c.url === url) || null; },
    async cachePut(url, body, status) { const i = t.fetch_cache.findIndex((c) => c.url === url); const row = { url, body, status, fetched_at: nowIso() }; if (i >= 0) t.fetch_cache[i] = row; else t.fetch_cache.push(row); },
    async setRunState(stage, patch) { let r = t.run_state.find((x) => x.stage === stage); if (!r) { r = { stage, counts: '{}' }; t.run_state.push(r); } Object.assign(r, patch, 'counts' in patch ? { counts: JSON.stringify(patch.counts) } : {}); },
    async runState() { return t.run_state.map((r) => ({ ...r, counts: JSON.parse(r.counts || '{}') })); },
    async spendMonth(month) { return t.spend_log.filter((s) => s.month === month).reduce((a, b) => a + b.cents, 0); },
    async addSpend(row) { t.spend_log.push(row); },
    async eventBySource(source, sourceId) { return t.event_source.find((s) => s.source === source && s.source_id === sourceId) || null; },
    async addEventSource(row) { if (!t.event_source.some((s) => s.source === row.source && s.source_id === row.source_id)) t.event_source.push(row); },
    async sourcesFor(eventId) { return t.event_source.filter((s) => s.event_id === eventId); },
    async touchEvent(id, seenAt) { const e = t.event.find((x) => x.id === id); if (e) e.last_seen = seenAt; },
    async eventByDedupeKey(key) { const e = t.event.find((x) => x.dedupe_key === key); return e ? parseEvent(e) : null; },
    async liveEventsAtPlace(placeId, from, to) { return t.event.filter((e) => e.place_id === placeId && e.status === 'live' && e.starts_at >= from && e.starts_at <= to).map(parseEvent); },
    async insertEvent(e) { t.event.push({ ...e, groups: JSON.stringify(e.groups ?? []), answers: JSON.stringify(e.answers ?? {}), raw: JSON.stringify(e.raw ?? {}) }); return e; },
    async placesNeedingGeocode(limit) { return t.place.filter((p) => p.lat == null && p.geocode_source == null).slice(0, limit).map((p) => ({ ...p, groups: JSON.parse(p.groups || '[]') })); },
    async updatePlaceGeo(id, patch) { const p = t.place.find((x) => x.id === id); if (p) Object.assign(p, patch); },
    async eventsNeedingClassify(limit) { return t.event.filter((e) => e.status === 'live' && JSON.parse(e.groups || '[]').length === 0).slice(0, limit).map(parseEvent); },
    async setEventStatus(id, status, reason) { const e = t.event.find((x) => x.id === id); if (e) { e.status = status; e.reject_reason = reason ?? null; } },
    async setEventClassification(id, groups, answers) { const e = t.event.find((x) => x.id === id); if (e) { e.groups = JSON.stringify(groups); e.answers = JSON.stringify(answers); } },
    async eventsNeedingScore(limit) { return t.event.filter((e) => e.status === 'live' && JSON.parse(e.groups || '[]').length > 0 && e.score === 0).slice(0, limit).map(parseEvent); },
    async setEventScore(id, score) { const e = t.event.find((x) => x.id === id); if (e) e.score = score; },
    async expireEvents(nowIso_) { let n = 0; for (const e of t.event) { if (e.status !== 'live') continue; const end = e.ends_at ? Date.parse(e.ends_at) : Date.parse(e.starts_at) + 6 * 3600e3; if (end <= Date.parse(nowIso_)) { e.status = 'expired'; n++; } } return n; },
    async withdrawUnseen(cutoff, nowIso_) { let n = 0; for (const e of t.event) { if (e.status !== 'live') continue; if (e.starts_at <= nowIso_) continue; if (e.last_seen > cutoff) continue; e.status = 'rejected'; e.reject_reason = 'withdrawn'; n++; } return n; },
    async restoreWithdrawn(cutoff) { let n = 0; for (const e of t.event) { if (e.status === 'rejected' && e.reject_reason === 'withdrawn' && e.last_seen > cutoff) { e.status = 'live'; e.reject_reason = null; n++; } } return n; },
  });
}
