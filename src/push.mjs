// Web Push for the server side, on node:crypto only.
//
//   generateVapidKeys()                       a P-256 key pair for VAPID (RFC 8292), base64url
//   vapidAuthorization(endpoint, vapid)       the `Authorization: vapid t=…, k=…` header value
//   encryptPayload(plaintext, keys)           RFC 8291 message encryption (aes128gcm, RFC 8188)
//   validSubscription(sub, { endpointOk })    shape check for a PushSubscription.toJSON()
//   knownPushEndpoint(url)                    is the endpoint on a well-known push service?
//   sendPush(sub, payload, { vapid })         encrypt + POST; { ok, status, gone }
//
// Keys are base64url without padding, as browsers and the common libraries exchange them:
//   VAPID public key  65-byte uncompressed P-256 point (0x04 || X || Y) — the page passes it
//                     to pushManager.subscribe({ applicationServerKey })
//   VAPID private key 32-byte scalar (d)
//   subscription keys p256dh (65-byte point) and auth (16 bytes)

import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Largest plaintext that fits one 4096-octet record (4096 - 16 tag - 1 delimiter - 86 header). */
export const MAX_PUSH_PLAINTEXT = 3993;
export const RECORD_SIZE = 4096;

/** A fresh VAPID key pair: { publicKey, privateKey }, base64url. */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(padScalar(ecdh.getPrivateKey())) };
}

const padScalar = (d) => (d.length >= 32 ? d : Buffer.concat([Buffer.alloc(32 - d.length), d]));

/** The public key (base64url, uncompressed) for a VAPID private key. Throws on a bad key. */
export function vapidPublicKey(privateKey) {
  const d = unb64u(privateKey);
  if (d.length !== 32) throw new Error('VAPID private key must be 32 bytes (base64url)');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  return b64u(ecdh.getPublicKey());
}

function signingKey(privateKey) {
  const d = unb64u(privateKey);
  const pub = unb64u(vapidPublicKey(privateKey));
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

/**
 * The VAPID Authorization header value for one endpoint (RFC 8292):
 * `vapid t=<ES256 JWT {aud: endpoint origin, exp, sub}>, k=<public key>`.
 * `subject` is a `mailto:` or `https:` contact for the push service. `ttlSec` ≤ 24 h.
 */
export function vapidAuthorization(endpoint, { subject, privateKey, publicKey, ttlSec = 12 * 3600, now = Date.now() } = {}) {
  if (!/^(mailto:|https:\/\/)/.test(String(subject || ''))) throw new Error('VAPID subject must be a mailto: or https: URL');
  const k = publicKey || vapidPublicKey(privateKey);
  if (publicKey && publicKey !== vapidPublicKey(privateKey)) throw new Error('VAPID public key does not match the private key');
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(now / 1000) + Math.min(Math.max(60, ttlSec), 24 * 3600);
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey(privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${k}`;
}

/**
 * Encrypt a push message for one subscription (RFC 8291, aes128gcm, a single record).
 * `keys` is { p256dh, auth } from the subscription. `salt` and `localPrivateKey` exist for
 * test vectors only; leave them unset. Returns the request body (Buffer).
 */
export function encryptPayload(plaintext, { p256dh, auth } = {}, { salt, localPrivateKey, padding = 0 } = {}) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('subscription p256dh must be a 65-byte uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('subscription auth must be 16 bytes');
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  if (data.length + padding > MAX_PUSH_PLAINTEXT) throw new Error(`push payload too large (${data.length} > ${MAX_PUSH_PLAINTEXT} bytes)`);

  const local = crypto.createECDH('prime256v1');
  if (localPrivateKey) local.setPrivateKey(unb64u(localPrivateKey)); else local.generateKeys();
  const asPublic = local.getPublicKey();
  const ecdhSecret = local.computeSecret(uaPublic);
  const saltBuf = salt ? unb64u(salt) : crypto.randomBytes(16);
  if (saltBuf.length !== 16) throw new Error('salt must be 16 bytes');

  // RFC 8291 §3.4: combine the ECDH secret with the auth secret, then RFC 8188 key derivation.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(saltBuf, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const record = Buffer.concat([data, Buffer.from([2]), Buffer.alloc(padding)]); // 0x02: last record
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  saltBuf.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

// Push services the major browsers hand out. Endpoints come from the browser, but the server
// POSTs to them, so by default only these hosts are accepted (no request forgery to elsewhere).
const KNOWN_PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,             // Chrome, Edge on Android, most Chromium
  /^android\.googleapis\.com$/,         // older Chrome
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.push\.apple\.com$/,     // Safari (web.push.apple.com)
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows (wns2-*.notify.windows.com)
];

/** True when `url` is https on a well-known browser push service. */
export function knownPushEndpoint(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && KNOWN_PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

/**
 * Check a PushSubscription.toJSON() → a clean { endpoint, keys: { p256dh, auth } } or null.
 * `endpointOk` defaults to knownPushEndpoint; pass `() => true` to accept any https endpoint.
 */
export function validSubscription(sub, { endpointOk = knownPushEndpoint } = {}) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = String(sub.endpoint || '');
  const p256dh = String(sub.keys?.p256dh || '');
  const auth = String(sub.keys?.auth || '');
  if (endpoint.length > 1024 || !endpoint.startsWith('https://') || !endpointOk(endpoint)) return null;
  if (!/^[A-Za-z0-9_-]+=*$/.test(p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(auth)) return null;
  const pk = unb64u(p256dh);
  if (pk.length !== 65 || pk[0] !== 4 || unb64u(auth).length !== 16) return null;
  return { endpoint, keys: { p256dh: b64u(pk), auth: b64u(unb64u(auth)) } };
}

/**
 * Encrypt `payload` (an object is sent as JSON) and POST it to the subscription's endpoint.
 *   vapid    { subject, privateKey, publicKey? }
 *   ttl      seconds the push service may hold the message (default 1 day)
 *   urgency  very-low | low | normal | high
 *   topic    replaces an undelivered message with the same topic (≤ 32 base64url chars)
 * Returns { ok, status, gone } — `gone` (404/410) means drop the subscription. Network errors
 * come back as { ok: false, status: 0, error }; nothing throws for a delivery failure.
 */
export async function sendPush(sub, payload, {
  vapid,
  ttl = 24 * 3600,
  urgency = 'normal',
  topic,
  timeoutMs = 10000,
  fetchImpl = (...a) => fetch(...a),
  now = Date.now(),
} = {}) {
  if (!vapid?.privateKey || !vapid?.subject) throw new Error('sendPush needs vapid { subject, privateKey }');
  if (!sub?.endpoint || !sub?.keys) throw new Error('sendPush needs a subscription { endpoint, keys }');
  if (!['very-low', 'low', 'normal', 'high'].includes(urgency)) throw new Error(`bad urgency ${urgency}`);
  if (topic != null && !/^[A-Za-z0-9_-]{1,32}$/.test(String(topic))) throw new Error('topic must be 1-32 base64url characters');
  const text = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  const body = encryptPayload(text, sub.keys);
  const headers = {
    authorization: vapidAuthorization(sub.endpoint, { ...vapid, now }),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(Math.max(0, Math.floor(ttl))),
    urgency,
  };
  if (topic != null) headers.topic = String(topic);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body, signal: ac.signal });
    const status = res.status;
    return { ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String(e?.name === 'AbortError' ? 'timed out' : e?.message || e) };
  } finally { clearTimeout(t); }
}
