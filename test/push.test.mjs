import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  encryptPayload, generateVapidKeys, vapidPublicKey, vapidAuthorization, validSubscription,
  knownPushEndpoint, sendPush, MAX_PUSH_PLAINTEXT,
} from '../src/push.mjs';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

// RFC 8291 Appendix A.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

// The user agent's side of RFC 8291, to decrypt what encryptPayload produces.
function decrypt(body, { uaPrivate, auth }) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(unb64u(uaPrivate));
  const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prkKey = h(unb64u(auth), ua.computeSecret(asPublic));
  const ikm = h(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = rec.length - 1;
  while (end >= 0 && rec[end] === 0) end--; // strip padding
  assert.equal(rec[end], 2, 'last-record delimiter');
  return { rs, asPublic: b64u(asPublic), plaintext: rec.subarray(0, end) };
}

function uaKeys() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return { uaPrivate: b64u(ua.getPrivateKey()), p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) };
}

test('encryptPayload reproduces the RFC 8291 Appendix A vector', () => {
  const out = encryptPayload(unb64u(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: RFC.salt, localPrivateKey: RFC.asPrivate });
  assert.equal(out.length, 86 + unb64u(RFC.ciphertext).length);
  assert.equal(b64u(out.subarray(0, 86)), RFC.header);
  assert.equal(b64u(out.subarray(86)), RFC.ciphertext);
});

test('the RFC vector decrypts with the user agent private key', () => {
  const body = Buffer.concat([unb64u(RFC.header), unb64u(RFC.ciphertext)]);
  const r = decrypt(body, { uaPrivate: RFC.uaPrivate, auth: RFC.auth });
  assert.equal(r.rs, 4096);
  assert.equal(r.asPublic, RFC.asPublic);
  assert.equal(r.plaintext.toString(), 'When I grow up, I want to be a watermelon');
});

test('encryptPayload round-trips with fresh keys, salt and padding', () => {
  const k = uaKeys();
  const a = encryptPayload('{"title":"hi"}', k);
  const b = encryptPayload('{"title":"hi"}', k, { padding: 32 });
  assert.notEqual(b64u(a), b64u(encryptPayload('{"title":"hi"}', k)), 'random salt and key each time');
  assert.equal(decrypt(a, k).plaintext.toString(), '{"title":"hi"}');
  assert.equal(decrypt(b, k).plaintext.toString(), '{"title":"hi"}');
  assert.equal(b.length, a.length + 32);
});

test('encryptPayload refuses bad keys and oversize payloads', () => {
  const k = uaKeys();
  assert.throws(() => encryptPayload('x', { ...k, p256dh: b64u(Buffer.alloc(65)) }), /p256dh/);
  assert.throws(() => encryptPayload('x', { ...k, auth: b64u(Buffer.alloc(8)) }), /auth/);
  assert.throws(() => encryptPayload('x'.repeat(MAX_PUSH_PLAINTEXT + 1), k), /too large/);
  assert.ok(encryptPayload('x'.repeat(MAX_PUSH_PLAINTEXT), k).length <= 4096 + 86);
});

test('VAPID keys: 65-byte public point, 32-byte private scalar, derivable', () => {
  const { publicKey, privateKey } = generateVapidKeys();
  assert.equal(unb64u(publicKey).length, 65);
  assert.equal(unb64u(publicKey)[0], 4);
  assert.equal(unb64u(privateKey).length, 32);
  assert.equal(vapidPublicKey(privateKey), publicKey);
  assert.equal(vapidPublicKey(RFC.asPrivate), RFC.asPublic);
  assert.throws(() => vapidPublicKey('abc'), /32 bytes/);
});

test('vapidAuthorization: ES256 JWT for the endpoint origin, verifiable with k', () => {
  const v = generateVapidKeys();
  const now = Date.UTC(2026, 0, 1);
  const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { subject: 'mailto:ops@example.com', ...v, now });
  const m = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.equal(m[2], v.publicKey);
  const [head, body, sig] = m[1].split('.');
  assert.deepEqual(JSON.parse(unb64u(head)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(unb64u(body)), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:ops@example.com' });
  const pub = unb64u(v.publicKey);
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  assert.equal(unb64u(sig).length, 64, 'raw r||s, not DER');
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(sig)));
});

