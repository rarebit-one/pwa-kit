// Build a single-page PWA shell from plain ES modules and CSS.
//
// The modules are INLINED into one <script> in index.html: their single-line `import` lines
// are dropped and `export` keywords stripped, so they share one scope inside an IIFE. (One file
// means no sub-resources for the proxy to serve, and nothing for the service worker to pair up
// beyond the page itself.) Write site modules with that in mind: single-line imports only,
// unique top-level names, no `export default`, no `export { ... }` lists.
//
// Output (outDir):
//   index.html             the page (meta for installability on Android and iOS, a manifest
//                          link with crossorigin="use-credentials", the "Updated" banner)
//   sw.js                  the service worker for this BUILD (or the kill switch)
//   manifest.webmanifest
//   icons/*                copied from iconsDir
//
// BUILD = "<YYYY-MM-DD>-<first 8 hex of sha256(all sources)>". It is embedded in the page and
// the worker; the worker refuses to install against a page of another build.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceWorkerSource, killSwitchSource } from './sw.mjs';

export const CLIENT_PATH = fileURLToPath(new URL('./client.mjs', import.meta.url));
export const DEFAULT_ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Strip module syntax so the source can share one script scope. Throws on what it can't strip. */
export function unmodule(src, name = 'module') {
  const out = String(src)
    .replace(/^import\s[^\n]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^import\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^export\s+(async\s+function|function\*?|const|let|var|class)\s/gm, '$1 ');
  const bad = out.match(/^(import|export)\b[^\n]*/m);
  if (bad) throw new Error(`${name}: cannot inline "${bad[0].slice(0, 60)}" (use single-line imports and inline exports)`);
  return out;
}

/** "<date>-<sha256(sources)[0:8]>" */
export function computeBuild(sources, { date = new Date() } = {}) {
  const h = createHash('sha256');
  for (const s of sources) h.update(String(s)).update('\0');
  return `${date.toISOString().slice(0, 10)}-${h.digest('hex').slice(0, 8)}`;
}

export function renderManifest({ name, shortName, description, id = './', startUrl = './', scope = './', themeColor, backgroundColor, iconsPath = 'icons/', orientation = 'any', extra = {} }) {
  return {
    name, short_name: shortName || name, ...(description ? { description } : {}),
    id, start_url: startUrl, scope, display: 'standalone', orientation,
    theme_color: themeColor, background_color: backgroundColor || themeColor,
    icons: [
      { src: `${iconsPath}icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${iconsPath}icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${iconsPath}icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    ...extra,
  };
}

const UPDATE_CSS = '.pwa-update{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom) + 76px);z-index:50;font:inherit;padding:10px 16px;border-radius:999px;border:0;cursor:pointer}.pwa-update[hidden]{display:none}';

export function renderIndexHtml({ build, title, shortName, themeColor, colorScheme = 'light dark', lang = 'en', head = '', css = '', body = '', script, iconsPath = 'icons/', updateBanner = true }) {
  if (/<\/style/i.test(css)) throw new Error('css must not contain "</style"');
  const safeScript = String(script).replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="${esc(lang)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="pwa-build" content="${esc(build)}">
<meta name="theme-color" content="${esc(themeColor)}">
<meta name="color-scheme" content="${esc(colorScheme)}">
<meta name="format-detection" content="telephone=no">
<meta name="robots" content="noindex, nofollow">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${esc(shortName || title)}">
<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="${esc(iconsPath)}icon-192.png">
<link rel="apple-touch-icon" href="${esc(iconsPath)}apple-touch-icon.png">
${head}
<style>${updateBanner ? UPDATE_CSS : ''}${css}</style>
</head><body>
${body}
${updateBanner ? '<button type="button" class="pwa-update" id="pwa-update" hidden><b>Updated.</b> Tap to reload.</button>' : ''}
<script>${safeScript}</script>
</body></html>
`;
}

/**
 * Build the site. Paths in `modules` and `css` are files; `body`/`head` are HTML strings.
 * Returns { build, outDir, files }.
 */
export function buildSite({
  outDir,
  title,
  shortName,
  description,
  modules = [],
  css = [],
  body = '',
  head = '',
  themeColor = '#000000',
  backgroundColor,
  colorScheme,
  lang,
  iconsDir,
  icons = DEFAULT_ICONS,
  cachePrefix,
  apiPrefix = '/api/',
  includeClient = true,
  killSwitch = false,
  manifest = {},
  extraSources = [],
  date = new Date(),
  defines = {},
  push = null,
}) {
  if (!outDir || !title || !cachePrefix) throw new Error('buildSite needs outDir, title and cachePrefix');
  const mods = [...(includeClient ? [CLIENT_PATH] : []), ...modules].map((f) => {
    const name = f === CLIENT_PATH ? 'pwa-kit/client.mjs' : basename(f);
    return `// ---- ${name}\n${unmodule(readFileSync(f, 'utf8'), name)}`;
  }).join('\n');
  const styles = [].concat(css).map((f) => readFileSync(f, 'utf8')).join('\n');
  const man = renderManifest({ name: title, shortName, description, themeColor, backgroundColor, ...manifest });
  const defs = Object.entries(defines).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join('\n');
  const build = computeBuild([mods, styles, body, head, JSON.stringify(man), defs, ...(push ? [JSON.stringify(push)] : []), ...extraSources], { date });
  const script = `(() => {\n"use strict";\nconst BUILD = ${JSON.stringify(build)};\n${defs}\n${mods}\n})();`;

  mkdirSync(join(outDir, 'icons'), { recursive: true });
  const files = [];
  const write = (rel, content) => { writeFileSync(join(outDir, rel), content); files.push(rel); };

  write('index.html', renderIndexHtml({ build, title, shortName, themeColor, colorScheme, lang, head, css: styles, body, script }));
  write('manifest.webmanifest', JSON.stringify(man, null, 2) + '\n');
  const iconFiles = [];
  if (iconsDir) {
    for (const f of icons) {
      const src = join(iconsDir, f);
      if (!existsSync(src)) throw new Error(`missing icon ${src}`);
      copyFileSync(src, join(outDir, 'icons', f));
      files.push(`icons/${f}`);
      iconFiles.push(`icons/${f}`);
    }
  }
  write('sw.js', killSwitch
    ? killSwitchSource({ build: `kill-switch-${build}` })
    : serviceWorkerSource({ build, cachePrefix, apiPrefix, extras: ['manifest.webmanifest', ...iconFiles], push }));
  return { build, outDir, files, killSwitch };
}
