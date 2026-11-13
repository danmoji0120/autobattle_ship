// Faction-economy v2 metrics shared by the scenario scripts: per-faction hourly flows from the ledger.
import type { WorldState, Cargo } from '../../src/world/types';
import { ITEMS } from '../../src/world/industry';
import { rates } from '../../src/world/factionEcon2';
import { priceOf } from '../../src/world/market';

export const val = (c: Cargo | undefined) => Object.entries(c ?? {}).reduce((n, [k, v]) => n + (v ?? 0) * (ITEMS[k]?.price ?? 50), 0);
const dc = (a: Cargo = {}, b: Cargo = {}) => { const o: Cargo = {}; for (const [k, n] of Object.entries(a)) { const d = (n ?? 0) - (b[k] ?? 0); if (Math.abs(d) > 1e-9) o[k] = d; } return o; };
const round = (c: Cargo) => Object.fromEntries(Object.entries(c).filter(([, n]) => Math.abs(n ?? 0) >= .5).map(([k, n]) => [k, Math.round(n!)]));
export type Snap = ReturnType<typeof snapshot>;
export function snapshot(w: WorldState) {
  return { t: w.time, f: Object.fromEntries(Object.values(w.factions ?? {}).map(f => [f.id, { strength: f.strength, infra: f.infra, stock: { ...f.stock }, econ: f.econ ? JSON.parse(JSON.stringify(f.econ)) : undefined }])) };
}
/** flows between two snapshots, per hour, in units and credits (reference prices) */
export function flows(w: WorldState, a: Snap, b: Snap) {
  const hours = Math.max(1e-9, (b.t - a.t) / 3600);
  const out: Record<string, unknown> = {};
  for (const [id, B] of Object.entries(b.f)) {
    const A = a.f[id]; if (!A?.econ || !B.econ) continue;
    const L = B.econ.led, P = A.econ.led, d = (k: string) => dc(L[k], P[k]);
    const f = w.factions![id]; const R = rates(w, f);
    const demand: Cargo = {}; for (const c of [R.base, ...Object.values(R.prog)]) for (const [k, n] of Object.entries(c)) demand[k] = (demand[k] ?? 0) + n!;
    const made = d('made'), ext = d('extracted'), used = d('used'), bought = d('bought'), imported = d('imported'), short = d('short'), exported = d('exported'), war = d('war'), rebuild = d('rebuild'), build = d('build');
    const ownProd = val(made) + val(ext), cons = val(used), buy = val(bought);
    out[id] = {
      strength: +B.strength.toFixed(1), infra: +B.infra.toFixed(1), dev: +B.econ.dev.toFixed(3), eff: +B.econ.eff.toFixed(3), rdy: +B.econ.rdy.toFixed(3), budget: Math.round(B.econ.budget),
      perH: {
        demandValue: Math.round(val(demand)), ownProduction: Math.round(ownProd / hours), consumption: Math.round(cons / hours), purchases: Math.round(buy / hours), imports: Math.round(val(imported) / hours),
        unmet: Math.round(val(short) / hours), exports: Math.round(val(exported) / hours), income: Math.round((L.income - P.income) / hours), exportRev: Math.round((L.exportRev - P.exportRev) / hours),
        spent: Math.round((L.spent - P.spent) / hours), warUse: Math.round(val(war) / hours), rebuildUse: Math.round(val(rebuild) / hours), buildUse: Math.round(val(build) / hours),
        builtStr: +((L.builtStr - P.builtStr) / hours).toFixed(2), lostStr: +((L.lostStr - P.lostStr) / hours).toFixed(2),
      },
      // share of consumption value covered by own production vs purchases
      selfShare: cons > 0 ? +Math.min(1, Math.max(0, (cons - buy) / cons)).toFixed(3) : null,
      stockValue: Math.round(val(B.stock)),
      topShort: Object.entries(short).sort((x, y) => (y[1]! * (ITEMS[y[0]]?.price ?? 50)) - (x[1]! * (ITEMS[x[0]]?.price ?? 50))).slice(0, 4).map(([k, n]) => `${k}:${Math.round(n! / hours)}`),
      topBuy: Object.entries(bought).sort((x, y) => (y[1]! * (ITEMS[y[0]]?.price ?? 50)) - (x[1]! * (ITEMS[x[0]]?.price ?? 50))).slice(0, 4).map(([k, n]) => `${k}:${Math.round(n! / hours)}`),
      war: round(scale(war, 1 / hours)), rebuild: round(scale(rebuild, 1 / hours)),
    };
  }
  return out;
}
const scale = (c: Cargo, k: number): Cargo => Object.fromEntries(Object.entries(c).map(([i, n]) => [i, n! * k]));
/** average sell price and stock fill of key goods over all public markets */
export function marketView(w: WorldState, items: string[]) {
  const o: Record<string, { price: number; fill: number; stock: number }> = {};
  for (const k of items) {
    const ms = Object.values(w.stations).filter(s => s.public && s.market?.[k]).map(s => s.market![k]);
    if (!ms.length) continue;
    o[k] = { price: +(ms.reduce((n, m) => n + priceOf(m, 'sell', true), 0) / ms.length).toFixed(1), fill: +(ms.reduce((n, m) => n + m.stock / m.target, 0) / ms.length).toFixed(2), stock: Math.round(ms.reduce((n, m) => n + m.stock, 0)) };
  }
  return o;
}
export const KEY_GOODS = ['ore', 'titanium_ore', 'gas', 'metal', 'titanium', 'alloy', 'chemicals', 'machinery', 'electronics', 'structure', 'precision', 'armor_plate', 'weapon_parts', 'eq_autocannon', 'eq_medium_gun', 'engine'];
