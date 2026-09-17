// D1 repo. Production twin of ./memory.js: same names, arguments, and shapes.
// All SQL in the app lives in this file. The gate (src/lib/gate.js) is the only
// caller of the functions that return gated rows.

const nowIso = () => new Date().toISOString();
const ph = (n) => Array.from({ length: n }, () => '?').join(',');
const parsePerson = (p) => (p ? { ...p, groups: JSON.parse(p.groups || '[]'), kid_ages: p.kid_ages == null ? null : JSON.parse(p.kid_ages) } : null);
const parsePlace = (p) => (p ? { ...p, groups: JSON.parse(p.groups || '[]') } : null);

export function d1Repo(db) {
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results ?? [];
  const first = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()) ?? null;
  const run = async (sql, ...args) => db.prepare(sql).bind(...args).run();

  return {
    async personByTokenHash(hash) { return parsePerson(await first('SELECT * FROM person WHERE token_hash = ?', hash)); },
    async personById(id) { return parsePerson(await first('SELECT * FROM person WHERE id = ?', id)); },
    async room(id) { return first('SELECT * FROM room WHERE id = ?', id); },
    async anyRoom() { return !!(await first('SELECT 1 AS x FROM room LIMIT 1')); },
    async anyRoomRow() { return first('SELECT * FROM room LIMIT 1'); },
    async updateRoom(id, patch) {
      if ('bar' in patch) await run('UPDATE room SET bar = ? WHERE id = ?', patch.bar, id);
      if ('owner_person_id' in patch) await run('UPDATE room SET owner_person_id = ? WHERE id = ?', patch.owner_person_id, id);
      return this.room(id);
    },
    async insertRoom(r) { await run('INSERT INTO room (id, name, owner_person_id, bar, created_at) VALUES (?,?,?,?,?)', r.id, r.name, r.owner_person_id ?? null, r.bar ?? 50, r.created_at); return r; },
    async insertPerson(p) {
      await run('INSERT INTO person (id, room_id, display_name, token_hash, groups, kid_ages, default_view, visibility, removed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        p.id, p.room_id, p.display_name, p.token_hash, JSON.stringify(p.groups ?? []), p.kid_ages == null ? null : JSON.stringify(p.kid_ages), p.default_view ?? 'odd', p.visibility ?? 'mutual', p.removed_at ?? null, p.created_at);
      return this.personById(p.id);
    },
    async updatePerson(id, patch) {
      const sets = [], args = [];
      for (const [k, v] of Object.entries(patch)) {
        if (!['display_name', 'token_hash', 'groups', 'kid_ages', 'default_view', 'visibility', 'removed_at'].includes(k)) continue;
        sets.push(`${k} = ?`);
        args.push(k === 'groups' ? JSON.stringify(v) : k === 'kid_ages' ? (v == null ? null : JSON.stringify(v)) : v);
      }
      if (sets.length) await run(`UPDATE person SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
      return this.personById(id);
    },

    async people(roomId) { return (await all('SELECT * FROM person WHERE room_id = ?', roomId)).map(parsePerson); },
    async ticksFrom(id) { return (await all('SELECT to_person_id FROM tick WHERE from_person_id = ?', id)).map((r) => r.to_person_id); },
    async ticksTo(id) { return (await all('SELECT from_person_id FROM tick WHERE to_person_id = ?', id)).map((r) => r.from_person_id); },
    async setTick(from, to) { await run('INSERT OR IGNORE INTO tick (from_person_id, to_person_id, created_at) VALUES (?,?,?)', from, to, nowIso()); },
    async delTick(from, to) { await run('DELETE FROM tick WHERE from_person_id = ? AND to_person_id = ?', from, to); },
    async delTicksBoth(id) { await run('DELETE FROM tick WHERE from_person_id = ? OR to_person_id = ?', id, id); },

    async availability(personIds, from, to) {
      if (!personIds.length) return [];
      let sql = `SELECT * FROM availability WHERE person_id IN (${ph(personIds.length)})`;
      const args = [...personIds];
      if (from) { sql += ' AND end_date >= ?'; args.push(from); }
      if (to) { sql += ' AND start_date <= ?'; args.push(to); }
      return all(sql, ...args);
    },
    async ownAvailability(id) { return all('SELECT * FROM availability WHERE person_id = ? ORDER BY start_date', id); },
    async insertAvailability(a) { await run('INSERT INTO availability (id, person_id, kind, start_date, end_date, note) VALUES (?,?,?,?,?,?)', a.id, a.person_id, a.kind, a.start_date, a.end_date, a.note ?? null); return a; },
    async delAvailability(id, personId) { const r = await run('DELETE FROM availability WHERE id = ? AND person_id = ?', id, personId); return (r.meta?.changes ?? 0) > 0; },

    async places({ bbox, groups } = {}) {
      let sql = 'SELECT * FROM place WHERE merged_into IS NULL';
      const args = [];
      if (bbox) { sql += ' AND lng >= ? AND lng <= ? AND lat >= ? AND lat <= ?'; args.push(bbox[0], bbox[2], bbox[1], bbox[3]); }
      let rows = (await all(sql, ...args)).map(parsePlace);
      if (groups?.length) rows = rows.filter((p) => groups.some((g) => p.groups.includes(g)));
      return rows;
    },
    async placeById(id) {
      let p = parsePlace(await first('SELECT * FROM place WHERE id = ?', id));
      let hops = 0;
      while (p?.merged_into && hops++ < 5) p = parsePlace(await first('SELECT * FROM place WHERE id = ?', p.merged_into));
      return p;
    },
    async placeByKey(key) { return parsePlace(await first('SELECT * FROM place WHERE canonical_key = ?', key)); },
    async insertPlace(p) {
      await run('INSERT INTO place (id, name, address, lat, lng, neighborhood, groups, canonical_key, geocode_source, geocoded_at, created_by, merged_into, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        p.id, p.name, p.address ?? null, p.lat ?? null, p.lng ?? null, p.neighborhood ?? null, JSON.stringify(p.groups ?? []), p.canonical_key, p.geocode_source ?? null, p.geocoded_at ?? null, p.created_by, null, p.created_at);
      return { ...p, groups: p.groups ?? [] };
    },

    async vouchCounts(ids) { if (!ids.length) return new Map(); const rows = await all(`SELECT place_id, COUNT(*) AS n FROM vouch WHERE place_id IN (${ph(ids.length)}) GROUP BY place_id`, ...ids); return new Map(rows.map((r) => [r.place_id, r.n])); },
    async vouches(ids) { if (!ids.length) return []; return all(`SELECT * FROM vouch WHERE place_id IN (${ph(ids.length)})`, ...ids); },
    async upsertVouch(placeId, personId, line) { await run('INSERT INTO vouch (place_id, person_id, line, created_at) VALUES (?,?,?,?) ON CONFLICT(place_id, person_id) DO UPDATE SET line = excluded.line', placeId, personId, line, nowIso()); },
    async delVouch(placeId, personId) { await run('DELETE FROM vouch WHERE place_id = ? AND person_id = ?', placeId, personId); },

    async reviewAgg(ids) {
      if (!ids.length) return new Map();
      const rows = await all(`SELECT place_id, verdict, COUNT(*) AS n FROM review WHERE place_id IN (${ph(ids.length)}) GROUP BY place_id, verdict`, ...ids);
      const m = new Map();
      for (const r of rows) {
        if (!m.has(r.place_id)) m.set(r.place_id, { count: 0, verdicts: { loved: 0, fine: 0, bounced: 0 } });
        const a = m.get(r.place_id); a.count += r.n; a.verdicts[r.verdict] = (a.verdicts[r.verdict] || 0) + r.n;
      }
      return m;
    },
    async reviews(ids) { if (!ids.length) return []; return all(`SELECT * FROM review WHERE place_id IN (${ph(ids.length)})`, ...ids); },
    async reviewById(id) { return first('SELECT * FROM review WHERE id = ?', id); },
    async insertReview(r) { await run('INSERT INTO review (id, place_id, person_id, visited_on, verdict, text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', r.id, r.place_id, r.person_id, r.visited_on ?? null, r.verdict, r.text ?? '', r.created_at, r.updated_at); return r; },
    async updateReview(id, personId, patch) {
      const sets = [], args = [];
      for (const k of ['visited_on', 'verdict', 'text']) if (k in patch) { sets.push(`${k} = ?`); args.push(patch[k]); }
      sets.push('updated_at = ?'); args.push(nowIso());
      const r = await run(`UPDATE review SET ${sets.join(', ')} WHERE id = ? AND person_id = ?`, ...args, id, personId);
      return (r.meta?.changes ?? 0) > 0 ? this.reviewById(id) : null;
    },
    async delReview(id, personId) { const r = await run('DELETE FROM review WHERE id = ? AND person_id = ?', id, personId); return (r.meta?.changes ?? 0) > 0; },
    async hasLovedReview(personId, placeId) { return !!(await first("SELECT 1 AS x FROM review WHERE person_id = ? AND place_id = ? AND verdict = 'loved' LIMIT 1", personId, placeId)); },

    async interestCounts(type, ids) { if (!ids.length) return new Map(); const rows = await all(`SELECT target_id, COUNT(*) AS n FROM interest WHERE target_type = ? AND target_id IN (${ph(ids.length)}) GROUP BY target_id`, type, ...ids); return new Map(rows.map((r) => [r.target_id, r.n])); },
    async interests(type, ids) { if (!ids.length) return []; return all(`SELECT * FROM interest WHERE target_type = ? AND target_id IN (${ph(ids.length)})`, type, ...ids); },
    async upsertInterest(personId, type, id) { const n = nowIso(); await run('INSERT INTO interest (person_id, target_type, target_id, created_at, refreshed_at) VALUES (?,?,?,?,?) ON CONFLICT(person_id, target_type, target_id) DO UPDATE SET refreshed_at = excluded.refreshed_at', personId, type, id, n, n); },
    async delInterest(personId, type, id) { await run('DELETE FROM interest WHERE person_id = ? AND target_type = ? AND target_id = ?', personId, type, id); },

    async events({ from, to, groups, bbox } = {}) {
      let sql = `SELECT e.*, p.id AS p_id, p.name AS p_name, p.address AS p_address, p.lat AS p_lat, p.lng AS p_lng, p.neighborhood AS p_neighborhood
                 FROM event e JOIN place p ON p.id = e.place_id WHERE e.status = 'live'`;
      const args = [];
      if (from) { sql += ' AND e.starts_at >= ?'; args.push(from); }
      if (to) { sql += ' AND e.starts_at <= ?'; args.push(to); }
      if (bbox) { sql += ' AND p.lng >= ? AND p.lng <= ? AND p.lat >= ? AND p.lat <= ?'; args.push(bbox[0], bbox[2], bbox[1], bbox[3]); }
      sql += ' ORDER BY e.starts_at';
      let rows = await all(sql, ...args);
      const ids = rows.map((r) => r.id);
      const srcs = ids.length ? await all(`SELECT event_id, source_url FROM event_source WHERE event_id IN (${ph(ids.length)})`, ...ids) : [];
      const srcBy = new Map();
      for (const s of srcs) { if (!srcBy.has(s.event_id)) srcBy.set(s.event_id, []); srcBy.get(s.event_id).push({ url: s.source_url }); }
      rows = rows.map(({ p_id, p_name, p_address, p_lat, p_lng, p_neighborhood, ...e }) => ({
        ...e, groups: JSON.parse(e.groups || '[]'), answers: JSON.parse(e.answers || '{}'),
        place: { id: p_id, name: p_name, address: p_address, lat: p_lat, lng: p_lng, neighborhood: p_neighborhood },
        sources: srcBy.get(e.id) ?? [],
      }));
      if (groups?.length) rows = rows.filter((e) => groups.some((g) => e.groups.includes(g)));
      return rows;
    },
    async eventById(id) { const e = await first('SELECT * FROM event WHERE id = ?', id); return e ? { ...e, groups: JSON.parse(e.groups || '[]'), answers: JSON.parse(e.answers || '{}') } : null; },

    async plansForMember(personId) { return all(`SELECT p.* FROM plan p JOIN plan_member m ON m.plan_id = p.id WHERE m.person_id = ? AND p.status != 'dropped' ORDER BY p.starts_at`, personId); },
    async planById(id) { return first('SELECT * FROM plan WHERE id = ?', id); },
    async planMembers(planId) { return all('SELECT * FROM plan_member WHERE plan_id = ?', planId); },
    async insertPlan(p, members) {
      await run('INSERT INTO plan (id, room_id, owner_person_id, target_type, target_id, starts_at, status, created_at, done_at) VALUES (?,?,?,?,?,?,?,?,?)', p.id, p.room_id, p.owner_person_id, p.target_type, p.target_id, p.starts_at, p.status ?? 'open', p.created_at, null);
      const n = nowIso();
      for (const m of members) await run('INSERT INTO plan_member (plan_id, person_id, state, updated_at) VALUES (?,?,?,?)', p.id, m.person_id, m.state, n);
      return p;
    },
    async updatePlan(id, patch) {
      const sets = [], args = [];
      for (const k of ['starts_at', 'status', 'done_at']) if (k in patch) { sets.push(`${k} = ?`); args.push(patch[k]); }
      if (sets.length) await run(`UPDATE plan SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
      return this.planById(id);
    },
    async setMember(planId, personId, state) { await run('INSERT INTO plan_member (plan_id, person_id, state, updated_at) VALUES (?,?,?,?) ON CONFLICT(plan_id, person_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at', planId, personId, state, nowIso()); },
    async removeMember(planId, personId) { await run('DELETE FROM plan_member WHERE plan_id = ? AND person_id = ?', planId, personId); },
    async completeDuePlans(nowMs) {
      const cutoff = new Date(nowMs - 6 * 3600e3).toISOString();
      await run("UPDATE plan_member SET state = 'went', updated_at = ? WHERE state = 'in' AND plan_id IN (SELECT id FROM plan WHERE status = 'open' AND starts_at <= ?)", nowIso(), cutoff);
      const r = await run("UPDATE plan SET status = 'done', done_at = ? WHERE status = 'open' AND starts_at <= ?", new Date(nowMs).toISOString(), cutoff);
      return r.meta?.changes ?? 0;
    },

    async promptSeen(personId, placeId) { return !!(await first('SELECT 1 AS x FROM prompt_seen WHERE person_id = ? AND place_id = ?', personId, placeId)); },
    async markPromptSeen(personId, placeId) { await run('INSERT OR IGNORE INTO prompt_seen (person_id, place_id, created_at) VALUES (?,?,?)', personId, placeId, nowIso()); },
    async hasVouch(personId, placeId) { return !!(await first('SELECT 1 AS x FROM vouch WHERE person_id = ? AND place_id = ?', personId, placeId)); },
    async wentAt(personId, placeId) {
      return !!(await first(`SELECT 1 AS x FROM plan_member m JOIN plan p ON p.id = m.plan_id
        WHERE m.person_id = ? AND m.state = 'went' AND p.status = 'done'
          AND ((p.target_type = 'place' AND p.target_id = ?) OR (p.target_type = 'event' AND p.target_id IN (SELECT id FROM event WHERE place_id = ?)))
        LIMIT 1`, personId, placeId, placeId));
    },

    async mutes(roomId) { return (await all('SELECT category FROM mute WHERE room_id = ?', roomId)).map((r) => r.category); },
    async setMutes(roomId, categories) { await run('DELETE FROM mute WHERE room_id = ?', roomId); for (const c of categories) await run('INSERT OR IGNORE INTO mute (room_id, category) VALUES (?,?)', roomId, c); },
  };
}

// ---- pipeline additions. Twin of withPipeline() in ./memory.js ----
export function withPipeline(repo, db) {
  const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results ?? [];
  const first = async (sql, ...a) => (await db.prepare(sql).bind(...a).first()) ?? null;
  const run = async (sql, ...a) => db.prepare(sql).bind(...a).run();
  const iso = () => new Date().toISOString();
  const parseEvent = (e) => (e ? { ...e, groups: JSON.parse(e.groups || '[]'), answers: JSON.parse(e.answers || '{}'), raw: JSON.parse(e.raw || '{}') } : null);
  const parsePlace = (p) => ({ ...p, groups: JSON.parse(p.groups || '[]') });
  return Object.assign(repo, {
    async cacheGet(url) { return first('SELECT * FROM fetch_cache WHERE url = ?', url); },
    async cachePut(url, body, status) { await run('INSERT INTO fetch_cache (url, body, status, fetched_at) VALUES (?,?,?,?) ON CONFLICT(url) DO UPDATE SET body = excluded.body, status = excluded.status, fetched_at = excluded.fetched_at', url, body, status, iso()); },
    async setRunState(stage, patch) {
      await run("INSERT OR IGNORE INTO run_state (stage, counts) VALUES (?, '{}')", stage);
      const sets = [], args = [];
      for (const k of ['last_run', 'last_ok', 'error', 'parked_until']) if (k in patch) { sets.push(`${k} = ?`); args.push(patch[k]); }
      if ('counts' in patch) { sets.push('counts = ?'); args.push(JSON.stringify(patch.counts)); }
      if (sets.length) await run(`UPDATE run_state SET ${sets.join(', ')} WHERE stage = ?`, ...args, stage);
    },
    async runState() { return (await all('SELECT * FROM run_state')).map((r) => ({ ...r, counts: JSON.parse(r.counts || '{}') })); },
    async spendMonth(month) { const r = await first('SELECT COALESCE(SUM(cents), 0) AS c FROM spend_log WHERE month = ?', month); return r?.c ?? 0; },
    async addSpend(row) { await run('INSERT INTO spend_log (id, month, tier, cents, created_at) VALUES (?,?,?,?,?)', row.id, row.month, row.tier, row.cents, row.created_at); },
    async eventBySource(source, sourceId) { return first('SELECT * FROM event_source WHERE source = ? AND source_id = ?', source, sourceId); },
    async addEventSource(r) { await run('INSERT OR IGNORE INTO event_source (event_id, source, source_id, source_url, seen_at) VALUES (?,?,?,?,?)', r.event_id, r.source, r.source_id, r.source_url ?? null, r.seen_at); },
    async sourcesFor(eventId) { return all('SELECT * FROM event_source WHERE event_id = ?', eventId); },
    async touchEvent(id, seenAt) { await run('UPDATE event SET last_seen = ? WHERE id = ?', seenAt, id); },
    async eventByDedupeKey(key) { return parseEvent(await first('SELECT * FROM event WHERE dedupe_key = ?', key)); },
    async liveEventsAtPlace(placeId, from, to) { return (await all("SELECT * FROM event WHERE place_id = ? AND status = 'live' AND starts_at >= ? AND starts_at <= ?", placeId, from, to)).map(parseEvent); },
    async insertEvent(e) {
      await run('INSERT INTO event (id, place_id, title, starts_at, ends_at, groups, answers, score, status, reject_reason, dedupe_key, raw, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        e.id, e.place_id, e.title, e.starts_at, e.ends_at ?? null, JSON.stringify(e.groups ?? []), JSON.stringify(e.answers ?? {}), e.score ?? 0, e.status ?? 'live', e.reject_reason ?? null, e.dedupe_key, JSON.stringify(e.raw ?? {}), e.first_seen, e.last_seen);
      return e;
    },
    async placesNeedingGeocode(limit) { return (await all('SELECT * FROM place WHERE lat IS NULL AND geocode_source IS NULL LIMIT ?', limit)).map(parsePlace); },
    async updatePlaceGeo(id, patch) {
      const sets = [], args = [];
      for (const k of ['lat', 'lng', 'neighborhood', 'geocode_source', 'geocoded_at']) if (k in patch) { sets.push(`${k} = ?`); args.push(patch[k]); }
      if (sets.length) await run(`UPDATE place SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
    },
    async eventsNeedingClassify(limit) { return (await all("SELECT * FROM event WHERE status = 'live' AND groups = '[]' LIMIT ?", limit)).map(parseEvent); },
    async setEventStatus(id, status, reason) { await run('UPDATE event SET status = ?, reject_reason = ? WHERE id = ?', status, reason ?? null, id); },
    async setEventClassification(id, groups, answers) { await run('UPDATE event SET groups = ?, answers = ? WHERE id = ?', JSON.stringify(groups), JSON.stringify(answers), id); },
    async eventsNeedingScore(limit) { return (await all("SELECT * FROM event WHERE status = 'live' AND groups != '[]' AND score = 0 LIMIT ?", limit)).map(parseEvent); },
    async setEventScore(id, score) { await run('UPDATE event SET score = ? WHERE id = ?', score, id); },
    async expireEvents(nowIso_) {
      const minus6h = new Date(Date.parse(nowIso_) - 6 * 3600e3).toISOString();
      const r = await run("UPDATE event SET status = 'expired' WHERE status = 'live' AND ((ends_at IS NOT NULL AND ends_at <= ?) OR (ends_at IS NULL AND starts_at <= ?))", nowIso_, minus6h);
      return r.meta?.changes ?? 0;
    },
    async withdrawUnseen(cutoff, nowIso_) { const r = await run("UPDATE event SET status = 'rejected', reject_reason = 'withdrawn' WHERE status = 'live' AND starts_at > ? AND last_seen <= ?", nowIso_, cutoff); return r.meta?.changes ?? 0; },
    async diagnose() {
      const tally = async (sql, key) => Object.fromEntries((await all(sql)).map((r) => [r[key] ?? 'null', r.n]));
      const one = async (sql) => (await first(sql))?.n ?? 0;
      const sample = await all("SELECT e.title, e.starts_at, e.score, e.groups, e.place_id, p.name AS place FROM event e LEFT JOIN place p ON p.id = e.place_id WHERE e.status = 'live' ORDER BY e.starts_at LIMIT 5");
      return {
        places: {
          total: await one('SELECT COUNT(*) AS n FROM place'),
          with_coords: await one('SELECT COUNT(*) AS n FROM place WHERE lat IS NOT NULL'),
          awaiting_geocode: await one('SELECT COUNT(*) AS n FROM place WHERE lat IS NULL AND geocode_source IS NULL'),
          by_geocode_source: await tally('SELECT geocode_source, COUNT(*) AS n FROM place GROUP BY geocode_source', 'geocode_source'),
        },
        events: {
          total: await one('SELECT COUNT(*) AS n FROM event'),
          by_status: await tally('SELECT status, COUNT(*) AS n FROM event GROUP BY status', 'status'),
          by_reject: await tally("SELECT reject_reason, COUNT(*) AS n FROM event WHERE status = 'rejected' GROUP BY reject_reason", 'reject_reason'),
          classified: await one("SELECT COUNT(*) AS n FROM event WHERE groups != '[]'"),
          scored_above_zero: await one('SELECT COUNT(*) AS n FROM event WHERE score > 0'),
          live_future: await one("SELECT COUNT(*) AS n FROM event WHERE status = 'live' AND starts_at > datetime('now')"),
        },
        sources: await tally('SELECT source, COUNT(*) AS n FROM event_source GROUP BY source', 'source'),
        sample: sample.map((r) => ({ ...r, groups: JSON.parse(r.groups || '[]'), place: r.place ?? 'MISSING' })),
      };
    },
    async restoreWithdrawn(cutoff) { const r = await run("UPDATE event SET status = 'live', reject_reason = NULL WHERE status = 'rejected' AND reject_reason = 'withdrawn' AND last_seen > ?", cutoff); return r.meta?.changes ?? 0; },
  });
}
