import { memoryRepo } from '../src/repo/memory.js';
import { createApp } from '../src/app.js';
import { hashToken } from '../src/lib/auth.js';

export const TOKENS = {
  kevin: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
  josh: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
  dana: 'cccccccccccccccccccccccccc',
  pat: 'dddddddddddddddddddddddddd',
  gone: 'eeeeeeeeeeeeeeeeeeeeeeeeee',
};

export const IDS = { room: 'R1', kevin: 'P_KEVIN', josh: 'P_JOSH', dana: 'P_DANA', pat: 'P_PAT', gone: 'P_GONE', place: 'PL1', place2: 'PL2', event: 'EV1', plan: 'PLAN1' };

const T0 = '2026-09-10T00:00:00.000Z';

/**
 * Kevin = owner. Josh <-> Kevin mutual. Dana ticked Kevin but Kevin did not tick back (one-way).
 * Pat = public, no ticks. Gone = removed, was mutual with Kevin (ticks deleted on removal).
 */
export async function seed() {
  const repo = memoryRepo();
  await repo.insertRoom({ id: IDS.room, name: 'Test Room', owner_person_id: IDS.kevin, bar: 50, created_at: T0 });
  const person = async (id, name, token, extra = {}) => repo.insertPerson({ id, room_id: IDS.room, display_name: name, token_hash: await hashToken(token), groups: ['odd'], kid_ages: null, default_view: 'odd', visibility: 'mutual', created_at: T0, ...extra });
  await person(IDS.kevin, 'Kevin', TOKENS.kevin, { groups: ['foodie', 'odd'], kid_ages: [6] });
  await person(IDS.josh, 'Josh', TOKENS.josh, { groups: ['foodie'], kid_ages: [3, 7] });
  await person(IDS.dana, 'Dana', TOKENS.dana, { groups: ['kids'], kid_ages: [2] });
  await person(IDS.pat, 'Pat', TOKENS.pat, { visibility: 'public', groups: ['odd'], kid_ages: [10] });
  await person(IDS.gone, 'Gone', TOKENS.gone, { removed_at: T0 });

  await repo.setTick(IDS.kevin, IDS.josh);
  await repo.setTick(IDS.josh, IDS.kevin);
  await repo.setTick(IDS.dana, IDS.kevin); // one-way

  await repo.insertAvailability({ id: 'A_JOSH', person_id: IDS.josh, kind: 'away', start_date: '2026-09-20', end_date: '2026-09-22', note: null });
  await repo.insertAvailability({ id: 'A_DANA', person_id: IDS.dana, kind: 'free', start_date: '2026-09-24', end_date: '2026-09-24', note: null });
  await repo.insertAvailability({ id: 'A_PAT', person_id: IDS.pat, kind: 'free', start_date: '2026-09-24', end_date: '2026-09-24', note: null });
  await repo.insertAvailability({ id: 'A_KEVIN', person_id: IDS.kevin, kind: 'free', start_date: '2026-09-24', end_date: '2026-09-24', note: null });

  await repo.insertPlace({ id: IDS.place, name: 'Alamo Drafthouse South Lamar', address: '1120 S Lamar Blvd, Austin, TX', lat: 30.256, lng: -97.763, neighborhood: null, groups: ['odd', 'foodie'], canonical_key: 'alamo drafthouse south lamar|1120 lamar', geocode_source: 'client', geocoded_at: T0, created_by: IDS.kevin, created_at: T0 });
  await repo.insertPlace({ id: IDS.place2, name: 'Thicket Food Park', address: '7800 S 1st St, Austin, TX', lat: 30.19, lng: -97.78, neighborhood: null, groups: ['foodie', 'kids'], canonical_key: 'thicket food park|7800 1st', geocode_source: 'client', geocoded_at: T0, created_by: IDS.josh, created_at: T0 });
  await repo.upsertVouch(IDS.place, IDS.josh, 'Best screen in town.');
  await repo.upsertVouch(IDS.place, IDS.dana, 'Good seats.');
  await repo.upsertVouch(IDS.place2, IDS.pat, 'Kids run around, adults eat.');
  await repo.upsertVouch(IDS.place2, IDS.gone, 'Was good.');
  await repo.insertReview({ id: 'RV_JOSH', place_id: IDS.place, person_id: IDS.josh, visited_on: '2026-09-01', verdict: 'loved', text: 'Terror Tuesday was great', created_at: T0, updated_at: T0 });
  await repo.insertReview({ id: 'RV_DANA', place_id: IDS.place, person_id: IDS.dana, visited_on: '2026-08-30', verdict: 'bounced', text: 'Too loud', created_at: T0, updated_at: T0 });
  await repo.insertReview({ id: 'RV_PAT', place_id: IDS.place2, person_id: IDS.pat, visited_on: null, verdict: 'fine', text: 'ok', created_at: T0, updated_at: T0 });

  repo._t.event.push({ id: IDS.event, place_id: IDS.place, title: 'Terror Tuesday: The Cat', starts_at: '2026-09-25T00:30:00.000Z' /* Sep 24 7:30pm Chicago */, ends_at: null, groups: JSON.stringify(['odd']), answers: JSON.stringify({ cost: { value: '$', confidence: 0.9, evidence: '$10' }, loud: { value: 'loud', confidence: 0.8, evidence: 'loud' }, parking: { value: 'unknown', confidence: 0, evidence: '' }, kid_ok: { value: 'no', confidence: 0.4, evidence: '' } }), score: 80, status: 'live', reject_reason: null, dedupe_key: 'PL1|2026-09-24|terror tuesday cat', first_seen: T0, last_seen: T0 });
  repo._t.event_source.push({ event_id: IDS.event, source: 'alamo', source_id: 'x1', source_url: 'https://drafthouse.com/x1', seen_at: T0 });
  await repo.upsertInterest(IDS.josh, 'event', IDS.event);
  await repo.upsertInterest(IDS.dana, 'event', IDS.event);
  await repo.upsertInterest(IDS.pat, 'event', IDS.event);

  await repo.insertPlan({ id: IDS.plan, room_id: IDS.room, owner_person_id: IDS.kevin, target_type: 'event', target_id: IDS.event, starts_at: '2026-09-25T00:30:00.000Z', status: 'open', created_at: T0, done_at: null },
    [{ person_id: IDS.kevin, state: 'in' }, { person_id: IDS.josh, state: 'maybe' }]);

  const app = createApp(repo, { APP_VERSION: 'test', BOOTSTRAP_SECRET: 'boot' }, { geocode: async () => ({ lat: 30.3, lng: -97.7 }) });
  return { repo, app };
}

export async function call(app, token, method, path, body, headers = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const req = new Request(`https://room.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await app.handle(req);
  const ct = res.headers.get('content-type') || '';
  const data = res.status === 204 ? null : ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

export const GATED_PERSON_KEYS = ['groups', 'kid_ages', 'availability'];
