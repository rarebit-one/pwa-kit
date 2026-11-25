import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeToken, verifyToken, signClaims, verifySigned, readCookie, readSessionCookie, cookie, clearCookie, logoutHeaders,
} from '../src/session.mjs';

const secret = 'k'.repeat(32);
const now = 1_700_000_000_000;

test('a fresh token verifies and carries its claims', () => {
  const t = makeToken('alice', { secret, ttlMs: 1000, now });
  const c = verifyToken(t, { secret, now: now + 1 });
  assert.equal(c.u, 'alice');
  assert.equal(c.e, now + 1000);
  assert.equal(c.s, undefined);
});

test('expired, forged, tampered or wrong-secret tokens are rejected', () => {
  const t = makeToken('alice', { secret, ttlMs: 1000, now });
  assert.equal(verifyToken(t, { secret, now: now + 1000 }), null, 'expiry is exclusive');
  assert.equal(verifyToken(t + 'x', { secret, now }), null);
  assert.equal(verifyToken(t, { secret: 'other-secret', now }), null);
  const [p] = t.split('.');
  const forged = `${Buffer.from(JSON.stringify({ u: 'mallory', e: now + 9e9 })).toString('base64url')}.${t.split('.')[1]}`;
  assert.equal(verifyToken(forged, { secret, now }), null);
  assert.equal(verifyToken(`${p}.`, { secret, now }), null);
  assert.equal(verifyToken(`${t}.extra`, { secret, now }), null);
  assert.equal(verifyToken('', { secret, now }), null);
});

test('no secret: minting throws and verifying refuses (fail closed)', () => {
  assert.throws(() => makeToken('alice', { secret: '', ttlMs: 1 }));
  const t = makeToken('alice', { secret, ttlMs: 1000, now });
  assert.equal(verifyToken(t, { secret: '', now }), null);
  assert.equal(verifySigned(t, () => undefined), null);
});

test('scoped tokens never pass a plain-session check, and scopes do not cross', () => {
  const scoped = makeToken('alice', { secret, ttlMs: 1000, scope: 'device', now });
  assert.equal(verifyToken(scoped, { secret, now }), null, 'plain check rejects a scoped token');
  assert.equal(verifyToken(scoped, { secret, scope: 'device', now }).u, 'alice');
  assert.equal(verifyToken(scoped, { secret, scope: 'mcp', now }), null);
  const plain = makeToken('alice', { secret, ttlMs: 1000, now });
  assert.equal(verifyToken(plain, { secret, scope: 'device', now }), null, 'scoped check rejects a plain token');
});

test('epoch: tokens from another generation are rejected; missing g reads as 0', () => {
  const g0 = makeToken('alice', { secret, ttlMs: 1000, now });
  const g3 = makeToken('alice', { secret, ttlMs: 1000, epoch: 3, now });
  assert.ok(verifyToken(g0, { secret, epoch: 0, now }));
  assert.equal(verifyToken(g0, { secret, epoch: 1, now }), null);
  assert.ok(verifyToken(g3, { secret, epoch: 3, now }));
  assert.equal(verifyToken(g3, { secret, epoch: 4, now }), null);
  assert.ok(verifyToken(g3, { secret, now }), 'no epoch given: generation not checked');
});

test('expiresAt pins an absolute expiry', () => {
  const t = makeToken('alice', { secret, expiresAt: now + 5 });
  assert.equal(verifyToken(t, { secret, now }).e, now + 5);
});

test('signClaims/verifySigned round-trip arbitrary claims', () => {
  assert.deepEqual(verifySigned(signClaims({ n: 'x', e: 1 }, secret), secret), { n: 'x', e: 1 });
});

test('readCookie matches the exact name only', () => {
  const h = 'xsession=bad; session=good; other=1';
  assert.equal(readCookie(h, 'session'), 'good');
  assert.equal(readCookie(h, 'missing'), null);
  assert.equal(readCookie(undefined, 'session'), null);
  const t = makeToken('alice', { secret, ttlMs: 1000, now });
  assert.equal(readSessionCookie(`a=b; s=${t}`, 's', { secret, now }).u, 'alice');
});

test('cookie builders set HttpOnly, Secure and SameSite=Lax', () => {
  assert.equal(cookie('s', 'v', { maxAge: 60 }), 's=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60');
  assert.equal(cookie('s', 'v', { path: '/app' }), 's=v; Path=/app; HttpOnly; Secure; SameSite=Lax');
  assert.equal(clearCookie('s'), 's=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
});

test('logoutHeaders clears every cookie and asks the browser to clear site data', () => {
  const h = logoutHeaders(['a', 'b']);
  assert.deepEqual(h['set-cookie'], [clearCookie('a'), clearCookie('b')]);
  assert.equal(h['clear-site-data'], '"cache", "storage", "cookies"');
  assert.equal(h['cache-control'], 'no-store');
  assert.match(logoutHeaders('x', '/p')['set-cookie'][0], /^x=; Path=\/p;/);
});
