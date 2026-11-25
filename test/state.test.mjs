import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, emptyState, liveFacts, diffFacts } from '../src/state.mjs';

const now = 1_000_000;

test('last writer wins per key; older writes lose; equal writes are no-ops', () => {
  let { state, applied } = applyOps(emptyState(), [{ k: 'a', v: 1, at: now - 10 }], { by: 'x', now });
  assert.equal(applied, 1);
  assert.equal(state.rev, 1);
  ({ state, applied } = applyOps(state, [{ k: 'a', v: 2, at: now - 20 }], { now }));
  assert.equal(applied, 0);
  assert.equal(state.items.a.v, 1);
  assert.equal(state.rev, 1, 'rev only moves when something applied');
  ({ state, applied } = applyOps(state, [{ k: 'a', v: 1, at: now - 10 }], { now }));
  assert.equal(applied, 0);
  ({ state } = applyOps(state, [{ k: 'a', v: 3, at: now - 5 }], { by: 'y', now }));
  assert.deepEqual(state.items.a, { v: 3, at: now - 5, by: 'y', p: 1 });
});

test('timestamps are capped near now, so a fast clock cannot pin a fact forever', () => {
  const { state } = applyOps(emptyState(), [{ k: 'a', v: 1, at: now + 10 ** 9 }], { now });
  assert.equal(state.items.a.at, now + 60_000);
  const { state: s2 } = applyOps(emptyState(), [{ k: 'a', v: 1 }], { now });
  assert.equal(s2.items.a.at, now, 'missing at defaults to now');
});

test('the key validator hook rejects with a reason', () => {
  const validate = (k, v) => (k.startsWith('ok:') ? (typeof v === 'number' || v === null ? '' : 'bad value') : 'unknown kind');
  const { state, rejected } = applyOps(emptyState(), [{ k: 'ok:1', v: 1 }, { k: 'no:1', v: 1 }, { k: 'ok:2', v: 'x' }, { k: '__proto__', v: 1 }, { k: 5 }], { validate, now });
  assert.deepEqual(Object.keys(state.items), ['ok:1']);
  assert.deepEqual(rejected.map((r) => r.why), ['unknown kind', 'bad value', 'bad key', 'bad key']);
});

test('limits: op count and item count', () => {
  const ops = Array.from({ length: 5 }, (_, i) => ({ k: `k${i}`, v: i }));
  const { state, rejected } = applyOps(emptyState(), ops, { now, limits: { ops: 4, items: 3 } });
  assert.equal(Object.keys(state.items).length, 3);
  assert.deepEqual(rejected, [{ k: 'k3', why: 'state is full' }]);
});

test('clearing leaves a tombstone; liveFacts and diffFacts', () => {
  let { state } = applyOps(emptyState(), [{ k: 'a', v: 1, at: 1 }, { k: 'b', v: 2, at: 1 }], { now });
  ({ state } = applyOps(state, [{ k: 'a', v: null, at: 2 }], { now }));
  assert.deepEqual(liveFacts(state), { b: 2 });
  assert.equal(state.items.a.v, null);
  assert.deepEqual(diffFacts({ a: 1, b: 2 }, { b: 3, c: 4 }, 9), [{ k: 'b', v: 3, at: 9 }, { k: 'c', v: 4, at: 9 }, { k: 'a', v: null, at: 9 }]);
});
