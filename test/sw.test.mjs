// The service worker is generated source; these tests run it in a vm sandbox with fake
// Cache Storage and fetch, and drive its install/activate/fetch/message handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serviceWorkerSource, killSwitchSource, goodResponse, isPageResponse } from '../src/sw.mjs';
import { fakeCaches, fakeResponse } from './helpers/fakes.mjs';

const ORIGIN = 'https://app.example.com';
const BUILD = '2026-01-01-abcdef12';
const SRC = serviceWorkerSource({ build: BUILD, cachePrefix: 'app-shell', apiPrefix: '/api/', extras: ['manifest.webmanifest', 'icons/icon-192.png'] });

function runWorker(src, { fetchImpl = async () => fakeResponse('', { status: 404 }), caches = fakeCaches() } = {}) {
  const handlers = {};
  const state = { unregistered: false, claimed: false, fetched: [] };
  const self = {
    registration: { scope: `${ORIGIN}/`, unregister: async () => { state.unregistered = true; return true; } },
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (t, f) => { handlers[t] = f; },
    skipWaiting: async () => {},
    clients: { claim: async () => { state.claimed = true; } },
  };
  const fetch = (u, init) => { state.fetched.push(typeof u === 'string' ? u : u.url); return fetchImpl(u, init); };
  vm.runInContext(src, vm.createContext({ self, caches, fetch, URL, Response, AbortController, setTimeout, clearTimeout }));
  const fire = async (type, extra = {}) => {
    let p = null, responded = null;
    const ev = { waitUntil: (x) => { p = x; }, respondWith: (x) => { responded = x; }, ...extra };
    handlers[type](ev);
    if (p) await p;
    return { responded: responded ? await responded : null, didRespond: responded !== null };
  };
  return { handlers, caches, state, fire };
}

const page = (build = BUILD, opts = {}) => fakeResponse(`<!doctype html><script>const BUILD = "${build}"</script>`, opts);
const siteFetch = (pageRes) => async (u) => {
  const p = typeof u === 'string' ? u : u.url;
  if (p.endsWith('index.html') || p === `${ORIGIN}/`) return typeof pageRes === 'function' ? pageRes() : pageRes;
  return fakeResponse('x', { headers: { 'content-type': 'image/png' } });
};

test('guards: only ok, same-origin basic, non-redirected responses are good; pages must be HTML', () => {
  assert.equal(goodResponse(fakeResponse('x')), true);
  assert.equal(goodResponse(fakeResponse('x', { redirected: true })), false);
  assert.equal(goodResponse(fakeResponse('x', { type: 'opaque' })), false);
  assert.equal(goodResponse(fakeResponse('x', { type: 'cors' })), false);
  assert.equal(goodResponse(fakeResponse('x', { status: 401 })), false);
  assert.equal(goodResponse(null), false);
  assert.equal(isPageResponse(fakeResponse('x')), true);
  assert.equal(isPageResponse(fakeResponse('{}', { headers: { 'content-type': 'application/json' } })), false);
});

test('install saves this build\'s page and extras', async () => {
  const w = runWorker(SRC, { fetchImpl: siteFetch(() => page()) });
  await w.fire('install');
  const names = await w.caches.keys();
  assert.deepEqual(names, [`app-shell-${BUILD}`]);
  const c = await w.caches.open(`app-shell-${BUILD}`);
  assert.ok(await c.match('index.html'));
  assert.ok(await c.match('icons/icon-192.png'));
});

for (const [why, res] of [
  ['a redirect (sign-in bounce)', () => page(BUILD, { redirected: true })],
  ['a non-basic response', () => page(BUILD, { type: 'opaque' })],
  ['a non-HTML response', () => page(BUILD, { headers: { 'content-type': 'application/json' } })],
  ['a page of another build', () => page('2025-12-31-00000000')],
  ['a login page (200 HTML without the build)', () => fakeResponse('<!doctype html><h1>Sign in</h1>')],
  ['an error status', () => page(BUILD, { status: 500 })],
]) {
  test(`install refuses ${why}`, async () => {
    const w = runWorker(SRC, { fetchImpl: siteFetch(res) });
    await assert.rejects(w.fire('install'), /refusing to install/);
    const c = await w.caches.open(`app-shell-${BUILD}`);
    assert.equal(await c.match('index.html'), undefined);
  });
}

