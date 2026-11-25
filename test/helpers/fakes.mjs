// Minimal in-memory stand-ins for browser APIs, for tests.

// Cache Storage: caches.open/keys/has/delete/match and cache.put/match/delete/keys.
export function fakeCaches({ base = 'https://app.example.com/' } = {}) {
  const store = new Map(); // name -> Map(key -> { body, init })
  const keyOf = (k) => new URL(typeof k === 'string' ? k : k.url, base).href;
  const cacheFor = (name) => {
    const m = store.get(name);
    return {
      async put(k, res) {
        const body = await res.clone().text();
        m.set(keyOf(k), { body, init: { status: res.status, headers: Object.fromEntries(res.headers) } });
      },
      async match(k) { const e = m.get(keyOf(k)); return e ? new Response(e.body, e.init) : undefined; },
      async delete(k) { return m.delete(keyOf(k)); },
      async keys() { return [...m.keys()].map((url) => ({ url })); },
    };
  };
  return {
    store,
    async open(name) { if (!store.has(name)) store.set(name, new Map()); return cacheFor(name); },
    async has(name) { return store.has(name); },
    async delete(name) { return store.delete(name); },
    async keys() { return [...store.keys()]; },
    async match(k, { cacheName } = {}) {
      for (const [n, m] of store) if (!cacheName || n === cacheName) { const e = m.get(keyOf(k)); if (e) return new Response(e.body, e.init); }
      return undefined;
    },
  };
}

// A Response-like object whose type/redirected/url can be set (real Response can't).
export function fakeResponse(body, { status = 200, type = 'basic', redirected = false, headers = { 'content-type': 'text/html; charset=utf-8' } } = {}) {
  const r = new Response(body, { status, headers });
  return Object.defineProperties(r, {
    type: { value: type },
    redirected: { value: redirected },
    clone: { value: () => fakeResponse(body, { status, type, redirected, headers }) },
  });
}

export const memoryStorage = () => {
  const m = new Map();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), clear: () => m.clear() };
};
