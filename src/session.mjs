// Stateless signed session tokens and cookie helpers.
//
// A token is base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, payload)).
// Claims:
//   u  user (login)                       e  expiry, epoch milliseconds
//   s  scope (optional): a token with a scope only opens what asks for that exact scope;
//      a plain-session check rejects every scoped token, so a long-lived scoped token can
//      never stand in for the main session even if replayed under the session cookie's name.
//   g  generation (optional, default 0): compared with the current epoch so that bumping the
//      epoch revokes every outstanding token at once without rotating the secret.
//
// Nothing is stored server-side. Verification is constant-time over the signature.

import crypto from 'node:crypto';

const b64u = (s) => Buffer.from(s).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');
const secretOf = (secret) => (typeof secret === 'function' ? secret() : secret);

export function hmac(payload, secret) {
  const key = secretOf(secret);
  if (!key) throw new Error('session secret is not set');
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Sign an arbitrary claims object. */
export function signClaims(claims, secret) {
  const payload = b64u(JSON.stringify(claims));
  return `${payload}.${hmac(payload, secret)}`;
}

/** Verify a signed value → its claims (any shape), or null. Does not check expiry. */
export function verifySigned(token, secret) {
  if (!secretOf(secret)) return null;
  const [payload, sig, extra] = String(token || '').split('.');
  if (!payload || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, hmac(payload, secret))) return null;
  try { return JSON.parse(unb64u(payload)); } catch { return null; }
}

/** Mint a session token for `user`. */
export function makeToken(user, { secret, ttlMs, scope, epoch, expiresAt, now = Date.now() } = {}) {
  if (!user) throw new Error('makeToken needs a user');
  const claims = { u: String(user), e: expiresAt ?? now + ttlMs };
  if (!Number.isFinite(claims.e)) throw new Error('makeToken needs ttlMs or expiresAt');
  if (scope) claims.s = String(scope);
  if (epoch) claims.g = epoch;
  return signClaims(claims, secret);
}

/**
 * Verify a token → its claims, or null when forged, expired, of the wrong scope, or from an
 * older epoch. `scope: null` (the default) accepts ONLY unscoped tokens.
 */
export function verifyToken(token, { secret, scope = null, epoch, now = Date.now() } = {}) {
  const c = verifySigned(token, secret);
  if (!c || typeof c !== 'object' || !c.u || !(c.e > now)) return null;
  if (scope == null ? c.s != null : c.s !== scope) return null;
  if (epoch != null && (c.g ?? 0) !== epoch) return null;
  return c;
}

// --- cookies ------------------------------------------------------------------

/** The value of cookie `name` in a Cookie header, or null. */
export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Read and verify the token in cookie `name`. Same options as verifyToken. */
export const readSessionCookie = (header, name, opts) => {
  const v = readCookie(header, name);
  return v ? verifyToken(v, opts) : null;
};

/** A Set-Cookie value. HttpOnly, Secure and SameSite=Lax unless overridden. */
export function cookie(name, value, { path = '/', maxAge, sameSite = 'Lax', httpOnly = true, secure = true } = {}) {
  let s = `${name}=${value}; Path=${path}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (sameSite) s += `; SameSite=${sameSite}`;
  if (maxAge != null) s += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  return s;
}

export const clearCookie = (name, path = '/') => cookie(name, '', { path, maxAge: 0 });

/**
 * Headers that sign a device out: every named cookie cleared, plus Clear-Site-Data so the
 * browser drops its caches and storage for the origin. (Support for the header is uneven,
 * so the page should also wipe what it can before navigating to logout.)
 *
 * `set-cookie` is an array: OpenWhisk-style web actions send one header line per element.
 */
export function logoutHeaders(cookieNames, path = '/') {
  return {
    'set-cookie': [].concat(cookieNames).map((n) => clearCookie(n, path)),
    'clear-site-data': '"cache", "storage", "cookies"',
    'cache-control': 'no-store',
  };
}
