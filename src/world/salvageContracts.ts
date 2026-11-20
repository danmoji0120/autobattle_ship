// A-3.2b salvage contracts: posting, acceptance with a reward reserved from the station's funds, delivery of
// goods recovered from the target (ship-side provenance), payment from the reservation, refund on failure.
// No money is created: the reward moves station → contract (escrow) → company, or back to the station.
// See docs/A3_2B_FIRST_SALVAGE.md §4.
import type { WorldSim } from './sim';
import type { Contract, Station, WShip } from './types';
import { qty, takec } from './types';
import { DERELICT_CFG, contractText, derelictsOn, salvageOffer, spawnDerelict } from './derelicts';
import { emit, watchMoney } from './observe';
import { effSec } from './security';
import { itemName } from './industry';

type Host = WorldSim;
const C = DERELICT_CFG.contract;

/** open salvage contracts the stations keep posted (called from the contracts pass) */
export function postSalvageContracts(h: Host) {
  const w = h.st, D = w.derelicts; if (!derelictsOn(w) || !D) return;
  let open = Object.values(w.contracts).filter(k => !k.done && k.kind === 'salvage').length;
  // salvagers' home stations keep a follow-up job within reach even when distant boards fill the world cap
  const homes = new Set(Object.values(w.companies).filter(c => c.kind === 'player' && c.background === 'salvager').map(c => c.homeStation));
  const starters = new Set(Object.values(w.companies).filter(c => c.kind === 'player' && c.background === 'salvager' && !c.milestones.includes('first_salvage')).map(c => c.homeStation));
  const stations = Object.values(w.stations);
  for (const st of [...stations.filter(s => starters.has(s.id)), ...stations.filter(s => !starters.has(s.id))]) {
    if (open >= C.maxOpen + (homes.size ? C.homeExtra : 0)) return;
    if (open >= C.maxOpen && !homes.has(st.id)) continue;
    if (!st.public || !st.services.contracts || st.funds === undefined) continue;
    if (Object.values(w.contracts).some(k => !k.done && k.kind === 'salvage' && k.stationId === st.id)) continue;
    if ((D.posts[st.id] ?? -Infinity) > h.time || !starters.has(st.id) && !h.rng.chance(C.chance)) continue;
    const o = salvageOffer(w, st, h.time, () => h.rng.next(), s => effSec(s), starters.has(st.id));
    D.posts[st.id] = h.time + C.cooldown;   // tried: wait the cooldown either way (no posting loop)
    if (typeof o === 'string') continue;
    let target = o.target;
    const draft = { stationId: st.id, kind: 'salvage' as const, title: '', desc: '', reward: o.reward, rep: 2, res: o.res as Contract['res'], amount: o.amount };
    const id = h.offerContract({ ...draft, ...(o.spawn ? { spawned: true } : {}) }, C.board);
    if (o.spawn) { target = spawnDerelict(w, { ...o.spawn, contract: id }); D.posts[`spawn:${st.id}`] = h.time; }
    else target.contract = id;
    const k = w.contracts[id]; open++;
    k.target = target.id;
    Object.assign(k, contractText(w, k, st, target));
  }
}

/** accept: reserve the reward from the station's funds (refused when the station cannot cover it) */
export function acceptSalvageContract(h: Host, company: string, k: Contract): string | null {
  const st = h.st.stations[k.stationId], x = k.target ? h.st.wrecks?.[k.target] : undefined;
  if (!st || !x) return '인양 대상이 이미 사라졌습니다';
  if ((st.funds ?? 0) < k.reward) return `${st.name} 예산 부족 — 보수를 예약할 수 없습니다`;
  watchMoney(h.st, 'contract_escrow', { company, station: st.id }, () => { st.funds! -= k.reward; k.escrow = k.reward; });
  // the client gives the taker its survey of the target
  if (!x.seen.includes(company)) x.seen.push(company);
  return null;
}

/** give back a reservation (failure, expiry, target gone) */
export function refundSalvage(h: Host, k: Contract) {
  if (!k.escrow) return;
  const st = h.st.stations[k.stationId];
  watchMoney(h.st, 'contract_refund', { company: k.takenBy ?? undefined, station: k.stationId }, () => { if (st) st.funds = (st.funds ?? 0) + k.escrow!; k.escrow = 0; });
}

const fromTarget = (s: WShip, item: string, target: string) => Math.min(s.salvSrc?.[item]?.[target] ?? 0, qty(s.salvaged ?? {}, item), qty(s.cargo, item));

