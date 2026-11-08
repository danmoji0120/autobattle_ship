// Transient observation and transaction boundaries. Observers never consume RNG or alter gameplay.
// Deferred gameplay payments run identically with or without an observer. Nothing here is serialized.
import type { WorldState } from './types';
export interface Observation {
  kind: string; amount: number; baseline?: number; method?: string; reason?: string; company?: string; group?: string; ship?: string;
  station?: string; system?: string; item?: string; ref?: string; from?: string; to?: string; value?: number;
}
type Sink = (event: Observation, time: number) => void;
const sinks = new WeakMap<WorldState, { sink: Sink; cost?: (ms: number) => void; metric?: (event: Observation, amount: number, time: number) => void }>();
const depth = new WeakMap<WorldState, number>();
const deferred = new WeakMap<WorldState, (() => void)[]>();
export const inTransaction = (w: WorldState) => !!depth.get(w);
export function afterTransaction(w: WorldState, fn: () => void) {
  if (!inTransaction(w)) { fn(); return; }
  let list = deferred.get(w); if (!list) { list = []; deferred.set(w, list); } list.push(fn);
}
let observedMs = 0;
export const observationCostMs = () => observedMs;
/** Account observer work once, including nested emit calls, outside the NPC simulation budget. */
export function observedWork<T>(fn: () => T): T {
  const start = performance.now(), before = observedMs;
  try { return fn(); } finally { observedMs += Math.max(0, performance.now() - start - (observedMs - before)); }
}
export const observing = (w: WorldState) => sinks.has(w);
export function observeWorld(w: WorldState, sink: Sink, cost?: (ms: number) => void, metric?: (event: Observation, amount: number, time: number) => void) { sinks.set(w, { sink, cost, metric }); return () => sinks.delete(w); }
export function emit(w: WorldState, event: Observation) {
  // Observability must not interrupt gameplay, including during a failed analytics write.
  const sink = sinks.get(w); if (!sink) return;
  const start = performance.now(), before = observedMs;
  try { sink.sink(event, w.time); } catch { /* collector exposes its own health counters */ }
  finally { const ms = Math.max(0, performance.now() - start - (observedMs - before)); observedMs += ms; sink.cost?.(ms); }
}
export function moneySupply(w: WorldState) {
  return Object.values(w.companies).reduce((n, co) => n + co.credits, 0) + Object.values(w.stations).reduce((n, st) => n + (st.funds ?? 0), 0);
}
function balances(w: WorldState) {
  return new Map([...Object.values(w.companies).map(co => [`co:${co.id}`, co.credits] as const), ...Object.values(w.stations).filter(st => st.funds !== undefined).map(st => [`st:${st.id}`, st.funds!] as const)]);
}
/** Observe a synchronous atomic gameplay operation. Nested operations count once. Matching debits
 * and credits are transfers; unmatched deltas are actual currency creation/destruction. This also
 * observes budget caps and credit-on-service-accrual exactly as the existing game implements them. */
export function watchMoney<T>(w: WorldState, reason: string, meta: Partial<Observation>, fn: () => T): T {
  if (depth.get(w)) return fn();
  const before = observing(w) ? observedWork(() => balances(w)) : null;
  depth.set(w, 1);
  try { return fn(); } finally {
    depth.delete(w);
    if (before) observedWork(() => {
    const after = balances(w), plus: [string, number][] = [], minus: [string, number][] = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const d = (after.get(id) ?? 0) - (before.get(id) ?? 0);
      if (d > 0) plus.push([id, d]); else if (d < 0) minus.push([id, -d]);
    }
    for (const debit of minus) for (const credit of plus) {
      const n = Math.min(debit[1], credit[1]); if (n <= 0) continue;
      emit(w, { ...meta, kind: 'currency.transfer', reason, from: debit[0], to: credit[0], amount: n });
      debit[1] -= n; credit[1] -= n;
    }
    for (const [from, amount] of minus) if (amount > 0) emit(w, { ...meta, kind: 'currency.destroy', reason, from, amount });
    for (const [to, amount] of plus) if (amount > 0) emit(w, { ...meta, kind: 'currency.create', reason, to, amount });
    });
    const work = deferred.get(w); deferred.delete(w);
    for (const finish of work ?? []) finish();
  }
}

/** Stable metric identities for hot, scalar deltas. Normal observers still receive fresh events.
 * Call inside metricBatch so timing is measured once for a station, not for every commodity. */
export function emitMetric(w: WorldState, identity: Observation, amount: number) {
  const entry = sinks.get(w); if (!entry) return;
  try { if (entry.metric) entry.metric(identity, amount, w.time); else entry.sink({ ...identity, amount }, w.time); } catch { /* observation is passive */ }
}
export function metricBatch(w: WorldState, fn: () => void) {
  const entry = sinks.get(w); if (!entry) return;
  const start = performance.now(), before = observedMs;
  try { fn(); } finally { const ms = Math.max(0, performance.now() - start - (observedMs - before)); observedMs += ms; entry.cost?.(ms); }
}
