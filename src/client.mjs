// Browser-side helpers, inlined into the page by build.mjs (so: no imports, and every
// top-level name is exported and distinctive). Every browser global is injectable so the
// logic can be tested in Node.
//
//   registerServiceWorker({ build, onUpdate })  register sw.js; check for updates on foreground
//                                               or reconnect (at most every 10 minutes)
//   showUpdateBanner()                          reveal the build's "Updated. Tap to reload." button
//   createFeedCache({ ... })                    network-first JSON feeds with an offline copy and
//                                               a self-wipe after N days without a signed-in sync
//   logoutAndWipe(url)                          delete caches, IndexedDB and web storage, then go
//   pushStatus() / subscribePush() / unsubscribePush()
//                                               Web Push: permission, subscribe, unsubscribe

export const PWA_KIT_UPDATE_THROTTLE_MS = 10 * 60 * 1000;

/** Ask the controlling worker which build it serves (null when it can't say). */
export function askWorkerBuild(worker, { timeoutMs = 2000 } = {}) {
  return new Promise((done) => {
    if (!worker) return done(null);
    const ch = new MessageChannel();
    const finish = (v) => { clearTimeout(t); ch.port1.close(); done(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    ch.port1.onmessage = (e) => finish(e.data);
    try { worker.postMessage('build', [ch.port2]); } catch { finish(null); }
  });
}

/**
 * Register the service worker. `onUpdate()` fires when a worker of a DIFFERENT build takes
 * over a page that already had one (a real update, not the first install); `onReady()` fires
 * on the first install. Returns { check(force), registration() }.
 */
export function registerServiceWorker({
  build,
  url = 'sw.js',
  onUpdate = () => showUpdateBanner(),
  onReady = () => {},
  throttleMs = PWA_KIT_UPDATE_THROTTLE_MS,
  sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
  win = typeof window !== 'undefined' ? window : undefined,
  doc = typeof document !== 'undefined' ? document : undefined,
  nav = typeof navigator !== 'undefined' ? navigator : undefined,
  now = () => Date.now(),
} = {}) {
  let reg = null;
  let last = 0;
  const api = {
    registration: () => reg,
    check(force = false) {
      if (!reg || (nav && nav.onLine === false)) return false;
      if (!force && now() - last < throttleMs) return false;
      last = now();
      Promise.resolve(reg.update()).catch(() => { /* offline or signed out: the saved copy keeps working */ });
      return true;
    },
  };
  if (!sw) return api;
  const had = !!sw.controller;
  sw.addEventListener('controllerchange', async () => {
    const theirs = await askWorkerBuild(sw.controller);
    if (theirs !== build) { if (had) onUpdate(theirs); } else if (!had) onReady();
  });
  Promise.resolve(sw.register(url)).then((r) => { reg = r; last = now(); }).catch(() => { /* not available here */ });
  if (doc) doc.addEventListener('visibilitychange', () => { if (!doc.hidden) api.check(); });
  if (win) win.addEventListener('online', () => api.check());
  return api;
}

/** Reveal the "Updated. Tap to reload." button the build put in the page. */
export function showUpdateBanner({ id = 'pwa-update', doc = document, reload = () => location.reload() } = {}) {
  const b = doc.getElementById(id);
  if (!b) return;
  b.hidden = false;
  b.onclick = () => reload();
}

/**
 * Network-first JSON feeds with an offline copy in Cache Storage.
 *
 * get(url) → { data, fetchedAt, stale, status, signedOut?, missing?, offline? }
 *   - 2xx JSON:      fresh data, saved; the "last signed-in sync" clock is reset.
 *   - 401/403:       signedOut; the saved copy (if any, and not expired) with stale: true.
 *   - 404, or 503 with a JSON body: the feed isn't published; the saved copy is dropped.
 *   - timeout, network error, other statuses: the saved copy with stale: true.
 *
 * Self-wipe: when the last successful signed-in fetch is older than `wipeAfterDays`, every
 * saved feed is deleted before anything is read. Saved feeds with no recorded sync are wiped
 * too (fail safe).
 */
export function createFeedCache({
  cacheName = 'pwa-feeds-v1',
  timeoutMs = 3000,
  wipeAfterDays = 14,
  fetchImpl = (...a) => fetch(...a),
  cachesImpl = typeof caches !== 'undefined' ? caches : undefined,
  now = () => Date.now(),
} = {}) {
  const META = '/__pwa-kit/feed-meta';
  const maxAge = wipeAfterDays * 24 * 3600 * 1000;
  const open = () => (cachesImpl ? cachesImpl.open(cacheName) : Promise.resolve(null));
  const asJson = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
  // Reads go through caches.match({ cacheName }) so they never create an empty cache.
  const readJson = async (key) => {
    try { const r = cachesImpl && (await cachesImpl.match(key, { cacheName })); return r ? await r.json() : null; } catch { return null; }
  };

  async function lastSync() { return (await readJson(META))?.lastAuthOk ?? null; }

  async function wipe() { if (cachesImpl) await cachesImpl.delete(cacheName); }

  async function wipeIfExpired() {
    if (!cachesImpl) return false;
    if (cachesImpl.has && !(await cachesImpl.has(cacheName))) return false;
    const meta = await readJson(META);
    const c = await open();
    const keys = c.keys ? await c.keys() : [];
    const expired = meta?.lastAuthOk ? now() - meta.lastAuthOk > maxAge : keys.length > 0;
    if (expired) await wipe();
    return expired;
  }

  async function saved(url) {
    const hit = await readJson(url);
    return hit ? { data: hit.data, fetchedAt: hit.fetchedAt } : { data: null, fetchedAt: null };
  }

  async function get(url) {
    await wipeIfExpired();
    let res;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      res = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', signal: ac.signal, headers: { accept: 'application/json' } });
    } catch (e) {
      return { ...(await saved(url)), stale: true, offline: true, status: 0, error: String(e?.name === 'AbortError' ? 'timed out' : e?.message || e) };
    } finally { clearTimeout(t); }
    const isJson = String(res.headers.get('content-type') || '').includes('json');
    if (res.ok && isJson) {
      let data;
      try { data = await res.json(); } catch { return { ...(await saved(url)), stale: true, status: res.status, error: 'bad JSON' }; }
      const at = now();
      const c = await open();
      if (c) { await c.put(url, asJson({ fetchedAt: at, data })); await c.put(META, asJson({ lastAuthOk: at })); }
      return { data, fetchedAt: at, stale: false, status: res.status };
    }
    if (res.status === 401 || res.status === 403) return { ...(await saved(url)), stale: true, signedOut: true, status: res.status };
    if (res.status === 404 || (res.status === 503 && isJson)) {
      if (cachesImpl && (!cachesImpl.has || (await cachesImpl.has(cacheName)))) await (await open()).delete(url);
      return { data: null, fetchedAt: null, stale: false, missing: true, status: res.status };
    }
    return { ...(await saved(url)), stale: true, status: res.status, error: `HTTP ${res.status}` };
  }

  return { get, saved, wipe, wipeIfExpired, lastSync, cacheName };
}

/**
 * Sign out and wipe this device: every Cache Storage cache, every IndexedDB database, local
 * and session storage, and the service worker registrations. Then navigate to `url` (the
 * server's logout, which clears cookies and sends Clear-Site-Data). Each step is best effort;
 * the navigation always happens.
 */
export async function logoutAndWipe(url = '/logout', {
  cachesImpl = typeof caches !== 'undefined' ? caches : undefined,
  idb = typeof indexedDB !== 'undefined' ? indexedDB : undefined,
  storages = [typeof localStorage !== 'undefined' ? localStorage : null, typeof sessionStorage !== 'undefined' ? sessionStorage : null],
  sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
  dbNames = [],
  navigate = (u) => location.assign(u),
} = {}) {
  const step = async (fn) => { try { await fn(); } catch { /* keep going */ } };
  await step(async () => { if (cachesImpl) await Promise.all((await cachesImpl.keys()).map((k) => cachesImpl.delete(k))); });
  await step(async () => {
    if (!idb) return;
    const names = new Set(dbNames);
    if (idb.databases) for (const d of await idb.databases()) if (d?.name) names.add(d.name);
    await Promise.all([...names].map((n) => new Promise((done) => {
      const r = idb.deleteDatabase(n);
      r.onsuccess = r.onerror = r.onblocked = () => done();
    })));
  });
  for (const s of storages) await step(() => { if (s) s.clear(); });
  await step(async () => { if (sw?.getRegistrations) await Promise.all((await sw.getRegistrations()).map((r) => r.unregister())); });
  navigate(url);
}

// --- Web Push ------------------------------------------------------------------

/** base64url (a VAPID public key) → Uint8Array, for pushManager.subscribe. */
export function pwaKitB64uToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const pwaKitPushEnv = (o = {}) => ({
  sw: 'sw' in o ? o.sw : (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined),
  NotificationImpl: 'NotificationImpl' in o ? o.NotificationImpl : (typeof Notification !== 'undefined' ? Notification : undefined),
  hasPushManager: 'hasPushManager' in o ? o.hasPushManager : (typeof window !== 'undefined' && 'PushManager' in window),
});

/**
 * Where Web Push stands on this device:
 *   { state: 'unsupported' | 'denied' | 'subscribed' | 'off', permission, endpoint? }
 * ('off' = supported and not denied, but no subscription yet.) Push needs an installed or
 * secure-context page with a registered worker.
 */
export async function pushStatus(opts = {}) {
  const { sw, NotificationImpl, hasPushManager } = pwaKitPushEnv(opts);
  if (!sw || !NotificationImpl || !hasPushManager) return { state: 'unsupported', permission: 'unsupported' };
  const permission = NotificationImpl.permission;
  if (permission === 'denied') return { state: 'denied', permission };
  try {
    const reg = await sw.ready;
    const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
    if (sub && permission === 'granted') return { state: 'subscribed', permission, endpoint: sub.endpoint };
  } catch { /* no worker yet */ }
  return { state: 'off', permission };
}

/**
 * Ask for permission and subscribe with the server's VAPID public key (base64url). Returns
 * { ok: true, subscription } (subscription = PushSubscription.toJSON(), to POST to your server),
 * or { ok: false, reason: 'unsupported' | 'denied' | 'dismissed' | 'failed', error? }.
 * Call it from a tap: browsers only show the prompt for a user gesture. An existing
 * subscription made with a different key is replaced.
 */
export async function subscribePush({ vapidPublicKey, ...opts } = {}) {
  const { sw, NotificationImpl, hasPushManager } = pwaKitPushEnv(opts);
  if (!sw || !NotificationImpl || !hasPushManager) return { ok: false, reason: 'unsupported' };
  if (!vapidPublicKey) return { ok: false, reason: 'failed', error: 'no VAPID public key' };
  let permission = NotificationImpl.permission;
  if (permission === 'default') permission = await NotificationImpl.requestPermission();
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission !== 'granted') return { ok: false, reason: 'dismissed' };
  try {
    const reg = await sw.ready;
    const key = pwaKitB64uToBytes(vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const had = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      const same = had && had.length === key.length && had.every((b, i) => b === key[i]);
      if (!same) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    return { ok: true, subscription: sub.toJSON() };
  } catch (e) {
    return { ok: false, reason: 'failed', error: String(e?.message || e) };
  }
}

/** Drop this device's subscription. Returns the endpoint it had (tell the server), or null. */
export async function unsubscribePush(opts = {}) {
  const { sw } = pwaKitPushEnv(opts);
  try {
    const reg = sw && (await sw.ready);
    const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
    if (!sub) return null;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    return endpoint;
  } catch { return null; }
}
