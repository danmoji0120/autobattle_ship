// P17.3.1 flank manoeuvre metrics on free-turning targets (rules 2). Run: npx vite-node scripts/p17/flank-metrics.ts
// Every number comes from the ordinary battle: the target turns freely and fights back; facing shares use the same
// bow-cosine test World.applyHit uses, and the hit columns are the engine's own front / side / rear judgements.
import { World, type BattleSetup } from '../../src/sim/world';
import { WEAPONS } from '../../src/sim/data/weapons';
import { getLoadout, type MountDef } from '../../src/sim/data/ships';
import { CONTENT } from '../../src/content/registry';
import { EQUIPMENT } from '../../src/world/industry';
import type { CpuSpec } from '../../src/sim/ai/computer';
import * as cpu from '../../src/sim/ai/computer';
import type { GroupSpec, ShipSpec } from '../../src/sim/fleet';

void CONTENT;
function ship(classId: string, loadoutId: string, weapon: string | null, c?: string): ShipSpec {
  const lo = getLoadout(classId, loadoutId);
  const mounts: MountDef[] = lo.mounts.map(m => ({ ...m, weapon: WEAPONS[m.weapon].kind === 'pd' ? m.weapon : (weapon ?? m.weapon) }));
  const e = c ? EQUIPMENT[c]!.cpu! : undefined;
  const spec: CpuSpec | undefined = e ? { id: c!, arch: e.arch, ...(e.react ? { react: e.react } : {}), ...(e.tune ? { tune: e.tune } : {}) } : undefined;
  return { classId, loadoutId, fit: { name: 'm', mounts }, ...(spec ? { cpu: spec } : {}) };
}
const G = (ships: ShipSpec[], order: GroupSpec['order'] = 'engage'): GroupSpec => ({ name: 'g', commanderId: 'wolf', order, retreatAt: 0, ships, children: [] });

export interface Row { scen: string; cpu: string; seed: number; front: number; side: number; rear: number; dist: number; fire: number; hF: number; hS: number; hR: number; dmg: number; att?: number; reached?: number; faced?: number; timeout?: number; replans?: number; switches?: number; distracted?: number }
const SCEN: Record<string, (c: string) => { a: ShipSpec[]; b: ShipSpec[] }> = {
  // free-turning 1v1, flanker faster than the target
  free_1v1: c => ({ a: [ship('destroyer', 'strike', 'medium_gun', c)], b: [ship('cruiser', 'aa', null)] }),
  // 2 v 1: an ally (line computer) draws the target's attention
  two_v_one: c => ({ a: [ship('destroyer', 'strike', 'medium_gun', c), ship('destroyer', 'aa', null, 'cpu_line')], b: [ship('cruiser', 'aa', null)] }),
  // fast vs slow
  fast_slow: c => ({ a: [ship('frigate', 'aa', 'medium_gun', c)], b: [ship('battleship', 'std', null)] }),
  // similar agility
  similar: c => ({ a: [ship('destroyer', 'strike', 'medium_gun', c)], b: [ship('destroyer', 'aa', null)] }),
};
export function trial(scen: string, c: string, seed: number, T = 150): Row {
  const sc = SCEN[scen](c);
  const setup: BattleSetup = { seed, scenarioId: 'p1731flank', fleets: [{ name: 'A', root: G(sc.a) }, { name: 'B', root: G(sc.b) }], rules: 2 };
  const w = new World(setup);
  const s = w.ships.find(x => x.team === 0)!, t = w.ships.find(x => x.team === 1)!;
  // the flanker and its target are tough enough to see the manoeuvre through (same for every computer)
  for (const x of [s, t]) { x.hp *= 4; x.maxHp *= 4; }
  let front = 0, side = 0, rear = 0, k = 0, dsum = 0, fire = 0, hF = 0, hS = 0, hR = 0, dmg = 0;
  while (!w.outcome && w.time < T) {
    w.step();
    let fired = false;
    for (const e of w.events) {
      if (e.t === 'fire' && e.ship === s.id && WEAPONS[e.weapon]?.kind !== 'pd') fired = true;
      if (e.t === 'hit' && e.attacker === s.id && e.target === t.id && e.result !== 'shield') { if (e.facing === 'front') hF++; else if (e.facing === 'rear') hR++; else hS++; dmg += e.dmg; }
    }
    if (fired) fire += w.dt;
    if (s.state !== 'alive' || t.state !== 'alive' || w.time < 20) continue;
    const rx = s.pos.x - t.pos.x, rz = s.pos.z - t.pos.z, d = Math.hypot(rx, rz);
    const cs = (rx * t.fwd.x + rz * t.fwd.z) / Math.max(1, d);
    if (cs > 0.5) front++; else if (cs < -0.5) rear++; else side++;
    k++; dsum += d;
  }
  const n = Math.max(1, k), f = (cpu as { flankStats?: (s: unknown) => cpu.FlankState | undefined }).flankStats?.(s);
  return { scen, cpu: c, seed, front: front / n, side: side / n, rear: rear / n, dist: dsum / n, fire, hF, hS, hR, dmg,
    ...(f ? { att: f.attempts, reached: f.reached, faced: f.fails.faced, timeout: f.fails.timeout, replans: f.replans, switches: f.switches, distracted: f.distracted } : {}) };
}

if (process.env.RUN) {
  const seeds = [3, 7, 11, 19];
  const out: Row[] = [];
  for (const scen of Object.keys(SCEN)) for (const c of ['cpu_flanker', 'cpu_line']) for (const seed of seeds) out.push(trial(scen, c, seed));
  const pct = (x: number) => (x * 100).toFixed(0).padStart(3) + '%';
  console.log('scen        cpu          front side rear  dist  fire(s) hits F/S/R   dmg    | att reach faced tmo replan sw busy');
  for (const scen of Object.keys(SCEN)) for (const c of ['cpu_flanker', 'cpu_line']) {
    const rs = out.filter(r => r.scen === scen && r.cpu === c), m = (k: keyof Row) => rs.reduce((a, r) => a + (r[k] as number ?? 0), 0) / rs.length;
    console.log(`${scen.padEnd(11)} ${c.padEnd(12)} ${pct(m('front'))} ${pct(m('side'))} ${pct(m('rear'))} ${m('dist').toFixed(0).padStart(5)} ${m('fire').toFixed(0).padStart(6)}  ${m('hF').toFixed(0)}/${m('hS').toFixed(0)}/${m('hR').toFixed(0)}`.padEnd(78) + ` ${m('dmg').toFixed(0).padStart(6)}` +
      (rs[0].att !== undefined ? ` | ${m('att').toFixed(1)} ${m('reached').toFixed(1)} ${m('faced').toFixed(1)} ${m('timeout').toFixed(1)} ${m('replans').toFixed(0)} ${m('switches').toFixed(1)} ${m('distracted').toFixed(1)}` : ''));
  }
  if (process.env.JSON) console.log(JSON.stringify(out));
}
