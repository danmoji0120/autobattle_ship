// Optional retention for finished company-logistics jobs (LOGISTICS_JOB_RETAIN, off by default).
//
// Finished jobs are never read by dispatch, procurement or valuation once they hold no goods; they remain only
// as history in the owner's logistics panel. With retention on, each company keeps its newest `keep` finished
// jobs and older ones are removed. A job is never removed while it could still matter:
//   • its state is not terminal ('complete' / 'cancelled'),
//   • it has a ship assigned, or any ship still points at it (s.logisticsJob),
//   • it holds reserved stock or carried cargo (exactly zero required).
// Removal does not change any other record, so the world continues identically apart from the history list.

import type { WorldState } from './types';

export function pruneLogisticsJobs(st: WorldState, keep: number): number {
  const jobs = st.logisticsJobs;
  if (!jobs || !(keep >= 0)) return 0;
  const referenced = new Set<string>();
  for (const s of Object.values(st.ships)) if (s.logisticsJob) referenced.add(s.logisticsJob);
  const finished = new Map<string, { id: string; updated: number; order: number }[]>();
  let order = 0;
  for (const j of Object.values(jobs)) {
    order++;
    if (j.state !== 'complete' && j.state !== 'cancelled') continue;
    if (j.ship || referenced.has(j.id) || j.reserved !== 0 || j.carried !== 0) continue;
    let l = finished.get(j.owner); if (!l) finished.set(j.owner, l = []);
    l.push({ id: j.id, updated: j.updated, order });
  }
  let removed = 0;
  for (const l of finished.values()) {
    if (l.length <= keep) continue;
    // newest first (last update, then creation order)
    l.sort((a, b) => b.updated - a.updated || b.order - a.order);
    for (const x of l.slice(keep)) { delete jobs[x.id]; removed++; }
  }
  return removed;
}
