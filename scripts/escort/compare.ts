// Before/after: the same departure measured on any revision (uses only public commands, no escort fields).
//   npx vite-node scripts/escort/compare.ts
import { WorldSim } from '../../src/world/sim';
const D = (a: any, b: any) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
const out: any[] = [];
for (const seed of [7, 8, 9]) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('비교'); sim.st.companies[p].credits = 1e6;
  const gs = Object.values(sim.st.groups).filter(g => g.owner === p);
  const mining = gs.find(g => g.name.includes('채굴'))!, guard = gs.find(g => g.name.includes('경비'))!;
  const astra = sim.st.stations.astra, f = sim.st.fields.kestrel;
  sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'escort', group: mining.id } } as any);
  sim.command(p, { c: 'setOp', group: mining.id, op: { k: 'mine', field: f.id, deliver: '', sell: true, auto: true } } as any);
  const cen = (ids: string[]) => { const ss = ids.map(i => sim.st.ships[i]); return { x: ss.reduce((a, s) => a + s.pos.x, 0) / ss.length, z: ss.reduce((a, s) => a + s.pos.z, 0) / ss.length }; };
  let n = 0, aheadN = 0, behindN = 0, maxSep = 0, minersAt = -1, escortAt = -1, sumSep = 0;
  for (let t = 1; t <= 150; t++) {
    sim.tick(1);
    const mc = cen(mining.shipIds), ec = cen(guard.shipIds);
    if (minersAt < 0 && D(mc, f.pos) < f.radius + 300) minersAt = t;
    if (escortAt < 0 && D(ec, f.pos) < f.radius + 900) escortAt = t;
    if (minersAt < 0 && D(mc, f.pos) > f.radius + 900 && D(mc, astra.pos) > 800) {
      n++; const sep = D(ec, mc); maxSep = Math.max(maxSep, sep); sumSep += sep;
      const proj = (ec.x - mc.x) * (f.pos.x - mc.x) + (ec.z - mc.z) * (f.pos.z - mc.z);
      if (proj > 0) aheadN++; else behindN++;
    }
  }
  out.push({ seed, travelSamples: n, escortAheadShare: +(aheadN / n).toFixed(2), escortBehindShare: +(behindN / n).toFixed(2), avgSeparation: Math.round(sumSep / n), maxSeparation: maxSep, minersAtField: minersAt, escortAtField: escortAt, escortStatus: guard.status });
}
console.log(JSON.stringify(out));

// far escort (12 km away in space): do the miners leave without it, and how far behind is it on the way?
const far: any[] = [];
{
  const sim = WorldSim.create(7);
  const p = sim.addPlayer('비교'); sim.st.companies[p].credits = 1e6;
  const gs = Object.values(sim.st.groups).filter(g => g.owner === p);
  const mining = gs.find(g => g.name.includes('채굴'))!, guard = gs.find(g => g.name.includes('경비'))!;
  const astra = sim.st.stations.astra, f = sim.st.fields.kestrel;
  for (const id of guard.shipIds) { const s = sim.st.ships[id]; s.state = 'space'; s.task = { k: 'none' } as any; s.pos = { x: astra.pos.x - 12000, y: 0, z: astra.pos.z + 3000 }; }
  sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'escort', group: mining.id } } as any);
  sim.command(p, { c: 'setOp', group: mining.id, op: { k: 'mine', field: f.id, deliver: '', sell: true, auto: true } } as any);
  const cen = (ids: string[]) => { const ss = ids.map(i => sim.st.ships[i]); return { x: ss.reduce((a, s) => a + s.pos.x, 0) / ss.length, z: ss.reduce((a, s) => a + s.pos.z, 0) / ss.length }; };
  let undock = -1, sepAtUndock = -1, maxSepTravel = 0, minersAt = -1, escortAt = -1;
  for (let t = 1; t <= 150; t++) {
    sim.tick(1);
    const mc = cen(mining.shipIds), ec = cen(guard.shipIds);
    if (undock < 0 && mining.shipIds.some(i => sim.st.ships[i].state === 'space')) { undock = t; sepAtUndock = D(ec, mc); }
    if (minersAt < 0 && D(mc, f.pos) < f.radius + 300) minersAt = t;
    if (escortAt < 0 && D(ec, f.pos) < f.radius + 900) escortAt = t;
    if (undock > 0 && minersAt < 0) maxSepTravel = Math.max(maxSepTravel, D(ec, mc));
  }
  far.push({ minersUndockedAt: undock, escortDistanceAtUndock: sepAtUndock, maxSeparationOnTheWay: maxSepTravel, minersAtField: minersAt, escortAtField: escortAt });
}
console.log('FAR', JSON.stringify(far));