test('vapidAuthorization caps exp at 24 h and checks subject and key pair', () => {
  const v = generateVapidKeys();
  const now = Date.UTC(2026, 0, 1);
  const h = vapidAuthorization('https://fcm.googleapis.com/x', { subject: 'https://example.com', privateKey: v.privateKey, ttlSec: 99 * 3600, now });
  const claims = JSON.parse(unb64u(h.match(/t=([^,]+)/)[1].split('.')[1]));
  assert.equal(claims.exp, now / 1000 + 24 * 3600);
  assert.throws(() => vapidAuthorization('https://fcm.googleapis.com/x', { subject: 'ops@example.com', ...v }), /subject/);
  assert.throws(() => vapidAuthorization('https://fcm.googleapis.com/x', { subject: 'mailto:a@b.c', privateKey: v.privateKey, publicKey: generateVapidKeys().publicKey }), /does not match/);
});

test('knownPushEndpoint accepts the browser push services only', () => {
  for (const u of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-sg2p.notify.windows.com/w/?token=x']) assert.ok(knownPushEndpoint(u), u);
  for (const u of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.test/x', 'https://evil.test/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'https://169.254.169.254/', 'nope']) assert.ok(!knownPushEndpoint(u), u);
});

test('validSubscription cleans a good subscription and refuses the rest', () => {
  const k = uaKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys: { p256dh: k.p256dh, auth: k.auth } };
  assert.deepEqual(validSubscription(sub), { endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } });
  assert.equal(validSubscription({ ...sub, endpoint: 'https://evil.test/x' }), null);
  assert.ok(validSubscription({ ...sub, endpoint: 'https://push.example.test/x' }, { endpointOk: () => true }));
  assert.equal(validSubscription({ ...sub, keys: { p256dh: k.p256dh } }), null);
  assert.equal(validSubscription({ ...sub, keys: { p256dh: b64u(Buffer.alloc(65, 1)), auth: k.auth } }), null);
  assert.equal(validSubscription({ ...sub, keys: { p256dh: k.p256dh, auth: '<script>' } }), null);
  assert.equal(validSubscription(null), null);
});

test('sendPush encrypts, signs and POSTs; 404/410 mark the subscription gone', async () => {
  const v = { subject: 'mailto:ops@example.com', ...generateVapidKeys() };
  const k = uaKeys();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: k.p256dh, auth: k.auth } };
  const calls = [];
  const fetchImpl = (status) => async (url, init) => { calls.push({ url, init }); return { status }; };
  const r = await sendPush(sub, { title: 'Deploy failed', url: '/' }, { vapid: v, ttl: 600, urgency: 'high', topic: 'deploy', fetchImpl: fetchImpl(201) });
  assert.deepEqual(r, { ok: true, status: 201, gone: false });
  const { url, init } = calls[0];
  assert.equal(url, sub.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-encoding'], 'aes128gcm');
  assert.equal(init.headers.ttl, '600');
  assert.equal(init.headers.urgency, 'high');
  assert.equal(init.headers.topic, 'deploy');
  assert.match(init.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.deepEqual(JSON.parse(decrypt(init.body, k).plaintext), { title: 'Deploy failed', url: '/' });

  assert.deepEqual(await sendPush(sub, 'x', { vapid: v, fetchImpl: fetchImpl(410) }), { ok: false, status: 410, gone: true });
  assert.deepEqual(await sendPush(sub, 'x', { vapid: v, fetchImpl: fetchImpl(404) }), { ok: false, status: 404, gone: true });
  assert.deepEqual(await sendPush(sub, 'x', { vapid: v, fetchImpl: fetchImpl(429) }), { ok: false, status: 429, gone: false });
  const down = await sendPush(sub, 'x', { vapid: v, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(down.status, 0);
  assert.equal(down.error, 'ECONNRESET');
  await assert.rejects(sendPush(sub, 'x', { vapid: { privateKey: v.privateKey } }), /subject/);
  await assert.rejects(sendPush(sub, 'x', { vapid: v, topic: 'has space' }), /topic/);
});
