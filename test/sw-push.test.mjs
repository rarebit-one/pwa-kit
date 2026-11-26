// The generated worker's Web Push handlers, run in a vm sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serviceWorkerSource } from '../src/sw.mjs';
import { fakeCaches } from './helpers/fakes.mjs';

const ORIGIN = 'https://app.example.com';
const BUILD = '2026-01-01-abcdef12';

function runWorker({ push = { defaultTitle: 'Example', badge: 'icons/badge.png', resubscribeUrl: '/api/push/subscribe' }, windows = [] } = {}) {
  const handlers = {};
  const state = { shown: [], opened: [], focused: [], navigated: [], posted: [], subscribed: [] };
  const self = {
    registration: {
      scope: `${ORIGIN}/`,
      showNotification: async (title, opts) => { state.shown.push({ title, opts }); },
      pushManager: { subscribe: async (opts) => { state.subscribed.push(opts); return { endpoint: 'https://fcm.googleapis.com/new', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/new', keys: {} }) }; } },
    },
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (t, f) => { handlers[t] = f; },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows.map((url) => ({ url, focus: async () => { state.focused.push(url); }, navigate: async (u) => { state.navigated.push(u); } })),
      openWindow: async (u) => { state.opened.push(u); },
    },
  };
  const fetch = async (u, init) => { state.posted.push({ u, init }); return new Response('{}'); };
  vm.runInContext(serviceWorkerSource({ build: BUILD, cachePrefix: 'app-shell', push }), vm.createContext({ self, caches: fakeCaches(), fetch, URL, Response, AbortController, setTimeout, clearTimeout, JSON }));
  const fire = async (type, extra = {}) => {
    let p = null;
    if (!handlers[type]) return false;
    handlers[type]({ waitUntil: (x) => { p = x; }, ...extra });
    if (p) await p;
    return true;
  };
  return { handlers, state, fire };
}
const data = (v) => ({ json: () => (typeof v === 'string' ? JSON.parse(v) : v), text: () => (typeof v === 'string' ? v : JSON.stringify(v)) });

test('no push option: no push handlers', () => {
  const w = runWorker({ push: null });
  assert.equal(w.handlers.push, undefined);
  assert.equal(w.handlers.notificationclick, undefined);
});

test('push shows the message, tagged by id, with the link resolved against the scope', async () => {
  const w = runWorker();
  await w.fire('push', { data: data({ id: 'deploy:1', title: 'Deploy failed', body: 'prod', url: '/#today', requireInteraction: true }) });
  assert.equal(w.state.shown.length, 1);
  const { title, opts } = w.state.shown[0];
  assert.equal(title, 'Deploy failed');
  assert.equal(opts.body, 'prod');
  assert.equal(opts.tag, 'deploy:1');
  assert.equal(opts.renotify, true);
  assert.equal(opts.requireInteraction, true);
  assert.equal(opts.icon, 'icons/icon-192.png');
  assert.equal(opts.badge, 'icons/badge.png');
  assert.equal(opts.data.url, `${ORIGIN}/#today`);
});

test('push falls back to the default title and treats non-JSON as the body; bad links open the scope', async () => {
  const w = runWorker();
  await w.fire('push', { data: { json: () => { throw new SyntaxError('x'); }, text: () => 'plain words' } });
  await w.fire('push', { data: data({ body: 'x', url: 'javascript:alert(1)' }) });
  await w.fire('push', { data: null });
  assert.equal(w.state.shown[0].title, 'Example');
  assert.equal(w.state.shown[0].opts.body, 'plain words');
  assert.equal(w.state.shown[1].opts.data.url, `${ORIGIN}/`);
  assert.equal(w.state.shown[2].title, 'Example');
  assert.equal(w.state.shown[2].opts.tag, undefined);
});

test('notificationclick focuses an open window and navigates it to a same-origin link', async () => {
  const w = runWorker({ windows: [`${ORIGIN}/`] });
  let closed = false;
  await w.fire('notificationclick', { notification: { close: () => { closed = true; }, data: { url: `${ORIGIN}/#estate` } } });
  assert.ok(closed);
  assert.deepEqual(w.state.focused, [`${ORIGIN}/`]);
  assert.deepEqual(w.state.navigated, [`${ORIGIN}/#estate`]);
  assert.deepEqual(w.state.opened, []);
});

test('notificationclick opens a new window for an external link or when none is open', async () => {
  const w = runWorker({ windows: [`${ORIGIN}/`] });
  await w.fire('notificationclick', { notification: { close() {}, data: { url: 'https://github.com/example/repo/actions/runs/1' } } });
  assert.deepEqual(w.state.opened, ['https://github.com/example/repo/actions/runs/1']);
  const w2 = runWorker();
  await w2.fire('notificationclick', { notification: { close() {}, data: { url: `${ORIGIN}/` } } });
  assert.deepEqual(w2.state.opened, [`${ORIGIN}/`]);
});

test('pushsubscriptionchange re-subscribes with the old options and reports to the server', async () => {
  const w = runWorker();
  const options = { userVisibleOnly: true, applicationServerKey: new Uint8Array([4]) };
  await w.fire('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://fcm.googleapis.com/old', options } });
  assert.deepEqual(w.state.subscribed, [options]);
  assert.equal(w.state.posted.length, 1);
  assert.equal(w.state.posted[0].u, 'api/push/subscribe');
  assert.deepEqual(JSON.parse(w.state.posted[0].init.body), { subscription: { endpoint: 'https://fcm.googleapis.com/new', keys: {} }, replaces: 'https://fcm.googleapis.com/old' });
  const quiet = runWorker({ push: true });
  await quiet.fire('pushsubscriptionchange', { oldSubscription: { endpoint: 'x', options } });
  assert.equal(quiet.state.posted.length, 0);
});
