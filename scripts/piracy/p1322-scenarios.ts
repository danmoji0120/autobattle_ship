// P13.2.2 extra server scenarios (run by p132-server.ts next to S1–S7, same three real WebSocket accounts):
//   S8 split recovery fleet — A's hauler group is assigned to A's raid with the real `lootTender` command (server
//      validation checked with wrong orders first); the raid makes B's hauler jettison; the tender is a party of
//      the truce, recovers the container with the salvage engine and unloads it into a warehouse.
//   S9 target choice — A's lane raid (zone order, no target given) picks the poorer unescorted hauler over a richer
//      one guarded by a separate escort group 900 m away; A's own fleet view carries the estimate. A second lane
//      raid over a zone with only a worthless cargo threatens nobody and says why.
// Starting assets are placed once offline (placeP1322); every later step is a real account command or the
// server's own simulation. Each scenario uses its own items so the accounting is separate.
import type { WorldSim } from '../../src/world/sim';
import type { V } from '../../src/world/types';
import type { Driver, Ids } from './p132-scenarios';

const P = (dx: number, dz: number, a: V): V => ({ x: a.x + dx, y: 0, z: a.z + dz });
export const P1322_ITEMS = { S8: ['alloy', 600], S9a: ['chemicals', 600], S9b: ['gas', 600], S9c: ['silicate', 5] } as const;

export function placeP1322(sim: WorldSim, A: string, B: string, _C: string): Ids {
  const st = sim.st, ast = st.stations.astra.pos;
  const fleet = (o: string, name: string, pos: V, comp: string[]) => {
    const g = sim.newGroup(o, name); g.commanderId = sim.newCommander(o, 2).id;
    comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }); if (cl === 'hauler') s.logisticsExcluded = true; }); return g;
  };
  const hauler = (name: string, pos: V, item: string, n: number) => { const g = fleet(B, name, pos, ['hauler']); (st.ships[g.shipIds[0]].cargo as any)[item] = n; return g; };
  const out: Ids = {};
  // S8: B's hauler holds still; A's raid (2 destroyers) 800 m away (as S5/S6: a hauler that sees warships kilometres
  // away runs for a dock on its own); A's 2-hauler group 1.5 km behind the raid (2.3 km from the hauler: inside tenderR)
  const s8 = P(-45000, -10000, ast);
  const b8 = hauler('B 수송 S8', s8, 'alloy', 600);
  const a8 = fleet(A, 'A 약탈 S8', P(0, -800, s8), ['destroyer', 'destroyer']);
  const t8 = fleet(A, 'A 회수 S8', P(0, -2300, s8), ['hauler', 'hauler']);
  Object.assign(out, { s8b: b8.id, s8bs: b8.shipIds[0], s8a: a8.id, s8t: t8.id });
  // S9: zone centre; rich hauler 3 km east with B's separate escort group 900 m from it; poor hauler 3 km west;
  // A's lane raid 1 km south of the centre (escort 3.2 km away: outside P11 contact)
  const s9 = P(50000, 15000, ast);
  const rich = hauler('B 고가 S9', P(3000, 0, s9), 'chemicals', 600);
  const esc = fleet(B, 'B 호위 S9', P(3000, 900, s9), ['destroyer', 'destroyer', 'frigate']);
  const poor = hauler('B 저가 S9', P(-3000, 0, s9), 'gas', 600);
  const a9 = fleet(A, 'A 항로 약탈 S9', P(0, -1000, s9), ['destroyer', 'destroyer', 'hauler']);
  // S9c: a worthless cargo alone in another zone
  const s9c = P(-40000, 60000, ast);
  const junk = hauler('B 잡화 S9c', s9c, 'silicate', 5);
  const a9c = fleet(A, 'A 항로 약탈 S9c', P(0, -1500, s9c), ['destroyer']);
  Object.assign(out, { s9: JSON.stringify(s9), s9rich: rich.id, s9richS: rich.shipIds[0], s9esc: esc.id, s9escAt: JSON.stringify(P(3000, 900, s9)), s9poor: poor.id, s9poorS: poor.shipIds[0], s9a: a9.id, s9c: JSON.stringify(s9c), s9junk: junk.id, s9junkS: junk.shipIds[0], s9ac: a9c.id });
  return out;
}

