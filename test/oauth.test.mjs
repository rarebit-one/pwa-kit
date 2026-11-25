import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubOAuth, safeNext, publicOrigin } from '../src/oauth.mjs';
import { readCookie } from '../src/session.mjs';

const secret = 's'.repeat(32);
const baseEnv = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'csecret', PUBLIC_ORIGIN: 'https://app.example.com' };

// A fake GitHub: token exchange, /user, and org membership.
function gh({ token = 'tok', login = 'alice', membership = 'active', fail = '' } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(url);
    if (fail && url.includes(fail)) throw new Error('network down');
    if (url.endsWith('/login/oauth/access_token')) return new Response(JSON.stringify(token ? { access_token: token } : { error: 'bad_verification_code' }));
    if (url.endsWith('/user')) return login ? new Response(JSON.stringify({ login })) : new Response('{}', { status: 401 });
    if (url.includes('/user/memberships/orgs/')) return membership ? new Response(JSON.stringify({ state: membership })) : new Response('{}', { status: 404 });
    return new Response('{}', { status: 404 });
  };
  return { fetch, calls };
}

async function roundTrip(env, ghOpts, { next } = {}) {
  const g = gh(ghOpts);
  const oauth = createGithubOAuth({ secret, env, fetch: g.fetch, stateCookie: 'st' });
  const s = oauth.start({ headers: {}, query: next ? { next } : {} });
  const url = new URL(s.redirect);
  const state = url.searchParams.get('state');
  const cookieVal = s.setCookie.split(';')[0];
  const res = await oauth.callback({ headers: { cookie: cookieVal }, query: { code: 'c', state } });
  return { s, url, res, calls: g.calls };
}

test('not configured: start and callback refuse', async () => {
  const oauth = createGithubOAuth({ secret, env: {} });
  assert.ok(oauth.start({ headers: {}, query: {} }).error);
  assert.equal((await oauth.callback({ headers: {}, query: {} })).ok, false);
  assert.equal(createGithubOAuth({ secret, env: { GITHUB_OAUTH_CLIENT_ID: '-', GITHUB_OAUTH_CLIENT_SECRET: '-' } }).configured(), false, '"-" sentinel reads as unset');
});

test('start: authorize URL with redirect_uri, read:org scope for an org, signed state cookie', () => {
  const oauth = createGithubOAuth({ secret, env: { ...baseEnv, GITHUB_ALLOWED_ORG: 'acme' }, stateCookie: 'st' });
  const s = oauth.start({ headers: {}, query: {} });
  const url = new URL(s.redirect);
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.com/api/auth/callback');
  assert.equal(url.searchParams.get('scope'), 'read:org');
  assert.equal(url.searchParams.get('allow_signup'), 'false');
  assert.match(s.setCookie, /^st=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  assert.equal(new URL(createGithubOAuth({ secret, env: baseEnv }).start({ headers: {}, query: {} }).redirect).searchParams.get('scope'), 'read:user');
});

test('allowlisted user is granted without an org check', async () => {
  const { res, calls } = await roundTrip({ ...baseEnv, GITHUB_ALLOWED_USERS: 'Bob, alice' }, {});
  assert.deepEqual(res, { ok: true, login: 'alice', next: '' });
  assert.ok(!calls.some((u) => u.includes('memberships')));
});

test('active org member is granted; inactive, missing or erroring membership is refused', async () => {
  const env = { ...baseEnv, GITHUB_ALLOWED_ORG: 'acme' };
  assert.equal((await roundTrip(env, { membership: 'active' })).res.ok, true);
  assert.equal((await roundTrip(env, { membership: 'pending' })).res.ok, false);
  assert.equal((await roundTrip(env, { membership: null })).res.ok, false);
  assert.equal((await roundTrip(env, { fail: 'memberships' })).res.ok, false);
});

test('no org and not allowlisted → refused (fail closed)', async () => {
  const { res } = await roundTrip(baseEnv, {});
  assert.equal(res.ok, false);
  assert.match(res.error, /isn't authorised/);
});

test('token exchange or identity failures are refusals', async () => {
  const env = { ...baseEnv, GITHUB_ALLOWED_USERS: 'alice' };
  assert.equal((await roundTrip(env, { token: null })).res.ok, false);
  assert.equal((await roundTrip(env, { login: null })).res.ok, false);
  assert.equal((await roundTrip(env, { fail: 'access_token' })).res.ok, false);
});

test('state must match the cookie and be validly signed and fresh', async () => {
  const g = gh();
  let t = 1000;
  const oauth = createGithubOAuth({ secret, env: { ...baseEnv, GITHUB_ALLOWED_USERS: 'alice' }, fetch: g.fetch, stateCookie: 'st', now: () => t });
  const s = oauth.start({ headers: {}, query: {} });
  const state = new URL(s.redirect).searchParams.get('state');
  const cookie = s.setCookie.split(';')[0];
  assert.equal((await oauth.callback({ headers: { cookie }, query: { code: 'c', state: state + 'x' } })).ok, false);
  assert.equal((await oauth.callback({ headers: {}, query: { code: 'c', state } })).ok, false);
  const other = createGithubOAuth({ secret: 'different', env: baseEnv, stateCookie: 'st' }).start({ headers: {}, query: {} });
  const otherState = new URL(other.redirect).searchParams.get('state');
  assert.equal((await oauth.callback({ headers: { cookie: `st=${otherState}` }, query: { code: 'c', state: otherState } })).ok, false, 'foreign signature');
  t += 11 * 60 * 1000;
  assert.equal((await oauth.callback({ headers: { cookie }, query: { code: 'c', state } })).ok, false, 'expired');
});

test('next: kept when safe, dropped when not', async () => {
  const env = { ...baseEnv, GITHUB_ALLOWED_USERS: 'alice' };
  assert.equal((await roundTrip(env, {}, { next: '/books' })).res.next, '/books');
  for (const bad of ['//evil.example', 'https://evil.example', '/a/../b', '/x?y=1', 'relative']) {
    assert.equal((await roundTrip(env, {}, { next: bad })).res.next, '', bad);
  }
  assert.equal(safeNext('/ok', /^\/ok$/), '/ok');
  assert.equal(safeNext('/no', /^\/ok$/), '');
});

test('publicOrigin prefers the pin, then forwarded headers, then Host', () => {
  assert.equal(publicOrigin({ headers: {} }, { PUBLIC_ORIGIN: 'https://a.example/' }), 'https://a.example');
  assert.equal(publicOrigin({ headers: { 'x-forwarded-host': 'b.example', 'x-forwarded-proto': 'https', host: 'internal' } }, {}), 'https://b.example');
  assert.equal(publicOrigin({ headers: { host: 'c.example' } }, { PUBLIC_ORIGIN: '-' }), 'https://c.example');
});

test('the state cookie carries next alongside the signed state', () => {
  const oauth = createGithubOAuth({ secret, env: baseEnv, stateCookie: 'st' });
  const s = oauth.start({ headers: {}, query: { next: '/books' } });
  const v = readCookie(s.setCookie.split(';')[0], 'st');
  assert.equal(Buffer.from(v.split('~')[1], 'base64url').toString(), '/books');
});
