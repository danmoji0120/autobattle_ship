// P12.5: switch a world to automatic logistics. Idempotent; never creates, destroys or moves goods.
// New worlds call it at creation (nothing to convert). Existing saves are converted only by an
// explicit, separately approved step — scripts/logistics/p125-convert-check.ts runs it on a copy.
import type { WorldSim } from './sim';
import type { WShip } from './types';
import { cargoSum, qty } from './types';
import { growthOn } from './hullops';
import type { LogisticsJob } from './autonomousLogistics';
import { routeShips } from './logistics';
import { defaultProcurementPolicy } from './procurement';

export interface AutoLogisticsConversion {
  already: boolean;
  /** construction / production supply / one-way transfer routes replaced by demand-based logistics */
  routesConverted: string[];
  /** repeating sale or transfer loops the player set up: kept on the legacy path (pause / cancel only) */
  routesCompat: string[];
  /** cargo aboard route ships, now tracked by a shipment to the same destination */
  manifestJobs: { route: string; ship: string; job: string; item: string; amount: number }[];
  /** the unfinished one-way remainder of a transfer route, as one queued shipment */
  remainderJobs: { route: string; job?: string; amount: number; error?: string }[];
  /** direct `haul` orders released; their ships deliver what they carry to the order's destination */
  haulGroups: { group: string; to: string; ships: string[] }[];
}

type Host = Pick<WorldSim, 'st' | 'time' | 'id'>;
export function enableAutoLogistics(h: Host): AutoLogisticsConversion {
  const out: AutoLogisticsConversion = { already: h.st.logisticsV === 1, routesConverted: [], routesCompat: [], manifestJobs: [], remainderJobs: [], haulGroups: [] };
  if (out.already) return out;
  if (!growthOn(h.st)) throw new Error('automatic logistics needs a growth world');
  const jobs = (): Record<string, LogisticsJob> => (h.st.logisticsJobs ??= {});
  const blank = (o: Partial<LogisticsJob> & Pick<LogisticsJob, 'owner' | 'from' | 'to' | 'item' | 'kind' | 'amount'>): LogisticsJob => ({
    id: h.id('lj'), priority: 7, repeat: false, created: h.time, updated: h.time, state: 'queued', reserved: 0, carried: 0, delivered: 0, cycleDelivered: 0, lost: 0, withdrawn: 0, earned: 0, cycles: 0, ...o,
  });
  for (const r of Object.values(h.st.logistics ?? {}).sort((a, b) => a.id.localeCompare(b.id))) {
    const c = r.config;
    if (c.mode === 'sell' || c.mode === 'transfer' && c.repeat) { r.compat = true; out.routesCompat.push(r.id); continue; }
    // cargo already aboard keeps its destination: a shipment tracks it to the same station
    for (const [shipId, m] of Object.entries(r.manifests).sort((a, b) => a[0].localeCompare(b[0]))) {
      const s = h.st.ships[shipId];
      if (!s || s.owner !== r.owner || m.amount <= 0) continue;
      const amount = Math.min(m.amount, qty(s.cargo, m.item)); if (amount <= 0) continue;
      const j = blank({ owner: r.owner, from: m.from, to: m.to, item: m.item, kind: m.mode === 'construction' ? 'construction' : 'transfer', amount, state: 'active', ship: s.id, carried: amount });
      jobs()[j.id] = j; s.logisticsJob = j.id;
      if (s.cargoWork?.key.startsWith(`route:${r.id}:`)) delete s.cargoWork;
      out.manifestJobs.push({ route: r.id, ship: s.id, job: j.id, item: m.item, amount });
    }
    if (c.mode === 'transfer' && r.state === 'running') {
      const left = routeShips(h.st, r).filter(s => !r.done.includes(s.id) && !r.manifests[s.id]).length * c.amount;
      if (left > 0) {
        const a = h.st.stations[c.from], b = h.st.stations[c.to];
        if (a && b) { const j = blank({ owner: r.owner, from: c.from, to: c.to, item: c.item, kind: 'transfer', amount: left, priority: 5 }); jobs()[j.id] = j; out.remainderJobs.push({ route: r.id, job: j.id, amount: left }); }
        else out.remainderJobs.push({ route: r.id, amount: left, error: '정거장 소실 — 변환하지 않음' });
      }
    }
    if (c.mode === 'construction' || c.mode === 'supply') { const co = h.st.companies[r.owner]; if (co) co.procurement ??= defaultProcurementPolicy(); }
    const g = h.st.groups[r.group];
    if (g?.op.k === 'haul' && g.op.route === r.id) { g.op = { k: 'idle' }; g.status = '자동 물류로 전환'; delete g.march; }
    for (const s of routeShips(h.st, r)) if (s.cargoWork?.key.startsWith(`route:${r.id}:`)) delete s.cargoWork;
    delete h.st.logistics![r.id]; out.routesConverted.push(r.id);
  }
  // direct haul orders: release the group; anything aboard is delivered to the order's destination
  for (const g of Object.values(h.st.groups).sort((a, b) => a.id.localeCompare(b.id))) {
    if (g.op.k !== 'haul' || g.op.route || h.st.companies[g.owner]?.kind !== 'player') continue;
    const to = g.op.to, ships: string[] = [];
    const walk = (id: string) => { const x = h.st.groups[id]; if (!x) return; for (const sid of x.shipIds) { const s: WShip | undefined = h.st.ships[sid]; if (s && cargoSum(s.cargo) > 0 && !s.logisticsJob) { s.logisticsStow = to; ships.push(s.id); } if (s?.cargoWork?.key.startsWith('haul:')) delete s.cargoWork; } for (const c of x.childIds) if (!h.st.groups[c]?.override) walk(c); };
    walk(g.id);
    g.op = { k: 'idle' }; g.status = '자동 물류로 전환'; delete g.march;
    out.haulGroups.push({ group: g.id, to, ships });
  }
  h.st.logisticsV = 1;
  return out;
}
