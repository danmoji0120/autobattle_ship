// Station construction plans: plan → materials secured → construction → completed.
//
// Accounting rules (the server is the only one that mutates; the client uses the same helpers to
// display exactly what the server will do):
//  - Construction draws only on the owner's storage AT THAT STATION. Cargo counts once unloaded.
//  - Credits are paid when a plan is registered. Materials do not have to be there yet.
//  - Each tick, free storage is handed to waiting plans in queue order (paused plans and plans whose
//    prerequisite is not built yet are skipped). What a plan takes is moved OUT of storage into the
//    plan's `reserved` pool, so it cannot be spent twice — not by another plan, a ship purchase, a sale
//    or a haul.
//  - A plan whose materials are all secured is built: one at a time per station, first in queue first.
//    Work moves materials from `reserved` into `used` in proportion to progress.
//  - Pause: keeps its reservation, takes nothing more, no work. Resume undoes that.
//  - Cancel: reserved materials go back to storage; materials already worked in are lost; credits
//    are refunded for the unbuilt fraction (all of it if work never started).

import type { Station, Module, Cargo } from './types';
import { MODULES } from './data';

export type Mat = 'alloy' | 'crystal';
export const MATS: Mat[] = ['alloy', 'crystal'];
const EPS = 1e-6;

/** fill in plan bookkeeping on an unbuilt module (also migrates pre-plan saves) */
export function normPlan(m: Module, id: () => string): Module {
  if (m.built) return m;
  const md = MODULES[m.kind];
  m.id ??= id();
  m.used ??= { alloy: md.alloy * m.progress, crystal: md.crystal * m.progress };
  m.reserved ??= { alloy: 0, crystal: 0 };
  m.paid ??= md.credits;
  m.paused ??= false;
  return m;
}

export const need = (m: Module, r: Mat) => MODULES[m.kind][r];
/** still to be worked into the structure */
export const remaining = (m: Module, r: Mat) => Math.max(0, need(m, r) - (m.used?.[r] ?? 0));
/** not yet secured */
export const missing = (m: Module, r: Mat) => Math.max(0, remaining(m, r) - (m.reserved?.[r] ?? 0));
export const isSecured = (m: Module) => MATS.every(r => missing(m, r) <= EPS);
export const prereqBuilt = (st: Station, m: Module) => { const rq = MODULES[m.kind].requires; return !rq || st.modules.some(o => o.kind === rq && o.built); };
export const plans = (st: Station) => st.modules.filter(m => !m.built);

export type PlanState = 'built' | 'paused' | 'prereq' | 'materials' | 'queued' | 'building';
export const PLAN_STATE_NAME: Record<PlanState, string> = {
  built: '가동 중', paused: '일시 정지', prereq: '선행 시설 대기', materials: '자재 대기 중', queued: '자재 확보 — 건설 순서 대기', building: '건설 중',
};

/** the plan being built right now (one per station) */
export function activePlan(st: Station): Module | undefined {
  return st.modules.find(m => !m.built && !m.paused && prereqBuilt(st, m) && isSecured(m));
}

export function planState(st: Station, m: Module): PlanState {
  if (m.built) return 'built';
  if (m.paused) return 'paused';
  if (!prereqBuilt(st, m)) return 'prereq';
  if (!isSecured(m)) return 'materials';
  return activePlan(st) === m ? 'building' : 'queued';
}

/** hand free storage to waiting plans in queue order; returns the plans that just became fully secured */
export function allocate(st: Station, store: Cargo): Module[] {
  const done: Module[] = [];
  for (const m of st.modules) {
    if (m.built || m.paused || !prereqBuilt(st, m) || !m.reserved) continue;
    const was = isSecured(m);
    for (const r of MATS) {
      const take = Math.min(missing(m, r), Math.max(0, store[r]));
      if (take > 0) { store[r] -= take; m.reserved[r] += take; }
    }
    if (!was && isSecured(m) && !m.secured) { m.secured = true; done.push(m); }
  }
  return done;
}

/** do `rate` (fraction of the whole job) of work on a secured plan; true when it completes */
export function advance(m: Module, rate: number): boolean {
  if (m.built || !m.reserved || !m.used) return false;
  const r0 = Math.min(rate, 1 - m.progress);
  for (const r of MATS) {
    const amt = Math.min(m.reserved[r], need(m, r) * r0);
    m.reserved[r] -= amt; m.used[r] += amt;
  }
  m.progress = Math.min(1, m.progress + r0);
  if (m.progress >= 1 - 1e-9) {
    m.progress = 1; m.built = true;
    // any rounding crumbs still reserved go back with the plan bookkeeping cleared
    return true;
  }
  return false;
}

/** cancel a plan: what goes back where */
export function cancelRefund(m: Module): { credits: number; alloy: number; crystal: number } {
  return {
    credits: Math.round((m.paid ?? 0) * (m.progress <= 0 ? 1 : 1 - m.progress)),
    alloy: m.reserved?.alloy ?? 0, crystal: m.reserved?.crystal ?? 0,
  };
}

/** what still needs to arrive at this station before every unpaused plan is secured */
export function queueShortfall(st: Station): Record<Mat, number> {
  const out = { alloy: 0, crystal: 0 };
  for (const m of plans(st)) if (!m.paused) for (const r of MATS) out[r] += missing(m, r);
  return out;
}