// pirates: the band cruises in from 5 km while the miners work (union forces kept out). Who meets it first?
const pir: any[] = [];
for (const seed of [7, 8, 9]) {
  const sim = WorldSim.create(seed);
  for (const g of Object.values(sim.st.groups)) if (g.owner === 'pirates') { for (const id of g.shipIds) delete sim.st.ships[id]; delete sim.st.groups[g.id]; }
  for (const l of Object.values(sim.st.lairs)) { (l as any).nextBand = 1e12; (l as any).respawnAt = 1e12; }
  const p = sim.addPlayer('비교'); sim.st.companies[p].credits = 1e6;
  const gs = Object.values(sim.st.groups).filter(g => g.owner === p);
  const mining = gs.find(g => g.name.includes('채굴'))!, guard = gs.find(g => g.name.includes('경비'))!;
  const astra = sim.st.stations.astra, f = sim.st.fields.kestrel;
  sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'escort', group: mining.id } } as any);
  sim.command(p, { c: 'setOp', group: mining.id, op: { k: 'mine', field: f.id, deliver: '', sell: true, auto: true } } as any);
  const sysOf = (q: any) => (sim as any).sysOf(q)?.id;
  const clean = () => { for (const g of Object.values(sim.st.groups)) { const k = sim.st.companies[g.owner]?.kind; if (k === 'player' || g.owner === 'pirates') continue; if (g.shipIds.some(id => sim.st.ships[id] && (sysOf(sim.st.ships[id].pos) === sysOf(f.pos) && g.owner === 'union' || D(sim.st.ships[id].pos, f.pos) < 16000))) { for (const id of g.shipIds) delete sim.st.ships[id]; g.shipIds = []; } } };
  for (let t = 0; t < 200 && !mining.shipIds.every(i => D(sim.st.ships[i].pos, f.pos) < f.radius + 300); t++) sim.tick(1);
  for (let t = 0; t < 10; t++) sim.tick(1);
  const dir = { x: f.pos.x - astra.pos.x, z: f.pos.z - astra.pos.z }, l = Math.hypot(dir.x, dir.z);
  const start = { x: f.pos.x + dir.x / l * 5000, y: 0, z: f.pos.z + dir.z / l * 5000 };
  const band = sim.newGroup('pirates', '비교 약탈단', null, { k: 'raid', home: '', target: mining.id } as any);
  band.npc = { role: 'rogue', sys: sysOf(start), home: '', homePos: start, template: [], nextRefit: 1e12, born: sim.time } as any; (band as any)._nextPick = 1e12;
  sim.spawnShip('pirates', 'corvette', 'gun', band.id, start); sim.spawnShip('pirates', 'corvette', 'gun', band.id, { ...start, x: start.x + 60 });
  const ships = (g: any) => g.shipIds.map((i: string) => sim.st.ships[i]).filter(Boolean);
  let contact: any = null;
  for (let t = 1; t <= 600 && !contact; t++) {
    clean();
    const pre = { toEscort: Math.min(...ships(band).flatMap((a: any) => ships(guard).map((b: any) => D(a.pos, b.pos)))), toMiners: Math.min(...ships(band).flatMap((a: any) => ships(mining).map((b: any) => D(a.pos, b.pos)))) };
    sim.update(1);
    const e = Object.values(sim.st.engagements).find(x => x.groupRefs.includes(band.id));
    if (e) contact = { at: t, bandToEscortBefore: pre.toEscort, bandToMinersBefore: pre.toMiners, escortIn: e.groupRefs.includes(guard.id), minersIn: e.groupRefs.includes(mining.id) };
  }
  for (let t = 0; t < 600 && Object.values(sim.st.engagements).some(x => !x.done && x.groupRefs.includes(band.id)); t++) sim.update(1);
  pir.push({ seed, contact, minersLeft: mining.shipIds.length, minerHp: ships(mining).map((s: any) => +s.hp.toFixed(2)), escortLeft: guard.shipIds.length, pirateLeft: band.shipIds.length });
}
console.log('PIRATES', JSON.stringify(pir));
