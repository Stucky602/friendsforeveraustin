// ARCHITECTURE.md §4. One token per person, 128 bits, base32, 26 chars.
// Server stores sha256(token) only. Token arrives ONLY in the Authorization header.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC 4648 lowercase

export function bytesToBase32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase32(bytes); // 26 chars
}

export function isTokenShape(t) {
  return typeof t === 'string' && /^[a-z2-7]{26}$/.test(t);
}

export async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Extract the bearer token from a Request. Header only. Returns null if absent or malformed. */
export function bearerFrom(request) {
  const h = request.headers.get('authorization') || request.headers.get('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+([a-z2-7]{26})$/i.exec(h.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Resolve the viewer. Returns { person, room } or null.
 * repo must expose personByTokenHash(hash) and room(roomId).
 */
export async function resolveViewer(repo, request) {
  const token = bearerFrom(request);
  if (!token) return null;
  const person = await repo.personByTokenHash(await hashToken(token));
  if (!person || person.removed_at) return null;
  const room = await repo.room(person.room_id);
  if (!room) return null;
  return { person, room };
}

export function personalLink(origin, token) {
  return `${origin}/#/join/${token}`;
}
