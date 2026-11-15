// P13.2.1 §8 extra server scenarios (run by p132-server.ts next to S1–S4, same three real WebSocket accounts):
//   S5 truce isolation — while A1↔B1 are under a post-surrender truce, A2↔B2 (other groups of the same two
//      companies, inside the truce radius) start a real P11 battle by contact; A1 can reinforce that battle
//      (A1↔B2 is not covered); B1 is never pulled in.
//   S6 direct attack — two concurrent truces A3↔B3, A4↔B4. A's attack order on B3 ends only A3↔B3 (P11 battle);
//      A4↔B4 stays; then B4's escort attacks A4 (the other direction) and ends A4↔B4.
//   S7 restart — two plunders leave two truces and two containers; the server is stopped and started while they
//      are active (driven from p132-server.ts); truces, containers and policies come back exactly.
// Starting assets are placed once offline (placeP1321); every later step is a real account command or the
// server's own simulation. Each scenario uses its own item so the accounting is separate.
import type { WorldSim } from '../../src/world/sim';
import type { V } from '../../src/world/types';
import type { Driver, Ids } from './p132-scenarios';

const P = (dx: number, dz: number, a: V): V => ({ x: a.x + dx, y: 0, z: a.z + dz });
const sum = (o: any) => Object.values<number>(o ?? {}).reduce((a, n) => a + n, 0);
export const P1321_ITEMS = { S5: ['crystal', 300], S6: ['armor_plate', 400], S7: ['structure', 400] } as const;

export function placeP1321(sim: WorldSim, A: string, B: string, _C: string): Ids {
  const st = sim.st, ast = st.stations.astra.pos;
  const fleet = (o: string, name: string, pos: V, comp: string[], cmdr = true) => {
    const g = sim.newGroup(o, name); if (cmdr) g.commanderId = sim.newCommander(o, 2).id;
    comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return g;
  };
  const hauler = (name: string, pos: V, item: string, n: number) => { const g = fleet(B, name, pos, ['hauler']); const s = st.ships[g.shipIds[0]]; (s.cargo as any)[item] = n; s.logisticsExcluded = true; return g; };
  const out: Ids = {};
  // S5: A1 800 m from B1 (the plunder pair); A2 and B2 2.9 km away (inside the 4 km truce radius, outside P11's 1.7 km join range)
  const s5 = P(20000, 40000, ast);
  const b1 = hauler('B 수송 S5', s5, 'crystal', 300);
  const a1 = fleet(A, 'A 약탈 S5', P(0, -800, s5), ['destroyer', 'destroyer', 'frigate']);
  const b2 = fleet(B, 'B 경비 S5', P(2900, 0, s5), ['corvette', 'corvette']);
  const a2 = fleet(A, 'A 습격 S5', P(2900, -2200, s5), ['destroyer', 'corvette', 'corvette']);
  Object.assign(out, { s5: JSON.stringify(s5), s5b1: b1.id, s5b1s: b1.shipIds[0], s5a1: a1.id, s5b2: b2.id, s5a2: a2.id, s5b2at: JSON.stringify(P(2900, 0, s5)), s5a2at: JSON.stringify(P(2900, -2200, s5)) });
  // S6: two separate plunder pairs 9 km apart (out of each other's P11 join range); B4 has an escort group (a party of B4's side)
  const s6 = P(-30000, 30000, ast);
  const b3 = hauler('B 수송 S6-3', s6, 'armor_plate', 200);
  const a3 = fleet(A, 'A 약탈 S6-3', P(0, -800, s6), ['destroyer', 'destroyer', 'frigate']);
  const b4 = hauler('B 수송 S6-4', P(9000, 0, s6), 'armor_plate', 200);
  const e4 = fleet(B, 'B 호위 S6-4', P(9000, 300, s6), ['corvette']);
  const a4 = fleet(A, 'A 약탈 S6-4', P(9000, -800, s6), ['cruiser', 'destroyer', 'destroyer']);
  Object.assign(out, { s6b3: b3.id, s6b3s: b3.shipIds[0], s6a3: a3.id, s6b4: b4.id, s6b4s: b4.shipIds[0], s6e4: e4.id, s6a4: a4.id });
  // S7: two plunder pairs for the restart with active truces
  const s7 = P(45000, -40000, ast);
  const b5 = hauler('B 수송 S7-5', s7, 'structure', 200);
  const a5 = fleet(A, 'A 약탈 S7-5', P(0, -800, s7), ['destroyer', 'destroyer', 'frigate']);
  const b6 = hauler('B 수송 S7-6', P(3000, 0, s7), 'structure', 200);
  const a6 = fleet(A, 'A 약탈 S7-6', P(3000, -800, s7), ['destroyer', 'destroyer', 'frigate']);
  Object.assign(out, { s7b5: b5.id, s7a5: a5.id, s7b6: b6.id, s7a6: a6.id });
  return out;
}