type Save = () => any;
const dropOf = (v: any, A: string, name: string) => Object.values<any>(v.drops ?? {}).find(x => x.by === A && x.name.includes(name));
const stored = (w: any, co: string, item: string) => Object.values<any>(w.stations).reduce((n, st) => n + (st.storage?.[co]?.[item] ?? 0), 0);
const threatsOn = (w: any, ship: string) => (w.piracy?.log ?? []).filter((e: any) => e.kind === 'threat' && e.ship === ship);

export async function scenario8(d: Driver, ids: Ids, A: string, B: string, _C: string, facts: any, save: Save) {
  d.log(await d.cmd('A', { c: 'stance', target: B, v: -1 }) === null, 'S8: A is hostile to B');
  d.log(await d.cmd('B', { c: 'piracyPolicy', group: ids.s8b, policy: 'survive' }) === null, 'S8: B\'s hauler (600 alloy) answers 생존 우선');
  // server validation of the new order
  const e1 = await d.cmd('A', { c: 'setOp', group: ids.s8a, op: { k: 'lootTender', group: ids.s8a } });
  const e2 = await d.cmd('B', { c: 'setOp', group: ids.s8b, op: { k: 'lootTender', group: ids.s8a } });
  const e3 = await d.cmd('A', { c: 'setOp', group: ids.s8t, op: { k: 'lootTender', group: 'nope' } });
  facts.s8 = { validation: [e1, e2, e3] };
  d.log(/자기 편대/.test(e1 ?? '') && /자사 약탈 편대/.test(e2 ?? '') && /약탈 편대가 없습니다/.test(e3 ?? ''), 'S8-1: the server refuses a tender order on the raid itself, on another company\'s raid and on a missing group', facts.s8.validation);
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s8t, op: { k: 'lootTender', group: ids.s8a } }) === null, 'S8-2: A assigns its 2-hauler group to the raid (약탈 회수 지원)');
  const v0 = d.view('A').groups[ids.s8t];
  d.log(v0?.op?.k === 'lootTender' && v0.op.group === ids.s8a, 'S8-2: A\'s own view shows the tender order', v0?.op);
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s8a, op: { k: 'plunder', group: ids.s8b, policy: 'nonlethal' } }) === null, 'S8-3: the raid (2 destroyers) plunders B\'s hauler');
  const statuses = new Set<string>();
  const drop = await d.wait(() => { const g = d.view('A').groups[ids.s8t]; if (g?.status) statuses.add(String(g.status).split(' — ')[0].split(':')[0]); return dropOf(d.view('A'), A, 'S8'); }, 'S8: no container', 900);
  const w0 = save();
  const sd = w0.drops?.[drop.id];
  const tr = (w0.piracy?.truces ?? []).find((t: any) => t.id === drop.id);
  const bHeld = d.view('B').ships[ids.s8bs]?.cargo?.alloy;
  Object.assign(facts.s8, { drop: drop.id, initial: drop.initial, raid: sd?.raid, truce: tr ? { pa: tr.pa, pb: tr.pb } : null, bHeld });
  d.log(sd?.raid === ids.s8a, 'S8-4: the container in the server save records the raid that made it (drop.raid)', { raid: sd?.raid });
  d.log(!!tr && tr.pa.includes(ids.s8a) && tr.pa.includes(ids.s8t), 'S8-4: the server\'s truce names the tender as a party with the raid', facts.s8.truce);
  d.log(bHeld + drop.initial === 600, 'S8-4: hauler + container = 600 alloy', { bHeld, initial: drop.initial });
  // the tender recovers it and unloads into a warehouse
  await d.wait(() => { const g = d.view('A').groups[ids.s8t]; if (g?.status) statuses.add(String(g.status).split(' — ')[0].split(':')[0]); const w = save(); return !w.drops?.[drop.id] && stored(w, A, 'alloy') > 0 && (g?.shipIds ?? []).every((id: string) => !(d.view('A').ships[id]?.cargo?.alloy > 0)) ? true : null; }, 'S8: the tender never finished', 2400);
  const w1 = save();
  const got = stored(w1, A, 'alloy');
  const raidHeld = (w1.groups[ids.s8a]?.shipIds ?? []).reduce((n: number, id: string) => n + (w1.ships[id]?.cargo?.alloy ?? 0), 0);
  const tenderHeld = (w1.groups[ids.s8t]?.shipIds ?? []).reduce((n: number, id: string) => n + (w1.ships[id]?.cargo?.alloy ?? 0), 0);
  Object.assign(facts.s8, { statuses: [...statuses], warehouse: got, raidHeld, tenderHeld, tenderOp: w1.groups[ids.s8t]?.op });
  d.log(statuses.has('약탈품 회수 중') && statuses.has('회수품 하역 중'), 'S8-5: the tender\'s status went through 약탈품 회수 중 and 회수품 하역 중', [...statuses]);
  d.log(got > 0 && got + raidHeld + tenderHeld === drop.initial, 'S8-5: everything jettisoned is in A\'s warehouses or aboard A\'s ships (exact)', { got, raidHeld, tenderHeld, initial: drop.initial });
  d.log(w1.groups[ids.s8t]?.op?.k === 'lootTender', 'S8-6: the tender order is continuous (still supporting the raid)', w1.groups[ids.s8t]?.op);
}

