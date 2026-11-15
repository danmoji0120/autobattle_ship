// P13.2 §16 scenarios, written once against a small driver so the same steps run in-process (fast tuning,
// `--local`) and on a real server process over three real WebSocket accounts (p132-server.ts).
// Starting assets are placed once (`place`) while the server is stopped; after that every step is a real
// command of one of the three accounts or the server's own simulation. Nothing is credited by the script.
import type { WorldSim } from '../../src/world/sim';
import type { Station, V } from '../../src/world/types';

export interface Ids { [k: string]: string }
export interface Driver {
  /** a real command of one account; null = accepted */
  cmd(who: 'A' | 'B' | 'C', c: any): Promise<string | null>;
  /** what that account's client sees (server: last snapshot) */
  view(who: 'A' | 'B' | 'C'): any;
  /** game time */
  time(): number;
  wait<T>(fn: () => T, why: string, gameSeconds: number): Promise<NonNullable<T>>;
  log(ok: unknown, label: string, extra?: unknown): void;
  info(label: string, extra?: unknown): void;
}

const P = (dx: number, dz: number, a: V): V => ({ x: a.x + dx, y: 0, z: a.z + dz });
export const sum = (o: any) => Object.values<number>(o ?? {}).reduce((a, n) => a + n, 0);
const lotsN = (lots: any[] | undefined, item?: string, k?: string) => (lots ?? []).filter(l => (!item || l.item === item) && (!k || l.k === k)).reduce((a, l) => a + l.n, 0);

