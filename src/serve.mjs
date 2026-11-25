// Serving helpers for a gated PWA proxied by a serverless function (DigitalOcean Functions /
// OpenWhisk `web: raw` response shape: { statusCode, headers, body }).
//
// The function reads the built site from a private bucket and answers with these helpers, so
// the shell is only ever reachable behind the function's own auth gate.

// --- response helpers ---------------------------------------------------------

export const json = (statusCode, obj, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(obj),
});
export const text = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  body,
});
export const html = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body,
});
export const redirect = (location, headers = {}) => ({ statusCode: 302, headers: { location, ...headers }, body: '' });

// --- paths, types and caching ---------------------------------------------------

// A relative site path is safe when it has no traversal, no leading slash, no empty or dot
// segments, and only conservative characters. Anything else is refused before it reaches the
// bucket.
export function safeRelPath(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.length > 200) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(rel)) return false;
  if (rel.startsWith('/') || rel.endsWith('/')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export const extOf = (p) => {
  const base = String(p).split('/').pop();
  return base.includes('.') ? base.split('.').pop().toLowerCase() : '';
};

// Content types the proxy answers with. `.webmanifest` goes out as plain application/json
// with a PARSED object body: the DigitalOcean web-action gateway rejects a string body under a
// JSON content type it did not generate itself, and browsers accept application/json for a
// manifest.
export const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  webmanifest: 'application/json',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
};
export const BINARY_EXTS = new Set(['png', 'ico', 'webp', 'woff2']);
export const contentTypeFor = (ext) => CONTENT_TYPES[ext] || 'application/octet-stream';
export const isBinaryExt = (ext) => BINARY_EXTS.has(ext);

// Cache-Control for gated files. The page, scripts, manifest and service worker must
// revalidate so updates reach installed apps. Images may be kept a day, but only `private`:
// these files sit behind sign-in, so no shared cache may keep them.
export function cacheControlFor(ext) {
  if (['png', 'ico', 'webp', 'svg', 'woff2'].includes(ext)) return 'private, max-age=86400';
  return 'no-cache';
}

/**
 * Build a response for one site file. `load(key, { binary })` returns a string (text files),
 * a Buffer/Uint8Array (binary files), or null when the object is missing.
 * Returns null when the file does not exist, so the caller can fall back.
 */
export async function serveFile(rel, { prefix = '', load, headers = {} }) {
  if (!safeRelPath(rel)) return text(400, 'bad path');
  const ext = extOf(rel);
  const type = contentTypeFor(ext);
  const base = { 'content-type': type, 'cache-control': cacheControlFor(ext), 'x-content-type-options': 'nosniff', ...headers };
  if (isBinaryExt(ext)) {
    const buf = await load(prefix + rel, { binary: true });
    if (buf == null) return null;
    return { statusCode: 200, headers: base, body: Buffer.from(buf).toString('base64') };
  }
  const body = await load(prefix + rel, { binary: false });
  if (body == null) return null;
  const str = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  if (type === 'application/json') {
    try { return { statusCode: 200, headers: base, body: JSON.parse(str) }; } catch { return text(500, 'bad json object'); }
  }
  return { statusCode: 200, headers: base, body: str };
}
