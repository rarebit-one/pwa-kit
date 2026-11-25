// GitHub OAuth (authorization-code flow) for a single-function app, with no server-side state.
//
//   start(req)    → { redirect, setCookie }   a signed, short-lived state cookie + the GitHub URL
//   callback(req) → { ok: true, login, next } or { ok: false, error }
//
// Access is granted when the GitHub login is on an allowlist OR is an ACTIVE member of the
// allowed org. Everything fails CLOSED: a missing config, a GitHub error, a network error or
// an unexpected answer is a refusal, never a grant. The caller mints its own session.
//
// Config comes from env (read at call time, so tests and rotations need no restart). "-" is
// read as unset, because some deploy tools refuse an empty substitution value.

import crypto from 'node:crypto';
import { signClaims, verifySigned, readCookie, cookie } from './session.mjs';

const GH = 'https://github.com';
const GH_API = 'https://api.github.com';
const b64u = (s) => Buffer.from(s).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');

export const envValue = (env, name) => { const v = env[name]; return v && v !== '-' ? String(v) : ''; };

// A safe post-login path: same-origin, absolute path, conservative characters, no traversal,
// never protocol-relative ("//host").
export const DEFAULT_NEXT = /^\/(?!\/)[A-Za-z0-9._~\/-]*$/;
export const safeNext = (p, re = DEFAULT_NEXT) =>
  (typeof p === 'string' && p.length <= 200 && re.test(p) && !p.split('/').includes('..') ? p : '');

/**
 * The public origin GitHub must redirect back to. Prefers an explicit PUBLIC_ORIGIN pin, then
 * proxy forwarding headers, then the raw Host.
 */
export function publicOrigin(req, env = process.env) {
  const pinned = envValue(env, 'PUBLIC_ORIGIN');
  if (pinned) return pinned.replace(/\/+$/, '');
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h['X-Forwarded-Host'] || h.host || h.Host || '').split(',')[0].trim();
  const proto = String(h['x-forwarded-proto'] || h['X-Forwarded-Proto'] || 'https').split(',')[0].trim() || 'https';
  return `${proto}://${host}`;
}

export function createGithubOAuth({
  secret,                        // string or () => string (signs the state cookie)
  env = process.env,
  fetch: fetchImpl = (...a) => globalThis.fetch(...a),
  basePath = '',                 // the path the app is mounted at ('' = origin root)
  callbackPath = '/api/auth/callback',
  stateCookie = 'oauth_state',
  cookiePath = '/',
  nextPattern = DEFAULT_NEXT,
  userAgent = 'pwa-kit',
  stateTtlMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const cfg = (n) => envValue(env, n);
  const configured = () => !!(cfg('GITHUB_OAUTH_CLIENT_ID') && cfg('GITHUB_OAUTH_CLIENT_SECRET'));
  const allowedOrg = () => cfg('GITHUB_ALLOWED_ORG').trim();
  const allowedUsers = () => cfg('GITHUB_ALLOWED_USERS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const redirectUri = (req) => `${publicOrigin(req, env)}${basePath}${callbackPath}`;
  const ghHeaders = (token) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': userAgent, 'x-github-api-version': '2022-11-28' });

  function start(req) {
    if (!configured()) return { error: 'GitHub sign-in is not configured.' };
    const state = signClaims({ n: crypto.randomBytes(9).toString('base64url'), e: now() + stateTtlMs }, secret);
    const next = safeNext(req.query && req.query.next, nextPattern);
    const value = next ? `${state}~${b64u(next)}` : state;
    const scope = allowedOrg() ? 'read:org' : 'read:user';
    const url = `${GH}/login/oauth/authorize?client_id=${encodeURIComponent(cfg('GITHUB_OAUTH_CLIENT_ID'))}`
      + `&redirect_uri=${encodeURIComponent(redirectUri(req))}`
      + `&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}&allow_signup=false`;
    return { redirect: url, setCookie: cookie(stateCookie, value, { path: cookiePath, maxAge: stateTtlMs / 1000 }) };
  }

  function stateValid(state) {
    const c = verifySigned(state, secret);
    return !!(c && c.n && c.e > now());
  }

  async function callback(req) {
    if (!configured()) return { ok: false, error: 'GitHub sign-in is not configured.' };
    const { code, state } = req.query || {};
    const [cookieState, nextB64] = String(readCookie(req.headers?.cookie || req.headers?.Cookie, stateCookie) || '').split('~');
    if (!code || !state || state !== cookieState || !stateValid(state)) {
      return { ok: false, error: 'Sign-in link expired or invalid. Please try again.' };
    }
    let next = '';
    try { next = nextB64 ? safeNext(unb64u(nextB64), nextPattern) : ''; } catch { next = ''; }

    let token = null;
    try {
      const r = await fetchImpl(`${GH}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': userAgent },
        body: JSON.stringify({ client_id: cfg('GITHUB_OAUTH_CLIENT_ID'), client_secret: cfg('GITHUB_OAUTH_CLIENT_SECRET'), code, redirect_uri: redirectUri(req) }),
      });
      token = (await r.json()).access_token || null;
    } catch { token = null; }
    if (!token) return { ok: false, error: 'Could not complete GitHub sign-in.' };

    let login = null;
    try {
      const r = await fetchImpl(`${GH_API}/user`, { headers: ghHeaders(token) });
      login = r.ok ? (await r.json()).login || null : null;
    } catch { login = null; }
    if (!login || typeof login !== 'string') return { ok: false, error: 'Could not read your GitHub identity.' };

    if (!(await authorize(login, token))) return { ok: false, login, error: `@${login} isn't authorised for this app.` };
    return { ok: true, login, next };
  }

  // Allowlist first; then active org membership. Any failure is a refusal.
  async function authorize(login, token) {
    if (allowedUsers().includes(String(login).toLowerCase())) return true;
    const org = allowedOrg();
    if (!org) return false;
    try {
      const r = await fetchImpl(`${GH_API}/user/memberships/orgs/${encodeURIComponent(org)}`, { headers: ghHeaders(token) });
      if (!r.ok) return false;
      return (await r.json()).state === 'active';
    } catch { return false; }
  }

  return { configured, start, callback, authorize, redirectUri };
}
