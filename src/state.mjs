// Last-writer-wins shared state: a flat map of small facts, each stamped with when it was set
// and by whom.
//
//   { rev, items: { "<key>": { v, at, by, p? } } }
//
// `v: null` clears a fact (the entry stays as a tombstone so an older write can't revive it).
// `p` keeps the previous value so the latest change can be undone once.
//
// The caller owns the schema: pass `validate(k, v)` returning "" for an acceptable fact or a
// short reason otherwise. Without one, any key of up to `maxKey` characters is accepted.

export const DEFAULT_LIMITS = { ops: 200, items: 4000, key: 80, by: 40, futureMs: 60_000 };

export const emptyState = () => ({ rev: 0, items: {} });

const basicCheck = (k, maxKey) => (typeof k !== 'string' || k.length === 0 || k.length > maxKey || k === '__proto__' ? 'bad key' : '');

/**
 * Apply ops ([{ k, v, at }]) → { state, applied, rejected }.
 * An op wins when it is at least as new as the fact it replaces. Timestamps are capped at
 * `now + futureMs`, so a client with a fast clock can't write a fact nothing could overwrite.
 */
export function applyOps(state, ops, { by = '', now = Date.now(), validate, limits = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const items = Object.assign(Object.create(null), state?.items || {});
  const rejected = [];
  let applied = 0;
  for (const op of Array.isArray(ops) ? ops.slice(0, L.ops) : []) {
    const k = op?.k;
    const why = basicCheck(k, L.key) || (validate ? validate(k, op.v ?? null) : '');
    if (why) { rejected.push({ k: String(k).slice(0, L.key), why }); continue; }
    const v = op.v === undefined ? null : op.v;
    const at = Math.min(Number.isFinite(op.at) && op.at > 0 ? Math.floor(op.at) : now, now + L.futureMs);
    const cur = items[k];
    if (cur && cur.at > at) continue;
    if (cur && cur.at === at && JSON.stringify(cur.v) === JSON.stringify(v)) continue;
    if (!cur && Object.keys(items).length >= L.items) { rejected.push({ k, why: 'state is full' }); continue; }
    items[k] = { v, at, by: String(by).slice(0, L.by), ...(cur ? { p: cur.v } : {}) };
    applied++;
  }
  return { state: { rev: (state?.rev || 0) + (applied ? 1 : 0), items: { ...items } }, applied, rejected };
}

/** The live facts as a flat { key: value } (cleared ones left out). */
export function liveFacts(state) {
  const out = {};
  for (const [k, it] of Object.entries(state?.items || {})) if (it && it.v !== null) out[k] = it.v;
  return out;
}

/** The ops that turn flat facts `from` into `to`, stamped `at`. */
export function diffFacts(from = {}, to = {}, at = Date.now()) {
  const ops = [];
  for (const [k, v] of Object.entries(to)) if (JSON.stringify(from[k]) !== JSON.stringify(v)) ops.push({ k, v, at });
  for (const k of Object.keys(from)) if (!(k in to)) ops.push({ k, v: null, at });
  return ops;
}