test('activate deletes only older caches with this prefix', async () => {
  const caches = fakeCaches();
  for (const n of ['app-shell-old1', `app-shell-${BUILD}`, 'app-feeds-v1', 'other-shell-x']) await caches.open(n);
  const w = runWorker(SRC, { caches });
  await w.fire('activate');
  assert.deepEqual((await caches.keys()).sort(), ['app-feeds-v1', `app-shell-${BUILD}`, 'other-shell-x']);
  assert.equal(w.state.claimed, true);
});

test('fetch: shell navigations are cache-first; API, other pages, POSTs and other origins pass through', async () => {
  const w = runWorker(SRC, { fetchImpl: siteFetch(() => page()) });
  await w.fire('install');
  w.state.fetched.length = 0;
  const nav = (path, extra = {}) => w.fire('fetch', { request: { method: 'GET', url: `${ORIGIN}${path}`, mode: 'navigate', ...extra } });
  const hit = await nav('/');
  assert.ok(hit.didRespond);
  assert.match(await hit.responded.text(), new RegExp(BUILD));
  assert.equal(w.state.fetched.length, 0, 'served from cache without the network');
  assert.ok((await nav('/index.html')).didRespond);
  for (const p of ['/logout', '/login', '/api/auth/github']) assert.equal((await nav(p)).didRespond, false, p);
  assert.equal((await w.fire('fetch', { request: { method: 'GET', url: `${ORIGIN}/api/feed/today`, mode: 'cors' } })).didRespond, false);
  assert.equal((await w.fire('fetch', { request: { method: 'POST', url: `${ORIGIN}/`, mode: 'navigate' } })).didRespond, false);
  assert.equal((await w.fire('fetch', { request: { method: 'GET', url: 'https://other.example/x.png', mode: 'no-cors' } })).didRespond, false);
  const icon = await w.fire('fetch', { request: { method: 'GET', url: `${ORIGIN}/icons/icon-192.png`, mode: 'no-cors' } });
  assert.ok(icon.didRespond, 'extras come from the cache');
  assert.equal((await w.fire('fetch', { request: { method: 'GET', url: `${ORIGIN}/unknown.js`, mode: 'no-cors' } })).didRespond, false);
});

test('fetch: with nothing saved, a login page from the network is shown but never cached', async () => {
  const w = runWorker(SRC, { fetchImpl: async () => fakeResponse('<!doctype html><h1>Sign in</h1>') });
  const r = await w.fire('fetch', { request: { method: 'GET', url: `${ORIGIN}/`, mode: 'navigate' } });
  assert.match(await r.responded.text(), /Sign in/);
  assert.equal(await (await w.caches.open(`app-shell-${BUILD}`)).match('index.html'), undefined);
});

test('message "build" answers over the given port', async () => {
  const w = runWorker(SRC);
  const got = await new Promise((done) => w.handlers.message({ data: 'build', ports: [{ postMessage: done }] }));
  assert.equal(got, BUILD);
});

test('kill switch deletes every cache and unregisters itself', async () => {
  const caches = fakeCaches();
  for (const n of ['app-shell-x', 'app-feeds-v1', 'anything']) await caches.open(n);
  const w = runWorker(killSwitchSource(), { caches });
  await w.fire('install');
  await w.fire('activate');
  assert.deepEqual(await caches.keys(), []);
  assert.equal(w.state.unregistered, true);
  assert.equal(w.handlers.fetch, undefined, 'no fetch handler: everything goes to the network');
  const got = await new Promise((done) => w.handlers.message({ data: 'build', ports: [{ postMessage: done }] }));
  assert.equal(got, 'kill-switch');
});

test('generator validates its options', () => {
  assert.throws(() => serviceWorkerSource({ build: 'x' }));
  assert.throws(() => serviceWorkerSource({ build: 'x', cachePrefix: 'bad prefix' }));
});
