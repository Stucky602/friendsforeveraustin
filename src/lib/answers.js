// CONTRACTS.md §2. Validate before write; an invalid response leaves the event unclassified.

export const GROUPS = Object.freeze(['foodie', 'kids', 'odd']);
export const REJECT_REASONS_FROM_MODEL = Object.freeze(['mute', 'no_group']);

export const ANSWER_ENUMS = Object.freeze({
  cost: ['free', '$', '$$', '$$$', 'unknown'],
  parking: ['lot', 'street', 'garage', 'hard', 'unknown'],
  loud: ['quiet', 'normal', 'loud', 'unknown'],
  kid_ok: ['yes', 'no', 'older', 'unknown'],
});

/**
 * Validate a parsed model response against the input text it was given.
 * Returns { ok: true, value } or { ok: false, error }.
 */
export function validateAnswers(resp, inputText) {
  if (!resp || typeof resp !== 'object') return bad('not_object');
  const { groups, reject, answers } = resp;

  if (!Array.isArray(groups)) return bad('groups_not_array');
  for (const g of groups) if (!GROUPS.includes(g)) return bad(`bad_group:${g}`);
  if (new Set(groups).size !== groups.length) return bad('duplicate_group');

  if (reject !== null && reject !== undefined) {
    if (typeof reject !== 'object' || !REJECT_REASONS_FROM_MODEL.includes(reject.reason)) return bad('bad_reject');
  }
  if (groups.length === 0 && !reject) return bad('empty_groups_without_reject');

  if (!answers || typeof answers !== 'object') return bad('answers_not_object');
  const text = String(inputText || '');
  const out = {};
  for (const key of Object.keys(ANSWER_ENUMS)) {
    const a = answers[key];
    if (!a || typeof a !== 'object') return bad(`missing:${key}`);
    if (!ANSWER_ENUMS[key].includes(a.value)) return bad(`bad_value:${key}`);
    const conf = Number(a.confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return bad(`bad_confidence:${key}`);
    const ev = a.evidence == null ? '' : String(a.evidence);
    if (ev !== '' && !text.includes(ev)) return bad(`evidence_not_verbatim:${key}`);
    if (a.value === 'unknown' && (ev !== '' || conf > 0.2)) return bad(`unknown_with_evidence:${key}`);
    out[key] = { value: a.value, confidence: conf, evidence: ev };
  }
  const extra = Object.keys(answers).filter((k) => !(k in ANSWER_ENUMS));
  if (extra.length) return bad(`extra_answer:${extra[0]}`);

  return { ok: true, value: { groups: [...groups], reject: reject ? { reason: reject.reason } : null, answers: out } };
}

function bad(error) {
  return { ok: false, error };
}

// CONTRACTS.md §7: short labels, unknown never rendered.
const LABELS = {
  cost: { free: 'free', $: '$', $$: '$$', $$$: '$$$' },
  parking: { lot: 'lot parking', street: 'street parking', garage: 'garage parking', hard: 'parking is hard' },
  loud: { quiet: 'quiet', normal: 'normal volume', loud: 'loud' },
  kid_ok: { yes: 'kids ok', no: 'no kids', older: 'older kids' },
};

export const VIEW_FIRST_ANSWERS = Object.freeze({
  foodie: ['cost'],
  kids: ['kid_ok', 'cost'],
  odd: ['cost', 'loud'],
});

/** Labels for the block: only the view's keys, only confidence >= 0.6, never unknown. */
export function answerLabels(answers, view, minConfidence = 0.6) {
  const keys = VIEW_FIRST_ANSWERS[view] || [];
  const out = [];
  for (const k of keys) {
    const a = answers?.[k];
    if (!a || a.value === 'unknown' || Number(a.confidence) < minConfidence) continue;
    const label = LABELS[k]?.[a.value];
    if (label) out.push(label);
  }
  return out;
}
