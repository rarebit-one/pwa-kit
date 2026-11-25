import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedCache, logoutAndWipe, registerServiceWorker, askWorkerBuild, showUpdateBanner } from '../src/client.mjs';
import { fakeCaches, memoryStorage } from './helpers/fakes.mjs';

const DAY = 24 * 3600 * 1000;
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function harness(first) {
  let t = 1_000 * DAY;
  let next = first;
  const caches = fakeCaches();
  const feeds = createFeedCache({ cacheName: 'feeds', timeoutMs: 30, cachesImpl: caches, now: () => t, fetchImpl: (u, init) => next(u, init) });
  return { feeds, caches, set: (fn) => { next = fn; }, advance: (ms) => { t += ms; }, now: () => t };
}

test('network-first: fresh data is returned and saved', async () => {
  const h = harness(async () => jsonRes({ v: 1 }));
  const r = await h.feeds.get('/api/feed/today');
  assert.deepEqual(r, { data: { v: 1 }, fetchedAt: h.now(), stale: false, status: 200 });
  assert.deepEqual((await h.feeds.saved('/api/feed/today')).data, { v: 1 });
  assert.equal(await h.feeds.lastSync(), h.now());
});

test('offline or timed out: the saved copy, flagged stale, with when it was fetched', async () => {
  const h = harness(async () => jsonRes({ v: 1 }));
  await h.feeds.get('/f');
  const at = h.now();
  h.advance(3600e3);
  h.set(async () => { throw new TypeError('Failed to fetch'); });
  const off = await h.feeds.get('/f');
  assert.deepEqual([off.data, off.fetchedAt, off.stale, off.offline], [{ v: 1 }, at, true, true]);
  h.set((u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  const slow = await h.feeds.get('/f');
  assert.equal(slow.stale, true);
  assert.equal(slow.error, 'timed out');
  assert.deepEqual(slow.data, { v: 1 });
});

test('signed out (401): the saved copy with signedOut, and the sync clock is not reset', async () => {
  const h = harness(async () => jsonRes({ v: 1 }));
  await h.feeds.get('/f');
  const synced = await h.feeds.lastSync();
  h.advance(DAY);
  h.set(async () => jsonRes({ error: 'unauthorized' }, 401));
  const r = await h.feeds.get('/f');
  assert.equal(r.signedOut, true);
  assert.equal(r.stale, true);
  assert.deepEqual(r.data, { v: 1 });
  assert.equal(await h.feeds.lastSync(), synced);
});

test('unpublished feed (404, or 503 JSON): missing, and the saved copy is dropped', async () => {
  for (const status of [404, 503]) {
    const h = harness(async () => jsonRes({ v: 1 }));
    await h.feeds.get('/f');
    h.set(async () => jsonRes({ error: 'not published' }, status));
    const r = await h.feeds.get('/f');
    assert.equal(r.missing, true, String(status));
    assert.equal(r.data, null);
    assert.equal((await h.feeds.saved('/f')).data, null);
  }
});

test('a non-JSON server error falls back to the saved copy', async () => {
  const h = harness(async () => jsonRes({ v: 1 }));
  await h.feeds.get('/f');
  h.set(async () => new Response('<html>platform error</html>', { status: 503, headers: { 'content-type': 'text/html' } }));
  const r = await h.feeds.get('/f');
  assert.equal(r.stale, true);
  assert.deepEqual(r.data, { v: 1 });
  assert.equal(r.missing, undefined);
});

test('self-wipe: saved feeds are deleted after 14 days without a signed-in sync', async () => {
  const h = harness(async () => jsonRes({ v: 1 }));
  await h.feeds.get('/f');
  h.set(async () => { throw new TypeError('offline'); });
  h.advance(13 * DAY);
  assert.deepEqual((await h.feeds.get('/f')).data, { v: 1 }, 'within the window: still there');
  h.advance(2 * DAY);
  const r = await h.feeds.get('/f');
  assert.equal(r.data, null);
  assert.deepEqual(await h.caches.keys(), []);
  // Signed out for 15 days counts the same: 401s never reset the clock.
  const h2 = harness(async () => jsonRes({ v: 1 }));
  await h2.feeds.get('/f');
  h2.set(async () => jsonRes({}, 401));
  h2.advance(15 * DAY);
  assert.equal((await h2.feeds.get('/f')).data, null);
});

test('self-wipe: saved feeds without a recorded sync are wiped (fail safe)', async () => {
  const h = harness(async () => { throw new TypeError('offline'); });
  const c = await h.caches.open('feeds');
  await c.put('/f', jsonRes({ fetchedAt: 1, data: { v: 'orphan' } }));
  assert.equal(await h.feeds.wipeIfExpired(), true);
  assert.equal((await h.feeds.get('/f')).data, null);
});

test('logoutAndWipe clears caches, IndexedDB, storage and workers, then navigates', async () => {
  const caches = fakeCaches();
  await caches.open('a'); await caches.open('b');
  const deleted = [];
  const idb = {
    databases: async () => [{ name: 'one' }, { name: 'two' }],
    deleteDatabase: (n) => { deleted.push(n); const r = {}; setTimeout(() => r.onsuccess?.()); return r; },
  };
  const ls = memoryStorage(); ls.setItem('k', 'v');
  const ss = memoryStorage(); ss.setItem('k', 'v');
  let unregistered = 0, went = null;
  const sw = { getRegistrations: async () => [{ unregister: async () => { unregistered++; } }] };
  await logoutAndWipe('/logout', { cachesImpl: caches, idb, storages: [ls, ss], sw, dbNames: ['extra'], navigate: (u) => { went = u; } });
  assert.deepEqual(await caches.keys(), []);
  assert.deepEqual(deleted.sort(), ['extra', 'one', 'two']);
  assert.equal(ls.m.size + ss.m.size, 0);
  assert.equal(unregistered, 1);
  assert.equal(went, '/logout');
});

test('logoutAndWipe still navigates when every wipe step fails', async () => {
  let went = null;
  const boom = () => { throw new Error('nope'); };
  await logoutAndWipe('/bye', { cachesImpl: { keys: boom }, idb: { databases: boom }, storages: [{ clear: boom }], sw: { getRegistrations: boom }, navigate: (u) => { went = u; } });
  assert.equal(went, '/bye');
});

function fakeSw({ controllerBuild } = {}) {
  const listeners = {};
  const reg = { updates: 0, update: async () => { reg.updates++; } };
  const worker = (b) => ({ postMessage: (msg, [port]) => { if (msg === 'build') port.postMessage(b); } });
  const sw = {
    controller: controllerBuild ? worker(controllerBuild) : null,
    addEventListener: (t, f) => { listeners[t] = f; },
    register: async () => reg,
    takeOver: async (b) => { sw.controller = worker(b); await listeners.controllerchange(); },
  };
  return { sw, reg };
}
const events = () => { const l = {}; return { l, addEventListener: (t, f) => { l[t] = f; }, hidden: false }; };

test('registerServiceWorker: a different build taking over an existing page is an update', async () => {
  const { sw } = fakeSw({ controllerBuild: 'old' });
  let updated = null, ready = 0;
  registerServiceWorker({ build: 'new', sw, win: events(), doc: events(), nav: { onLine: true }, onUpdate: (b) => { updated = b; }, onReady: () => { ready++; } });
  await sw.takeOver('newer');
  assert.equal(updated, 'newer');
  assert.equal(ready, 0);
});

test('registerServiceWorker: the first install of this build is "ready", not an update', async () => {
  const { sw } = fakeSw();
  let updated = 0, ready = 0;
  registerServiceWorker({ build: 'b1', sw, win: events(), doc: events(), nav: { onLine: true }, onUpdate: () => { updated++; }, onReady: () => { ready++; } });
  await sw.takeOver('b1');
  assert.deepEqual([updated, ready], [0, 1]);
});

test('registerServiceWorker: update checks on foreground/online are throttled to 10 minutes and skipped offline', async () => {
  const { sw, reg } = fakeSw();
  let t = 0;
  const win = events(), doc = events(), nav = { onLine: true };
  const ctl = registerServiceWorker({ build: 'b', sw, win, doc, nav, now: () => t });
  await new Promise((r) => setImmediate(r));
  assert.ok(ctl.registration());
  t = 60e3; doc.l.visibilitychange();
  assert.equal(reg.updates, 0, 'too soon after registering');
  t = 11 * 60e3; doc.l.visibilitychange();
  assert.equal(reg.updates, 1);
  t = 12 * 60e3; win.l.online();
  assert.equal(reg.updates, 1, 'throttled');
  t = 30 * 60e3; nav.onLine = false; win.l.online();
  assert.equal(reg.updates, 1, 'offline');
  nav.onLine = true;
  assert.equal(ctl.check(true), true);
  assert.equal(reg.updates, 2, 'force bypasses the throttle');
});

test('askWorkerBuild times out to null for a silent worker', async () => {
  assert.equal(await askWorkerBuild({ postMessage() {} }, { timeoutMs: 10 }), null);
  assert.equal(await askWorkerBuild(null), null);
});

test('showUpdateBanner reveals the button and reloads on tap', () => {
  let reloaded = 0;
  const b = { hidden: true };
  showUpdateBanner({ doc: { getElementById: () => b }, reload: () => { reloaded++; } });
  assert.equal(b.hidden, false);
  b.onclick();
  assert.equal(reloaded, 1);
});
