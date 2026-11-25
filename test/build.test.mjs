import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unmodule, computeBuild, buildSite, renderManifest } from '../src/build.mjs';

test('unmodule strips single-line imports and inline exports', () => {
  const src = "import { a } from './a.mjs';\nimport './side.mjs';\nexport const x = 1;\nexport function f() {}\nexport async function g() {}\nexport class C {}\nexport let y;\nconst z = 'import x from y';";
  const out = unmodule(src);
  assert.doesNotMatch(out, /^(import|export)\b/m);
  assert.match(out, /^const x = 1;$/m);
  assert.match(out, /^async function g\(\) \{\}$/m);
  assert.match(out, /^class C \{\}$/m);
  assert.match(out, /'import x from y'/);
});

test('unmodule refuses what it cannot inline', () => {
  assert.throws(() => unmodule("import {\n  a,\n} from './a.mjs';", 'm.mjs'), /m\.mjs: cannot inline/);
  assert.throws(() => unmodule('export default 1;'), /cannot inline/);
  assert.throws(() => unmodule('const a = 1;\nexport { a };'), /cannot inline/);
});

test('computeBuild is date + 8 hex of the sources hash, and changes with any source', () => {
  const date = new Date('2026-03-04T05:06:07Z');
  const b = computeBuild(['a', 'b'], { date });
  assert.match(b, /^2026-03-04-[0-9a-f]{8}$/);
  assert.equal(computeBuild(['a', 'b'], { date }), b);
  assert.notEqual(computeBuild(['a', 'c'], { date }), b);
  assert.notEqual(computeBuild(['ab', ''], { date }), b, 'sources are delimited');
});

test('renderManifest: standalone, id/start_url/scope, colours, icons incl. maskable', () => {
  const m = renderManifest({ name: 'Demo App', shortName: 'Demo', themeColor: '#111', backgroundColor: '#000' });
  assert.equal(m.display, 'standalone');
  assert.equal(m.id, './');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.theme_color, '#111');
  assert.equal(m.background_color, '#000');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pwa-kit-build-'));
  mkdirSync(join(dir, 'icons'));
  for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) writeFileSync(join(dir, 'icons', f), 'png');
  writeFileSync(join(dir, 'util.mjs'), "export const greet = (n) => `hi ${n}`;\n");
  writeFileSync(join(dir, 'app.js'), "import { greet } from './util.mjs';\nimport { registerServiceWorker } from '@scope/pwa-kit/client';\nconst s = '</script>';\nglobalThis.__out = [greet('x'), typeof registerServiceWorker, BUILD, s, APP_NAME];\n");
  writeFileSync(join(dir, 'style.css'), 'body{color:red}');
  return dir;
}

test('buildSite emits the page, worker, manifest and icons for one BUILD', () => {
  const dir = fixture();
  const out = join(dir, 'dist');
  try {
    const r = buildSite({
      outDir: out, title: 'Demo App', shortName: 'Demo', themeColor: '#123456', cachePrefix: 'demo-shell',
      modules: [join(dir, 'util.mjs'), join(dir, 'app.js')], css: join(dir, 'style.css'), body: '<main id="main"></main>',
      iconsDir: join(dir, 'icons'), defines: { APP_NAME: 'demo' }, date: new Date('2026-01-02T00:00:00Z'),
    });
    assert.match(r.build, /^2026-01-02-[0-9a-f]{8}$/);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(html, /<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
    assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon.png">/);
    assert.match(html, /<meta name="theme-color" content="#123456">/);
    assert.match(html, /id="pwa-update" hidden><b>Updated.<\/b> Tap to reload./);
    assert.match(html, /body\{color:red\}/);
    assert.ok(html.includes(r.build));
    assert.equal((html.match(/<\/script>/g) || []).length, 1, 'the inlined "</script>" literal is escaped');
    // The inlined script runs: the kit client and the modules share one scope.
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    const ctx = vm.createContext({});
    vm.runInContext(script, ctx);
    assert.deepEqual([...ctx.__out], ['hi x', 'function', r.build, '</script>', 'demo']);
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    assert.ok(sw.includes(`const BUILD = "${r.build}"`));
    assert.match(sw, /"icons\/icon-192.png"/);
    const man = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8'));
    assert.equal(man.short_name, 'Demo');
    for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) assert.ok(existsSync(join(out, 'icons', f)), f);
    assert.deepEqual(r.files.sort(), ['icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'index.html', 'manifest.webmanifest', 'sw.js']);
  } finally { rmSync(dir, { recursive: true }); }
});

test('buildSite with killSwitch writes the kill-switch worker', () => {
  const dir = fixture();
  const out = join(dir, 'dist');
  try {
    const r = buildSite({ outDir: out, title: 'Demo', cachePrefix: 'demo-shell', modules: [join(dir, 'util.mjs')], killSwitch: true, iconsDir: join(dir, 'icons') });
    const sw = readFileSync(join(out, 'sw.js'), 'utf8');
    assert.match(sw, /KILL SWITCH/);
    assert.match(sw, /registration\.unregister\(\)/);
    assert.doesNotMatch(sw, /addEventListener\("fetch"/);
    assert.equal(r.killSwitch, true);
  } finally { rmSync(dir, { recursive: true }); }
});

test('buildSite refuses a missing icon or missing options', () => {
  const dir = fixture();
  try {
    rmSync(join(dir, 'icons', 'icon-512.png'));
    assert.throws(() => buildSite({ outDir: join(dir, 'd'), title: 'x', cachePrefix: 'x', iconsDir: join(dir, 'icons') }), /missing icon/);
    assert.throws(() => buildSite({ outDir: join(dir, 'd'), title: 'x' }), /needs/);
  } finally { rmSync(dir, { recursive: true }); }
});