export async function scenario9(d: Driver, ids: Ids, A: string, B: string, _C: string, facts: any, save: Save) {
  d.log(await d.cmd('A', { c: 'stance', target: B, v: -1 }) === null, 'S9: A is hostile to B');
  for (const g of [ids.s9rich, ids.s9poor, ids.s9junk]) d.log(await d.cmd('B', { c: 'piracyPolicy', group: g, policy: 'survive' }) === null, `S9: B hauler ${g} answers 생존 우선`);
  d.log(await d.cmd('B', { c: 'setOp', group: ids.s9esc, op: { k: 'defend', at: JSON.parse(ids.s9escAt), radius: 300 } }) === null, 'S9: B\'s separate escort group holds 900 m from the rich hauler');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s9a, op: { k: 'plunder', at: JSON.parse(ids.s9), radius: 3000, policy: 'nonlethal' } }) === null, 'S9-1: A orders a lane raid on the zone (no target given)');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s9ac, op: { k: 'plunder', at: JSON.parse(ids.s9c), radius: 3000, policy: 'nonlethal' } }) === null, 'S9-3: A orders a second lane raid on a zone with only 5 silicate');
  const first = await d.wait(() => { const w = save(); const t = (w.piracy?.log ?? []).find((e: any) => e.kind === 'threat' && [ids.s9richS, ids.s9poorS].includes(e.ship)); return t ?? null; }, 'S9: no threat', 900);
  const est = d.view('A').groups[ids.s9a]?.plx?.est;
  facts.s9 = { firstThreat: { ship: first.ship, poor: first.ship === ids.s9poorS }, est, estSeenByB: d.view('B').groups[ids.s9a]?.plx ?? null };
  d.log(first.ship === ids.s9poorS, 'S9-1: the raid threatened the poorer unescorted hauler first (not the richer one 900 m from a separate escort)', facts.s9.firstThreat);
  d.log(!!est && est.p > 0.5 && est.profit >= 400 && est.sale > 0, 'S9-2: A\'s own fleet view carries the estimate (응낙·실판매·위험·기대 수익)', est);
  d.log(facts.s9.estSeenByB === null, 'S9-2: B does not see A\'s raid state', facts.s9.estSeenByB);
  // the worthless zone: nobody threatened, the reason is shown
  const why = await d.wait(() => { const p = d.view('A').groups[ids.s9ac]?.plx; return p?.why && /수익성 있는 목표 없음/.test(p.why) ? p.why : null; }, 'S9: no reason shown', 300).catch(() => null);
  const junkThreats = threatsOn(save(), ids.s9junkS).length;
  facts.s9.junk = { why, threats: junkThreats };
  d.log(!!why && junkThreats === 0, 'S9-3: the lane raid over 5 silicate threatened nobody and says why', facts.s9.junk);
  // stop both raids so the S9 groups stay out of further contact (the rest of the run is S1–S8)
  await d.cmd('A', { c: 'setOp', group: ids.s9ac, op: { k: 'idle' } });
}
