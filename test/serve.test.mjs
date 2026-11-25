import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeRelPath, extOf, contentTypeFor, cacheControlFor, serveFile, json, redirect } from '../src/serve.mjs';

test('safeRelPath refuses traversal, absolute paths and odd characters', () => {
  for (const ok of ['index.html', 'icons/icon-192.png', 'sw.js', 'a/b/c.txt']) assert.ok(safeRelPath(ok), ok);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/', 'a b', 'a%2e', 'a\\b', 'x?y', null, 'a'.repeat(201)]) {
    assert.equal(safeRelPath(bad), false, String(bad));
  }
});

test('content types: .webmanifest is served as application/json', () => {
  assert.equal(contentTypeFor('webmanifest'), 'application/json');
  assert.equal(contentTypeFor('js'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('png'), 'image/png');
  assert.equal(contentTypeFor('exe'), 'application/octet-stream');
  assert.equal(extOf('icons/a.PNG'), 'png');
  assert.equal(extOf('Makefile'), '');
});

test('cache control: page, worker and manifest revalidate; images are private, never public', () => {
  for (const e of ['html', 'js', 'webmanifest', 'json', 'css']) assert.equal(cacheControlFor(e), 'no-cache');
  for (const e of ['png', 'ico', 'svg', 'webp']) {
    assert.equal(cacheControlFor(e), 'private, max-age=86400');
    assert.doesNotMatch(cacheControlFor(e), /public/);
  }
});

test('serveFile: text, binary as base64, manifest as a parsed object, missing as null', async () => {
  const files = { 'site/index.html': '<!doctype html>', 'site/manifest.webmanifest': '{"name":"x"}', 'site/icons/a.png': Buffer.from([1, 2, 3]) };
  const load = async (k) => files[k] ?? null;
  const page = await serveFile('index.html', { prefix: 'site/', load });
  assert.equal(page.statusCode, 200);
  assert.equal(page.body, '<!doctype html>');
  assert.equal(page.headers['cache-control'], 'no-cache');
  const man = await serveFile('manifest.webmanifest', { prefix: 'site/', load });
  assert.deepEqual(man.body, { name: 'x' });
  assert.equal(man.headers['content-type'], 'application/json');
  const png = await serveFile('icons/a.png', { prefix: 'site/', load });
  assert.equal(png.body, Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(png.headers['cache-control'], 'private, max-age=86400');
  assert.equal(await serveFile('nope.html', { prefix: 'site/', load }), null);
  assert.equal((await serveFile('../x', { load })).statusCode, 400);
  const extra = await serveFile('index.html', { prefix: 'site/', load, headers: { 'set-cookie': 'a=b' } });
  assert.equal(extra.headers['set-cookie'], 'a=b');
});

test('response helpers', () => {
  assert.deepEqual(JSON.parse(json(401, { error: 'x' }).body), { error: 'x' });
  assert.equal(redirect('/login').headers.location, '/login');
});