/** per pass: unlink finished contracts, end ones whose target is gone with nothing of it aboard */
export function salvageContractsTick(h: Host) {
  const w = h.st;
  for (const k of Object.values(w.contracts)) {
    if (k.kind !== 'salvage') continue;
    const x = k.target ? w.wrecks?.[k.target] : undefined;
    if (k.done) { if (x?.contract === k.id) delete x.contract; if (k.escrow) refundSalvage(h, k); continue; }
    if (x) continue;
    // target exhausted or decayed
    const aboard = k.takenBy ? Object.values(w.ships).some(s => s.owner === k.takenBy && fromTarget(s, k.res!, k.target!) > 0) : false;
    if (aboard) continue;
    k.done = true; k.ended = '대상 소멸'; k.outcome = 'void';
    if (k.takenBy) {
      refundSalvage(h, k);
      emit(w, { kind: 'contract', amount: 1, reason: 'fail', company: k.takenBy, item: k.kind, station: k.stationId });
      h.ev('warn', `인양 계약 종료: ${k.title} — 대상이 소멸·소진되어 더 납품할 수 없습니다 (보수 예약 반환, 신용 불이익 없음 · 납품 ${Math.round(k.progress)}/${k.amount})`, { company: k.takenBy });
    }
  }
}

/** record where recovered goods came from (called by the salvage engine for every unit moved aboard) */
export function noteSalvageSource(w: Host['st'], s: WShip, key: string, site: string, n: number, value: number) {
  const m = ((s.salvSrc ??= {})[key] ??= {}); m[site] = (m[site] ?? 0) + n;
  const co = w.companies[s.owner]; if (!co || co.kind !== 'player') return;
  const r = (co.salvage ??= { units: 0, value: 0, items: {}, sites: [] });
  r.units += n; r.value += value; r.items[key] = (r.items[key] ?? 0) + n; r.first ??= w.time;
  if (!r.sites.includes(site)) { r.sites.push(site); if (r.sites.length > 40) r.sites.shift(); }
}

/** keep provenance within what is really aboard as salvage (goods sold / jettisoned elsewhere drop out first-in) */
export function trimSalvageSource(s: WShip) {
  if (!s.salvSrc) return;
  for (const k of Object.keys(s.salvSrc)) {
    const have = Math.min(qty(s.salvaged ?? {}, k), qty(s.cargo, k)), m = s.salvSrc[k];
    let tot = Object.values(m).reduce((a, n) => a + n, 0);
    for (const id of Object.keys(m)) { if (tot <= have + 1e-9) break; const cut = Math.min(m[id], tot - have); m[id] -= cut; tot -= cut; if (m[id] <= 1e-9) delete m[id]; }
    if (!Object.keys(m).length) delete s.salvSrc[k];
  }
  if (!Object.keys(s.salvSrc).length) delete s.salvSrc;
}

/** contracts this ship can deliver to at this station now */
export function deliverableContracts(h: Pick<Host, 'st'>, s: WShip, st: Station): Contract[] {
  if (!s.salvSrc) return [];
  return Object.values(h.st.contracts).filter(k => k.kind === 'salvage' && !k.done && k.takenBy === s.owner && k.stationId === st.id && k.target && fromTarget(s, k.res!, k.target) > 0);
}

/** a station some ship of the group owes a salvage delivery to (the unloading run goes there first) */
export function contractStationFor(h: Pick<Host, 'st'>, ships: WShip[]): string | undefined {
  for (const s of ships) {
    if (!s.salvSrc) continue;
    for (const k of Object.values(h.st.contracts)) if (k.kind === 'salvage' && !k.done && k.takenBy === s.owner && k.target && fromTarget(s, k.res!, k.target) > 0) return k.stationId;
  }
  return undefined;
}

/** at unloading: hand over goods recovered from the target to the client (consumed), up to what is owed */
export function deliverSalvage(h: Host, s: WShip, st: Station): number {
  trimSalvageSource(s);
  let moved = 0;
  for (const k of deliverableContracts(h, s, st)) {
    const item = k.res!, n = Math.min(fromTarget(s, item, k.target!), (k.amount ?? 0) - k.progress);
    if (n <= 1e-9) continue;
    takec(s.cargo, item, n); takec(s.salvaged!, item, n);
    const m = s.salvSrc![item]; m[k.target!] -= n; if (m[k.target!] <= 1e-9) delete m[k.target!];
    k.progress += n; moved += n;
    emit(h.st, { kind: 'consume', reason: 'contract_delivery', item, amount: n, company: s.owner, station: st.id, ref: k.id });
    h.ev('info', `인양 계약 납품: ${itemName(item)} ${Math.round(n)} → ${st.name} (${Math.round(k.progress)}/${k.amount})`, { company: s.owner, pos: st.pos });
    if (k.progress >= (k.amount ?? 0) - 1e-6) h.completeContract(k);
  }
  if (s.salvaged) for (const key of Object.keys(s.salvaged)) if (qty(s.salvaged, key) <= 1e-9) delete s.salvaged[key];
  if (s.salvaged && !Object.keys(s.salvaged).length) delete s.salvaged;
  trimSalvageSource(s);
  return moved;
}