const engOf = (v: any, g: string) => Object.values<any>(v.engagements ?? {}).find(e => (e.groupRefs ?? []).includes(g));
const dropOf = (v: any, A: string, name: string) => Object.values<any>(v.drops ?? {}).find(x => x.by === A && x.name.includes(name));
type Save = () => any;
const trucesOf = (w: any) => (w.piracy?.truces ?? []) as any[];

export async function scenario5(d: Driver, ids: Ids, A: string, B: string, _C: string, facts: any, save: Save) {
  d.log(await d.cmd('A', { c: 'stance', target: B, v: -1 }) === null, 'S5: A is hostile to B');
  d.log(await d.cmd('B', { c: 'piracyPolicy', group: ids.s5b1, policy: 'survive' }) === null, 'S5: B1 (hauler, 300 crystal) answers 생존 우선');
  d.log(await d.cmd('B', { c: 'setOp', group: ids.s5b2, op: { k: 'defend', at: JSON.parse(ids.s5b2at), radius: 1500 } }) === null, 'S5: B2 (2 corvettes) holds a defence point 2.9 km from B1');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s5a2, op: { k: 'defend', at: JSON.parse(ids.s5a2at), radius: 300 } }) === null, 'S5: A2 holds its position 2.2 km from B2 (out of contact)');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s5a1, op: { k: 'plunder', group: ids.s5b1, policy: 'nonlethal' } }) === null, 'S5-1: A1 plunders B1 (non-destructive)');
  const drop = await d.wait(() => dropOf(d.view('A'), A, 'S5'), 'S5: no container', 600);
  const tr = await d.wait(() => trucesOf(save()).find(t => t.id === drop.id), 'S5: no truce in the save', 30);
  facts.s5 = { drop: drop.id, initial: drop.initial, truce: { pa: tr.pa, pb: tr.pb, r: tr.r, left: Math.round(tr.until - d.time()) } };
  d.log(tr.pa?.includes(ids.s5a1) && tr.pb?.includes(ids.s5b1) && !tr.pa.includes(ids.s5a2) && !tr.pb.includes(ids.s5b2), 'S5-2: the server\'s truce names A1 and B1 only (not A2, not B2)', facts.s5.truce);
  // A2 closes on B2 inside the truce radius: a real P11 battle by contact (the old company-wide rule blocked this)
  const tA2 = d.time();
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s5a2, op: { k: 'move', to: JSON.parse(ids.s5b2at) } }) === null, 'S5-3: A2 moves onto B2 (no attack order — contact only)');
  const e = await d.wait(() => { const v = d.view('A'); const x = engOf(v, ids.s5a2); return x && (x.groupRefs ?? []).includes(ids.s5b2) ? x : null; }, 'S5: A2↔B2 never fought', 300).catch(() => null);
  const truceStill = trucesOf(save()).some(t => t.id === drop.id && t.until > d.time());
  facts.s5.battle = e ? { id: e.id, after: Math.round(d.time() - tA2), groups: e.groupRefs, truceStillActive: truceStill } : null;
  d.log(!!e && truceStill, 'S5-3: A2↔B2 started a real P11 battle while the A1↔B1 truce was still active (same two companies, inside the truce radius)', facts.s5.battle);
  d.log(!!e && !(e.groupRefs ?? []).includes(ids.s5b1) && !(e.groupRefs ?? []).includes(ids.s5a1), 'S5-3: neither A1 nor B1 was pulled into that battle by contact', facts.s5.battle);
  // reinforcement: A1 (truce only with B1) joins the running A2↔B2 battle; B1 stays out
  if (e) {
    d.log(await d.cmd('A', { c: 'setOp', group: ids.s5a1, op: { k: 'move', to: JSON.parse(ids.s5b2at) } }) === null, 'S5-4: A1 heads into the A2↔B2 battle');
    const joined = await d.wait(() => { const x = engOf(d.view('A'), ids.s5a1); return x ? x : null; }, 'S5: A1 did not join', 300).catch(() => null);
    facts.s5.reinforce = joined ? { eng: joined.id, same: joined.id === e.id, groups: joined.groupRefs } : null;
    d.log(!!joined && joined.id === e.id && !(joined.groupRefs ?? []).includes(ids.s5b1), 'S5-4: A1 reinforced the running battle against B2 (A1↔B2 is not under truce); B1 is not in it', facts.s5.reinforce);
  }
  const bv = d.view('B');
  facts.s5.b1 = { alive: !!bv.ships[ids.s5b1s], crystal: bv.ships[ids.s5b1s]?.cargo?.crystal, engaged: !!engOf(d.view('B'), ids.s5b1) };
  d.log(facts.s5.b1.alive && facts.s5.b1.crystal + drop.initial === 300 && !facts.s5.b1.engaged, 'S5-5: B1 (the surrendered hauler) was never in a battle; hauler + container = 300 crystal', facts.s5.b1);
}

