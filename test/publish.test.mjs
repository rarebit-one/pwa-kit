import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishSite, listSiteFiles, publishTypeFor } from '../src/publish.mjs';

function site(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pwa-kit-pub-'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

test('index.html is uploaded last, nested files keep their paths, types by extension', async () => {
  const dir = site({ 'index.html': '<p>', 'sw.js': 'x', 'manifest.webmanifest': '{}', 'icons/icon-192.png': 'png', 'notes.unknown': 'skip', '.hidden.js': 'skip' });
  try {
    const puts = [];
    const done = await publishSite({ dir, prefix: 'site/', put: async (k, b, t) => puts.push([k, t, b.length]) });
    assert.equal(puts.at(-1)[0], 'site/index.html');
    assert.deepEqual(puts.map((p) => p[0]).sort(), ['site/icons/icon-192.png', 'site/index.html', 'site/manifest.webmanifest', 'site/sw.js']);
    assert.equal(puts.find((p) => p[0] === 'site/icons/icon-192.png')[1], 'image/png');
    assert.equal(puts.find((p) => p[0] === 'site/sw.js')[1], 'text/javascript; charset=utf-8');
    assert.equal(done.length, 4);
  } finally { rmSync(dir, { recursive: true }); }
});

test('missing required files or a bad prefix refuse before uploading anything', async () => {
  const dir = site({ 'index.html': '<p>' });
  try {
    let puts = 0;
    await assert.rejects(publishSite({ dir, prefix: 'site/', put: async () => { puts++; } }), /missing sw\.js/);
    await assert.rejects(publishSite({ dir, prefix: 'site', put: async () => {} }), /prefix/);
    await assert.rejects(publishSite({ dir, prefix: 'site/' }), /needs put/);
    assert.equal(puts, 0);
    const dry = await publishSite({ dir, prefix: 'site/', dryRun: true, required: ['index.html'] });
    assert.equal(dry[0].key, 'site/index.html');
  } finally { rmSync(dir, { recursive: true }); }
});

test('listSiteFiles and publishTypeFor', () => {
  const dir = site({ 'b.js': '', 'index.html': '', 'a.css': '' });
  try { assert.deepEqual(listSiteFiles(dir), ['a.css', 'b.js', 'index.html']); } finally { rmSync(dir, { recursive: true }); }
  assert.equal(publishTypeFor('x.webmanifest'), 'application/manifest+json');
  assert.equal(publishTypeFor('x.exe'), null);
});
