// ARCHITECTURE.md §5.3, §5.6. Pure functions; the route calls these and persists the result.

export const MEMBER_STATES = Object.freeze(['maybe', 'in', 'out', 'went']);
export const PLAN_STATUSES = Object.freeze(['open', 'done', 'dropped']);
export const DONE_AFTER_MS = 6 * 60 * 60 * 1000; // starts_at + 6h

// Self-transitions while the plan is open.
const OPEN_ALLOWED = {
  maybe: new Set(['in', 'out']),
  in: new Set(['out']),
  out: new Set(['in']),
  went: new Set(), // cannot be 'went' while open
};

// Self-transitions after the plan is done: only the correction.
const DONE_ALLOWED = {
  maybe: new Set(),
  in: new Set(),
  out: new Set(),
  went: new Set(['out']),
};

/** May a member move themselves from -> to given the plan status? */
export function canSelfTransition(planStatus, from, to) {
  if (!MEMBER_STATES.includes(from) || !MEMBER_STATES.includes(to)) return false;
  if (planStatus === 'open') return OPEN_ALLOWED[from].has(to);
  if (planStatus === 'done') return DONE_ALLOWED[from].has(to);
  return false; // dropped: nothing moves
}

/** §5.6: on done, every `in` becomes `went`; maybe and out untouched. Returns the updated member list. */
export function completeMembers(members) {
  return members.map((m) => (m.state === 'in' ? { ...m, state: 'went' } : m));
}

/** Is a plan due to become done at instant `now`? */
export function isDue(plan, nowMs) {
  if (plan.status !== 'open') return false;
  const start = Date.parse(plan.starts_at);
  if (Number.isNaN(start)) return false;
  return nowMs >= start + DONE_AFTER_MS;
}

/** §5.5: should the re-ask pin this plan for this member at `now`? */
export function inReaskWindow(plan, memberState, nowMs) {
  if (plan.status !== 'open') return false;
  if (memberState !== 'maybe' && memberState !== 'in') return false;
  const start = Date.parse(plan.starts_at);
  if (Number.isNaN(start)) return false;
  const delta = start - nowMs;
  return delta > 0 && delta <= 48 * 60 * 60 * 1000;
}

/**
 * Validate a create request. Every member must be in the creator's mutual set.
 * Returns { ok: true } or { ok: false, error }.
 */
export function validateCreate({ target_type, target_id, starts_at, member_ids }, mutuals) {
  if (target_type !== 'event' && target_type !== 'place') return { ok: false, error: 'target_type' };
  if (typeof target_id !== 'string' || !target_id) return { ok: false, error: 'target_id' };
  if (starts_at !== undefined && Number.isNaN(Date.parse(starts_at))) return { ok: false, error: 'starts_at' };
  const ids = Array.isArray(member_ids) ? member_ids : [];
  for (const id of ids) if (!mutuals.has(id)) return { ok: false, error: 'member_not_mutual' };
  return { ok: true };
}

/** §5.8 the pasteable block. `answerLabels` already filtered to the view's first-surfaced keys. */
export function planText({ whenLabel, title, locationLine, members, answerLabels, link }) {
  const ins = members.filter((m) => m.state === 'in' || m.state === 'went').map((m) => m.display_name);
  const maybes = members.filter((m) => m.state === 'maybe').map((m) => m.display_name);
  const lines = [whenLabel, title];
  if (locationLine) lines.push(locationLine);
  const who = [];
  if (ins.length) who.push(`In: ${ins.join(', ')}.`);
  if (maybes.length) who.push(`Maybe: ${maybes.join(', ')}.`);
  if (who.length) lines.push(who.join(' '));
  if (answerLabels.length) lines.push(answerLabels.join(' · '));
  lines.push(link);
  return lines.join('\n');
}