export async function scenario6(d: Driver, ids: Ids, A: string, B: string, _C: string, facts: any, save: Save) {
  d.log(await d.cmd('A', { c: 'stance', target: B, v: -1 }) === null, 'S6: A is hostile to B');
  for (const g of [ids.s6b3, ids.s6b4]) d.log(await d.cmd('B', { c: 'piracyPolicy', group: g, policy: 'survive' }) === null, `S6: B hauler ${g} answers 생존 우선`);
  d.log(await d.cmd('B', { c: 'setOp', group: ids.s6e4, op: { k: 'escort', group: ids.s6b4 } }) === null, 'S6: B\'s escort group follows B4');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s6a3, op: { k: 'plunder', group: ids.s6b3, policy: 'nonlethal' } }) === null, 'S6-1: A3 plunders B3');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s6a4, op: { k: 'plunder', group: ids.s6b4, policy: 'nonlethal' } }) === null, 'S6-1: A4 plunders B4');
  const d3 = await d.wait(() => dropOf(d.view('A'), A, 'S6-3'), 'S6: no container 3', 600);
  const d4 = await d.wait(() => dropOf(d.view('A'), A, 'S6-4'), 'S6: no container 4', 600).catch(() => null);
  const both = await d.wait(() => { const ts = trucesOf(save()).filter(t => t.until > d.time()); return ts.some(t => t.id === d3.id) && (!d4 || ts.some(t => t.id === d4.id)) ? ts : null; }, 'S6: truces missing', 30)
    .catch(e => { d.info('S6: truces at failure', { d3: d3.id, d4: d4?.id, truces: trucesOf(save()).map(t => ({ id: t.id, until: t.until })), now: d.time(), eng: Object.values<any>(d.view('A').engagements ?? {}).map(x => x.groupRefs), log: (save().piracy?.log ?? []).slice(-8).map((x: any) => [Math.round(x.t), x.kind, x.group, x.policy]) }); throw e; });
  facts.s6 = { drops: [d3.id, d4?.id], truces: both.map(t => ({ id: t.id, pa: t.pa, pb: t.pb })) };
  d.log(!!d4 && both.filter(t => t.a === A && t.b === B).length >= 2, 'S6-1: two concurrent truces of the same company pair live side by side (neither overwrote the other)', facts.s6);
  if (!d4) return;
  d.log(both.find(t => t.id === d4.id)?.pb?.includes(ids.s6e4), 'S6-1: B4\'s escort group is a party of the A4↔B4 truce', facts.s6.truces);
  // A's direct attack order on B3 ends A3↔B3 only
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s6a3, op: { k: 'attack', group: ids.s6b3 } }) === null, 'S6-2: A orders A3 to attack B3 directly');
  const after = await d.wait(() => { const ts = trucesOf(save()); return !ts.some(t => t.id === d3.id) ? ts : null; }, 'S6: truce 3 not ended', 30);
  facts.s6.afterAttack = after.map(t => t.id);
  d.log(!after.some(t => t.id === d3.id) && after.some(t => t.id === d4.id && t.until > d.time()), 'S6-2: only the A3↔B3 truce ended; A4↔B4 is still active', facts.s6.afterAttack);
  const forceLog = (save().piracy?.log ?? []).filter((x: any) => x.kind === 'force' && x.group === ids.s6a3);
  d.log(forceLog.some((x: any) => x.policy === `attack:${ids.s6b3}`), 'S6-2: the raid book records the use of force (attack order) for A3', forceLog.map((x: any) => ({ policy: x.policy, t: Math.round(x.t) })));
  // after the attack B3 runs for the nearest dock (and A3 after it). Whatever battle A3 gets into, the surrendered
  // B4 hauler must never be in one while its truce holds; groups met outside the 4 km truce radius (the haulers
  // often flee to the same dock) fight by the ordinary rules — recorded, not judged
  const e3 = await d.wait(() => engOf(d.view('A'), ids.s6a3), 'S6: no battle A3', 120).catch(() => null);
  const t4 = trucesOf(save()).find(t => t.id === d4.id);
  facts.s6.battle3 = e3 ? { id: e3.id, groups: e3.groupRefs, pos: e3.pos && { x: Math.round(e3.pos.x), z: Math.round(e3.pos.z) }, fromTruce4: t4 && e3.pos ? Math.round(Math.hypot(e3.pos.x - t4.pos.x, e3.pos.z - t4.pos.z)) : null } : null;
  d.info('S6-2: the battle A3 got into after its attack order (groups, distance from the A4↔B4 truce point)', facts.s6.battle3);
  d.log(!engOf(d.view('B'), ids.s6b4), 'S6-2: B4 (surrendered hauler, A4↔B4 truce) is not in any battle', { b4: d.view('B').ships[ids.s6b4s]?.state });
  // the other direction: B's escort attacks A4 → A4↔B4 ends
  const still4 = trucesOf(save()).some(t => t.id === d4.id && t.until > d.time());
  if (!still4) { d.info('S6-3: the A4↔B4 truce ran out before the reverse attack could be ordered — reverse direction not checked on the server', { now: d.time() }); return; }
  d.log(await d.cmd('B', { c: 'setOp', group: ids.s6e4, op: { k: 'attack', group: ids.s6a4 } }) === null, 'S6-3: B orders B4\'s escort to attack A4 (the victim side attacks)');
  const after4 = await d.wait(() => { const ts = trucesOf(save()); return !ts.some(t => t.id === d4.id) ? ts : null; }, 'S6: truce 4 not ended', 30).catch(() => null);
  d.log(!!after4, 'S6-3: the victim side\'s attack ended the A4↔B4 truce', { left: after4?.map((t: any) => t.id) });
  facts.s6.cargo = { b3: d.view('B').ships[ids.s6b3s]?.cargo?.armor_plate ?? 'sunk', b4: d.view('B').ships[ids.s6b4s]?.cargo?.armor_plate ?? 'sunk' };
}

