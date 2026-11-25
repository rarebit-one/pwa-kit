// Upload a built site directory to object storage under a prefix. The storage client is
// injected as `put(key, body, contentType)`, so this module has no SDK dependency.
//
// `index.html` goes LAST: uploads aren't atomic, and a device must never load a page whose
// service worker and assets aren't there yet. (The service worker also refuses to pair with a
// page from a different build, which covers the window in between.)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const PUBLISH_TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  webmanifest: 'application/manifest+json',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
};

export const publishTypeFor = (file) => PUBLISH_TYPES[String(file).split('.').pop().toLowerCase()] || null;

/** Every publishable file under `dir`, as POSIX relative paths, `index.html` last. */
export function listSiteFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (publishTypeFor(name)) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort((a, b) => (a === 'index.html') - (b === 'index.html'));
}

/**
 * Publish `dir` to `<prefix><path>`. Returns the list of { key, type, bytes } uploaded.
 * `required` names files that must exist (default: the PWA trio).
 */
export async function publishSite({ dir, prefix = '', put, dryRun = false, log = () => {}, required = ['index.html', 'sw.js', 'manifest.webmanifest'] }) {
  if (!dryRun && typeof put !== 'function') throw new Error('publishSite needs put(key, body, contentType)');
  if (prefix && !prefix.endsWith('/')) throw new Error('prefix must end with "/"');
  const files = listSiteFiles(dir);
  for (const need of required) if (!files.includes(need)) throw new Error(`${dir} is missing ${need}: build first`);
  const done = [];
  for (const f of files) {
    const body = readFileSync(join(dir, f));
    const type = publishTypeFor(f);
    const key = prefix + f;
    if (!dryRun) await put(key, body, type);
    log(`${dryRun ? 'would put' : 'put'} ${key} (${type}, ${body.length} bytes)`);
    done.push({ key, type, bytes: body.length });
  }
  return done;
}
