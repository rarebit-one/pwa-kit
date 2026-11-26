import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushStatus, subscribePush, unsubscribePush, pwaKitB64uToBytes } from '../src/client.mjs';

const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const OTHER = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';

function env({ permission = 'default', answer = 'granted', existing = null } = {}) {
  const log = { prompts: 0, subscribed: [], unsubscribed: 0 };
  let current = existing;
  const mkSub = (key, endpoint = 'https://fcm.googleapis.com/fcm/send/dev1') => ({
    endpoint,
    options: { applicationServerKey: key ? pwaKitB64uToBytes(key).buffer : null },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => { log.unsubscribed++; current = null; return true; },
  });
  if (existing) current = mkSub(existing);
  const NotificationImpl = { permission, requestPermission: async () => { log.prompts++; NotificationImpl.permission = answer; return answer; } };
  const reg = { pushManager: {
    getSubscription: async () => current,
    subscribe: async ({ applicationServerKey, userVisibleOnly }) => { log.subscribed.push({ userVisibleOnly, len: applicationServerKey.length }); current = mkSub(KEY); return current; },
  } };
  return { log, opts: { sw: { ready: Promise.resolve(reg) }, NotificationImpl, hasPushManager: true } };
}

test('pwaKitB64uToBytes decodes an unpadded base64url key', () => {
  const b = pwaKitB64uToBytes(KEY);
  assert.equal(b.length, 65);
  assert.equal(b[0], 4);
});

test('pushStatus: unsupported, denied, off, subscribed', async () => {
  assert.equal((await pushStatus({ sw: undefined, NotificationImpl: undefined, hasPushManager: false })).state, 'unsupported');
  assert.equal((await pushStatus(env({ permission: 'denied' }).opts)).state, 'denied');
  assert.equal((await pushStatus(env().opts)).state, 'off');
  const s = await pushStatus(env({ permission: 'granted', existing: KEY }).opts);
  assert.deepEqual(s, { state: 'subscribed', permission: 'granted', endpoint: 'https://fcm.googleapis.com/fcm/send/dev1' });
});

test('subscribePush asks once, subscribes with the key, and returns the JSON subscription', async () => {
  const e = env();
  const r = await subscribePush({ vapidPublicKey: KEY, ...e.opts });
  assert.equal(r.ok, true);
  assert.equal(r.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/dev1');
  assert.equal(e.log.prompts, 1);
  assert.deepEqual(e.log.subscribed, [{ userVisibleOnly: true, len: 65 }]);
});

test('subscribePush reports a refusal or a dismissal without subscribing', async () => {
  const d = env({ answer: 'denied' });
  assert.deepEqual(await subscribePush({ vapidPublicKey: KEY, ...d.opts }), { ok: false, reason: 'denied' });
  const x = env({ answer: 'default' });
  assert.deepEqual(await subscribePush({ vapidPublicKey: KEY, ...x.opts }), { ok: false, reason: 'dismissed' });
  assert.equal(d.log.subscribed.length + x.log.subscribed.length, 0);
  assert.equal((await subscribePush({ ...env().opts })).reason, 'failed');
  assert.equal((await subscribePush({ vapidPublicKey: KEY, sw: undefined, NotificationImpl: undefined, hasPushManager: false })).reason, 'unsupported');
});

test('subscribePush keeps a subscription made with the same key and replaces one made with another', async () => {
  const same = env({ permission: 'granted', existing: KEY });
  assert.equal((await subscribePush({ vapidPublicKey: KEY, ...same.opts })).ok, true);
  assert.equal(same.log.subscribed.length, 0);
  assert.equal(same.log.unsubscribed, 0);
  const other = env({ permission: 'granted', existing: OTHER });
  assert.equal((await subscribePush({ vapidPublicKey: KEY, ...other.opts })).ok, true);
  assert.equal(other.log.unsubscribed, 1);
  assert.equal(other.log.subscribed.length, 1);
});

test('unsubscribePush returns the dropped endpoint, or null', async () => {
  const e = env({ permission: 'granted', existing: KEY });
  assert.equal(await unsubscribePush(e.opts), 'https://fcm.googleapis.com/fcm/send/dev1');
  assert.equal(e.log.unsubscribed, 1);
  assert.equal(await unsubscribePush(e.opts), null);
});