/** S7 first half: two plunders → two active truces and two containers (the caller then restarts the server) */
export async function scenario7a(d: Driver, ids: Ids, A: string, B: string, _C: string, facts: any, save: Save) {
  d.log(await d.cmd('A', { c: 'stance', target: B, v: -1 }) === null, 'S7: A is hostile to B');
  for (const g of [ids.s7b5, ids.s7b6]) d.log(await d.cmd('B', { c: 'piracyPolicy', group: g, policy: 'survive' }) === null, `S7: B hauler ${g} answers 생존 우선`);
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s7a5, op: { k: 'plunder', group: ids.s7b5, policy: 'nonlethal' } }) === null, 'S7-1: A5 plunders B5');
  d.log(await d.cmd('A', { c: 'setOp', group: ids.s7a6, op: { k: 'plunder', group: ids.s7b6, policy: 'nonlethal' } }) === null, 'S7-1: A6 plunders B6');
  const d5 = await d.wait(() => dropOf(d.view('A'), A, 'S7-5'), 'S7: no container 5', 600);
  const d6 = await d.wait(() => dropOf(d.view('A'), A, 'S7-6'), 'S7: no container 6', 600);
  const ts = await d.wait(() => { const x = trucesOf(save()).filter(t => t.until > d.time() && [d5.id, d6.id].includes(t.id)); return x.length === 2 ? x : null; }, 'S7: two truces not saved', 30);
  facts.s7 = { drops: [d5.id, d6.id], truces: ts.map(t => ({ id: t.id, until: t.until })) };
  d.log(ts.length === 2, 'S7-1: two active truces and two containers before the restart', facts.s7);
}
/** compare what the save holds before and after the restart (truces, containers, raid book prefix, policies) */
export function s7compare(d: Driver, ids: Ids, w1: any, w2: any, facts: any) {
  const pick = (w: any) => ({ truces: trucesOf(w).map(t => JSON.stringify(t)).sort(), drops: Object.keys(w.drops ?? {}).sort(), lots: Object.values<any>(w.drops ?? {}).map(x => [x.id, sum(Object.fromEntries(x.lots.map((l: any) => [l.id, l.n])))]), pol: [w.groups[ids.s7b5]?.piracyPolicy, w.groups[ids.s7b6]?.piracyPolicy], plx: [w.groups[ids.s7a5]?.plx?.phase, w.groups[ids.s7a6]?.plx?.phase] });
  const a = pick(w1), b = pick(w2);
  // the truces of S7 are still there (they may have been joined by later ones, never changed)
  const kept = (facts.s7?.drops ?? []).every((id: string) => b.truces.some(t => JSON.parse(t).id === id) || !a.truces.some(t => JSON.parse(t).id === id));
  const same = a.truces.every(t => b.truces.includes(t) || JSON.parse(t).until <= w2.time);
  facts.s7.restart = { before: { truces: a.truces.length, drops: a.drops.length, pol: a.pol, plx: a.plx }, after: { truces: b.truces.length, drops: b.drops.length, pol: b.pol, plx: b.plx }, timeBefore: w1.time, timeAfter: w2.time };
  d.log(kept && same && JSON.stringify(a.pol) === JSON.stringify(b.pol), 'S7-2: after the restart every truce of the save is back unchanged (ids, parties, radius, end time) and the policies too', facts.s7.restart);
  d.log((facts.s7?.drops ?? []).every((id: string) => b.drops.includes(id) || !a.drops.includes(id)), 'S7-2: the S7 containers are back after the restart', { before: a.drops, after: b.drops });
}