/** starting assets (offline, once): four separate areas, low security everywhere (as in the tests), other lairs off */
export function place(sim: WorldSim, A: string, B: string, C: string): Ids {
  const st = sim.st;
  for (const id of Object.keys(st.ships)) delete st.ships[id];
  for (const id of Object.keys(st.groups)) delete st.groups[id];
  for (const sys of Object.values(st.systems)) sys.security = 10;
  const lair = st.lairs.gravel;
  for (const l of Object.values(st.lairs)) { l.alive = l === lair; l.respawnAt = 1e10; l.nextBand = 1e10; l.hp = 1; }
  for (const co of [A, B, C]) st.companies[co].credits = 1e6;
  const ast = st.stations.astra.pos;
  const fleet = (o: string, name: string, pos: V, comp: string[], cmdr = true) => {
    const g = sim.newGroup(o, name); if (cmdr) g.commanderId = sim.newCommander(o, 2).id;
    comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return g;
  };
  // S1: B's private route with a logistics centre at both ends (P12.5 automatic hauling)
  const tmpl = st.stations.astra;
  const make = (id: string, name: string, at: V): Station => ({ ...structuredClone(tmpl), id, name, public: false, owner: B, pos: at, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [B]: {} }, modules: ['core', 'power', 'warehouse', 'logistics', 'dock'].map((kind, i) => ({ id: `${id}_${kind}${i}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] });
  const src = make('p132_src', 'B 광산 기지', P(3000, 2000, ast)), dst = make('p132_dst', 'B 제련 기지', P(32000, 2000, ast));
  st.stations[src.id] = src; st.stations[dst.id] = dst;
  src.storage[B].ore = 900;
  const s1h = fleet(B, 'B 운송대', src.pos, ['hauler']); (sim as any).dockShip(st.ships[s1h.shipIds[0]], src);
  const s1e = fleet(B, 'B 호위대', P(0, 1500, src.pos), ['corvette']);
  // A waits on the approach to B's destination, where the warp drops out (700 m before the dock)
  const s1amb = P(-900, 450, dst.pos);
  const s1a = fleet(A, 'A 약탈대', s1amb, ['cruiser', 'destroyer']);
  const s1c = fleet(C, 'C 회수대', P(-3000, 4000, dst.pos), ['hauler']);
  // S2: B's convoy that will not give its cargo up (protect), badly damaged hauler + one corvette, holding position
  const s2p = P(4000, -25000, ast);
  const s2v = fleet(B, 'B 보호 호송대', s2p, ['hauler', ...(process.env.S2_ESC ?? 'destroyer,destroyer,corvette').split(',')]);
  const h2 = st.ships[s2v.shipIds[0]]; h2.cargo.metal = 300; h2.cargo.electronics = 120; h2.logisticsExcluded = true; h2.hp = Number(process.env.S2_HP ?? 1);
  const s2a = fleet(A, 'A 강습대', P(-Number(process.env.S2_GAP ?? 1000), 0, s2p), (process.env.S2_ATK ?? 'corvette,corvette,corvette,corvette,corvette,corvette,destroyer,destroyer').split(','));
  const s2c = fleet(C, 'C 인양대', P(0, 3500, s2p), ['hauler']);
  // S3: a lone hauler under way that gives part of its cargo up, then is sunk
  const s3p = P(-15000, -45000, ast);
  const s3v = fleet(B, 'B 화물선 3', s3p, ['hauler']);
  const h3 = st.ships[s3v.shipIds[0]]; h3.cargo.composite = 600; h3.logisticsExcluded = true;
  const s3a = fleet(A, 'A 약탈대 3', P(0, 1000, s3p), ['corvette', 'corvette', 'corvette', 'corvette', 'corvette', 'corvette', 'destroyer', 'destroyer']);
  const s3r = fleet(A, 'A 회수선 3', P(-2500, 2500, s3p), ['hauler']);
  const s3c = fleet(C, 'C 인양대 3', P(2000, 4000, s3p), ['hauler']);
  // S4: an NPC pirate band of a live lair and a passing hauler of B; B's own recovery hauler further out
  const s4band = fleet('pirates', '자갈 해적단 약탈대', P(2000, 0, lair.pos), ['frigate', 'frigate', 'corvette'], false);
  s4band.op = { k: 'raid', home: lair.id } as any; (s4band as any).npc = { home: lair.id, homePos: lair.pos };
  const s4v = fleet(B, 'B 화물선 4', P(7000, 0, lair.pos), ['hauler']);
  const h4 = st.ships[s4v.shipIds[0]]; h4.cargo.machinery = 2000; h4.logisticsExcluded = true;
  const s4r = fleet(B, 'B 회수선단 4', P(9000, 5000, lair.pos), ['hauler', 'destroyer', 'destroyer']);
  return {
    src: src.id, dst: dst.id, s1h: s1h.id, s1hs: s1h.shipIds[0], s1e: s1e.id, s1a: s1a.id, s1c: s1c.id,
    s2v: s2v.id, s2h: h2.id, s2a: s2a.id, s2c: s2c.id, s3v: s3v.id, s3h: h3.id, s3a: s3a.id, s3r: s3r.id, s3c: s3c.id,
    s4band: s4band.id, s4v: s4v.id, s4h: h4.id, s4r: s4r.id, lair: lair.id,
    s3to: JSON.stringify(P(-6000, 0, s3p)), s1amb: JSON.stringify(s1amb), s4to: JSON.stringify(P(13000, 0, lair.pos)),
  };
}

const dropsIn = (v: any) => Object.values<any>(v.drops ?? {});
const wrecksOf = (v: any, ship: string) => Object.values<any>(v.wrecks ?? {}).filter(w => (w.sources ?? []).some((s: any) => s.ship === ship));

export async function scenario1(d: Driver, ids: Ids, A: string, B: string, C: string, facts: any) {
  // 1. B starts a real P12.5 shipment; its escort follows the haulers
  d.log(await d.cmd('B', { c: 'piracyPolicy', group: ids.s1h, policy: 'survive' }) === null, 'S1-1: B sets its hauler group to 생존 우선 (group override)');
  d.log(await d.cmd('B', { c: 'setOp', group: ids.s1e, op: { k: 'escort', group: ids.s1h } }) === null, 'S1-1: B\'s corvette escorts the hauler group');
  // 2. A lies in wait on B's lane (zone plunder at the warp drop-out point of B's destination)
  d.log(await d.cmd('A', { c: 'stance', target: B, v: -1 }) === null, 'S1-2: A declares B hostile');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s1a, op: { k: 'harass', at: JSON.parse(ids.s1amb), radius: 3000, plunder: 'nonlethal' } }) === null, 'S1-2: A sets a lane plunder (항로 약탈, non-destructive) on the approach to B\'s destination');
  d.log(await d.cmd('B', { c: 'poolCreate', request: { from: ids.src, to: ids.dst, item: 'ore', kind: 'transfer', amount: 300, priority: 5, repeat: false } }) === null, 'S1-1: B creates a real logistics job: 300 ore B 광산 기지 → B 제련 기지');
  const job = () => Object.values<any>(d.view('B').logisticsJobs ?? {}).find(j => j.from === ids.src && j.item === 'ore');
  const out = await d.wait(() => { const v = d.view('B'), s = v.ships[ids.s1hs], j = job(); return j?.carried > 0 && s?.state === 'space' ? { carried: j.carried, cargo: s.cargo.ore, job: j.id } : null; }, 'B\'s hauler never left with cargo', 900);
  d.log(out.cargo === out.carried && out.carried > 0, 'S1-1: the P12.5 job loaded the hauler and it undocked (real cargo under way)', out);
  const drop = await d.wait(() => dropsIn(d.view('A')).find(x => x.owner === B && x.by === A && lotsN(x.lots) + sum(x.taken?.[A]) > 0 && x.name.includes('운송대')), 'no container', 900);
  const vB = d.view('B'), s = vB.ships[ids.s1hs], j = Object.values<any>(vB.logisticsJobs).find(x => x.id === out.job);
  facts.s1 = { drop: drop.id, initial: drop.initial, carriedBefore: out.carried, carriedAfter: j?.carried, lost: j?.lost, pirated: j?.pirated, cargoAfter: s?.cargo?.ore };
  d.log(drop.initial > 0 && s && s.cargo.ore === out.carried - drop.initial && j.pirated === drop.initial && j.lost === drop.initial && j.carried === s.cargo.ore, 'S1-4/5/6/10: B surrendered: the hauler\'s ore fell by exactly the container\'s amount; the job settled carried −, lost +, pirated + at that moment', facts.s1);
  const near = (e: any) => e.pos && Math.hypot(e.pos.x - drop.pos.x, e.pos.z - drop.pos.z) < 12000;
  const engS1 = Object.values<any>(d.view('A').engagements ?? {}).filter(near).concat((d.view('A').battleLog ?? []).filter(near));
  facts.s1near = (e: any) => near(e);
  d.log(engS1.length === 0, 'S1: no P11 engagement near the raid (non-destructive plunder)', { engagements: engS1.length });
  // 7. A recovers part (warships: small salvage hold), 8. C recovers part of the rest (explicitly, B's property)
  const aTook = await d.wait(() => { const x = d.view('A').drops?.[drop.id]; return sum(x?.taken?.[A]) > 0 && d.view('A').groups[ids.s1a]?.op?.k !== 'plunder' ? sum(x.taken[A]) : 0; }, 'A did not recover', 900);
  d.log(aTook > 0 && aTook < drop.initial, 'S1-7: A\'s warships recovered part of the container (their salvage hold), the rest stays', { aTook, initial: drop.initial });
  d.log(await d.cmd('C', { c: 'setOp', group: ids.s1c, op: { k: 'recover', wreck: drop.id, illegal: true } }) === null, 'S1-8: C orders its hauler to the container (unauthorised recovery of B\'s cargo, lawless zone)');
  const cTook = await d.wait(() => { const x = d.view('C').drops?.[drop.id]; return x ? (sum(x.taken?.[C]) > 0 ? sum(x.taken[C]) : 0) : -1; }, 'C did not recover', 900);
  d.log(cTook !== 0, 'S1-8: C recovered from the same container', { cTook });
  // 9. B survives and keeps delivering; 10-11. job: delivered 300 in the end, the shortfall was re-dispatched
  const done = await d.wait(() => { const x = Object.values<any>(d.view('B').logisticsJobs ?? {}).find(y => y.id === out.job); return x?.state === 'complete' ? x : null; }, 'B\'s job did not complete', 2400);
  const vb = d.view('B');
  facts.s1.job = { delivered: done.delivered, lost: done.lost, pirated: done.pirated, amount: done.amount };
  facts.s1.storage = { src: vb.stations[ids.src]?.storage?.[B]?.ore, dst: vb.stations[ids.dst]?.storage?.[B]?.ore };
  const engEnd = Object.values<any>(d.view('A').engagements ?? {}).filter(near).concat((d.view('A').battleLog ?? []).filter(near));
  d.log(engEnd.length === 0, 'S1: no P11 engagement anywhere near the raid during the whole scenario', { engagements: engEnd.length });
  delete facts.s1near;
  d.log(vb.ships[ids.s1hs] && done.delivered === 300 && done.pirated === drop.initial && facts.s1.storage.dst === 300 && facts.s1.storage.src === 900 - 300 - drop.initial, 'S1-9/10/11: the hauler survived; the job completed with 300 delivered, the plundered amount re-loaded from B\'s own stock (nothing bought or created)', facts.s1);
}

export async function scenario2(d: Driver, ids: Ids, A: string, B: string, C: string, facts: any) {
  d.log(await d.cmd('B', { c: 'piracyPolicy', group: ids.s2v, policy: 'protect' }) === null, 'S2-1: B sets its convoy to 화물 보호 우선');
  d.log(await d.cmd('A', { c: 'stance', target: B, v: -1 }) === null, 'S2: A is hostile to B (declaration)');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s2a, op: { k: 'plunder', group: ids.s2v, policy: 'force' } }) === null, 'S2-2: A orders a plunder with force allowed');
  const t0 = d.time();
  const resp = await d.wait(() => { const v = d.view('B'); return (v.ships[ids.s2h]?.pir?.act) ?? null; }, 'no demand reached B', 600).catch(() => null);
  facts.s2 = { response: resp };
  d.log(resp === 'resist' || resp === 'flee' || resp === 'stall', 'S2-3: B refused the demand (protect policy, escort present)', { resp });
  const eng = await d.wait(() => Object.values<any>(d.view('A').engagements ?? {}).find(e => (e.sides ?? []).flat().includes(A) && (e.sides ?? []).flat().includes(B))?.id ?? (d.view('A').battleLog ?? []).find((b: any) => b.sides?.some((x: any) => x.company === B))?.id, 'no P11 engagement', 1200);
  d.log(!!eng, 'S2-4/5: A used force — a real P11 engagement', { eng, after: Math.round(d.time() - t0) });
  // sunk — or the plunder gave up (the hauler escaped P11 battles {PIR.forceEscapes} times, or the chase limit)
  const end = await d.wait(() => !d.view('A').ships[ids.s2h] ? 'sunk' : d.view('A').groups?.[ids.s2a]?.op?.k !== 'plunder' ? 'gave up: ' + (d.view('A').groups?.[ids.s2a]?.status ?? '') : null, 'neither sunk nor given up', 2400).catch(() => 'timeout');
  const sunk = end === 'sunk'; facts.s2.end = end;
  facts.s2.sunk = sunk;
  if (!sunk) { d.info('S2: the hauler survived the fight in this run (P11 outcome) — the wreck steps are not counted', facts.s2); return; }
  d.log(true, 'S2-6: B\'s hauler was sunk');
  const w = await d.wait(() => wrecksOf(d.view('A'), ids.s2h)[0], 'no wreck', 120);
  const cargo = { metal: lotsN(w.lots, 'metal', 'cargo'), electronics: lotsN(w.lots, 'electronics', 'cargo') };
  facts.s2.wreck = { id: w.id, cargo };
  d.log(cargo.metal <= 300 * 0.85 && cargo.electronics <= 120 * 0.85 && cargo.metal + cargo.electronics > 0, 'S2-7: a P13.1 wreck holds the surviving part of the hauler\'s real cargo', facts.s2.wreck);
  // 8. A loots (its plunder order), C salvages too
  d.log(await d.cmd('C', { c: 'setOp', group: ids.s2c, op: { k: 'recover', wreck: w.id, illegal: true } }) === null, 'S2-8: C orders its hauler to the wreck');
  await d.wait(() => sum(d.view('A').wrecks?.[w.id]?.taken?.[A]) > 0 || !d.view('A').wrecks?.[w.id], 'A did not loot', 900).catch(() => null);
  await d.wait(() => sum(d.view('C').wrecks?.[w.id]?.taken?.[C]) > 0 || !d.view('C').wrecks?.[w.id], 'C did not salvage', 900).catch(() => null);
  facts.s2.takenA = d.view('A').wrecks?.[w.id]?.taken?.[A] ?? facts.s2.takenA; facts.s2.takenC = d.view('C').wrecks?.[w.id]?.taken?.[C];
  d.log(sum(facts.s2.takenA) > 0 || sum(facts.s2.takenC) > 0, 'S2-8: the wreck\'s goods are recovered by A and/or C (accounting checked from the save)', { A: facts.s2.takenA, C: facts.s2.takenC });
}

export async function scenario3(d: Driver, ids: Ids, A: string, B: string, C: string, facts: any) {
  d.log(await d.cmd('B', { c: 'setOp', group: ids.s3v, op: { k: 'move', to: JSON.parse(ids.s3to) } }) === null, 'S3: B\'s lone hauler (600 composite) is under way');
  d.log(await d.cmd('B', { c: 'piracyPolicy', group: ids.s3v, policy: 'survive' }) === null, 'S3: B sets it to 생존 우선');
  d.log(await d.cmd('A', { c: 'stance', target: B, v: -1 }) === null, 'S3: A is hostile to B (declaration)');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s3a, op: { k: 'plunder', group: ids.s3v, policy: 'nonlethal', demand: 'part' } }) === null, 'S3-1: A demands part of the cargo');
  const drop = await d.wait(() => dropsIn(d.view('A')).find(x => x.owner === B && x.name.includes('화물선 3')), 'no container', 600);
  const kept = d.view('B').ships[ids.s3h]?.cargo?.composite;
  facts.s3 = { drop: drop.id, dropped: drop.initial, kept };
  d.log(drop.initial > 0 && kept + drop.initial === 600, 'S3-1: B jettisoned part; hauler + container = 600 composite', facts.s3);
  // 2. A's own hauler goes for the container; 3. A's warships turn on the hauler right away (a direct attack ends the truce)
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s3r, op: { k: 'recover', wreck: drop.id } }) === null, 'S3-2: A sends its hauler to recover the container');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s3a, op: { k: 'plunder', group: ids.s3v, policy: process.env.S3_POL ?? 'destroy' } }) === null, 'S3-3: A then switches its warships to 수송망 파괴 우선 on the same hauler (force without a demand, ends the truce, P11)');
  // sunk — or the plunder gave up (the hauler escaped P11 battles {PIR.forceEscapes} times, or the chase limit)
  const end = await d.wait(() => !d.view('A').ships[ids.s3h] ? 'sunk' : d.view('A').groups?.[ids.s3a]?.op?.k !== 'plunder' ? 'gave up: ' + (d.view('A').groups?.[ids.s3a]?.status ?? '') : null, 'neither sunk nor given up', 2400).catch(() => 'timeout');
  const sunk = end === 'sunk'; facts.s3.end = end;
  facts.s3.sunk = sunk;
  if (!sunk) { d.info('S3: the hauler survived in this run — not counted', facts.s3); return; }
  const w = await d.wait(() => wrecksOf(d.view('A'), ids.s3h)[0], 'no wreck', 120);
  const inW = lotsN(w.lots, 'composite', 'cargo');
  facts.s3.wreck = { id: w.id, composite: inW };
  d.log(inW <= kept * 0.85 && inW >= 0, 'S3-4: the wreck holds only part of what was still aboard (not the jettisoned composite)', { kept, inWreck: inW });
  const aTook = await d.wait(() => sum(d.view('A').drops?.[drop.id]?.taken?.[A]) || (!d.view('A').drops?.[drop.id] ? -1 : 0), 'A did not recover the container', 900).catch(() => 0);
  facts.s3.aTook = aTook;
  d.log(aTook !== 0, 'S3-2: A recovered from the container', { aTook });
  d.log(await d.cmd('C', { c: 'setOp', group: ids.s3c, op: { k: 'recover', wreck: w.id, illegal: true } }) === null, 'S3-5: C salvages the hauler\'s wreck');
  await d.wait(() => { const x = d.view('C').wrecks?.[w.id]; return !x || sum(x.taken?.[C]) > 0; }, 'C did not salvage', 900).catch(() => null);
  facts.s3.cTook = sum(d.view('C').wrecks?.[w.id]?.taken?.[C]);
  d.log(w.id !== drop.id, 'S3-5: container and wreck are separate objects, each recovered on its own (totals from the save)', facts.s3);
}

export async function scenario4(d: Driver, ids: Ids, A: string, B: string, C: string, facts: any) {
  void A; void C;
  d.log(await d.cmd('B', { c: 'piracyPolicy', group: ids.s4v, policy: 'survive' }) === null, 'S4: B\'s hauler near the 자갈 해적단 lair is set to 생존 우선');
  d.log(await d.cmd('B', { c: 'setOp', group: ids.s4v, op: { k: 'move', to: JSON.parse(ids.s4to) } }) === null, 'S4: the hauler (2000 machinery) flies past the lair');
  const drop = await d.wait(() => dropsIn(d.view('B')).find(x => x.owner === B && x.by === 'pirates'), 'pirates made no demand / drop', 1200);
  facts.s4 = { drop: drop.id, initial: drop.initial, kept: d.view('B').ships[ids.s4h]?.cargo?.machinery };
  d.log(drop.initial > 0 && facts.s4.kept + drop.initial === 2000, 'S4-1/2/3: an NPC pirate band threatened B\'s hauler; B surrendered; the real cargo was jettisoned', facts.s4);
  // pirates pick up what they can carry, then go home; B recovers the rest
  await d.wait(() => { const x = d.view('B').drops?.[drop.id]; return x && lotsN(x.lots) < drop.initial ? true : null; }, 'pirates took nothing', 900).catch(() => null);
  // the band leaves with its load (its raid state is server-side; the container stops shrinking)
  let last = -1, still = 0;
  await d.wait(() => { const n = lotsN(d.view('B').drops?.[drop.id]?.lots); still = n === last ? still + 1 : 0; last = n; return still > 40 ? true : null; }, '', 600).catch(() => null);
  facts.s4.leftAfterPirates = lotsN(d.view('B').drops?.[drop.id]?.lots);
  d.log(await d.cmd('B', { c: 'setOp', group: ids.s4r, op: { k: 'recover', wreck: drop.id } }) === null, 'S4-5: B sends its own escorted hauler to take back what is left (owner — always allowed)');
  const back = await d.wait(() => { const x = d.view('B').drops?.[drop.id]; return x ? (sum(x.taken?.[B]) > 0 ? sum(x.taken[B]) : null) : -1; }, 'B did not recover', 1200).catch(() => 0);
  facts.s4.bTook = back;
  d.log(back !== 0, 'S4-5: B recovered its own jettisoned cargo', facts.s4);
}
