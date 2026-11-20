// P17.5 opt-in fields reuse P10 geology, owned stations and ordinary transport.
import { qty, type Field, type Station, type WGroup, type WorldState } from './types';
import type { Size } from '../content/schema';
import type { WorldSim } from './sim';
import { addGood } from './economy';
import { dist, sysAt } from './geom';
import { econOf, berthFits } from './hullops';
import { shipValue } from './data';
import { stationSupportOnline } from './production';
import { stationSize } from './stations';
import { coRelation } from './battleAuth';
import { itemPrice } from './industry';

export const STRATEGIC_RAW = ['dense_titanium_ore', 'resonant_crystal', 'unstable_isotope', 'singular_ore'] as const;
const PILOT_FIELDS: Record<string, number> = {
  p10_scar_crystal: 8000,
  p10_tundra_ore: 6500,
  p97_shard_resonance: 6500,
  p97_dusk_isotope: 7500,
  p97_blackgate_singular: 8000,
};
const MARKETS: Record<string, readonly string[]> = {
  p9_anvil_port: ['dense_titanium_ore'],
  p9_ceres_works: ['dense_titanium_ore', 'resonant_crystal'],
  exchange: ['resonant_crystal', 'unstable_isotope', 'singular_ore'],
  p10_arsenal_works: ['unstable_isotope', 'singular_ore'],
};

export function enableStrategicFields(w: WorldState) {
  for (const [id, radius] of Object.entries(PILOT_FIELDS)) {
    const f = w.fields[id];
    if (!f?.geo) throw new Error(`P17.5 requires P10 geology: ${id}`);
    f.strategic = { radius };
  }
  for (const [id, items] of Object.entries(MARKETS)) {
    const market = w.stations[id]?.market;
    if (!market) throw new Error(`P17.5 missing market: ${id}`);
    for (const item of items) {
      if (Object.hasOwn(market, item)) continue;
      addGood(market, item, 1, 0, w);
      market[item].demandOnly = true;
    }
  }
  w.strategicV = 1;
}

export function outpostProblem(w: Pick<WorldState, 'systems'>, f: Field, st: Station | undefined, company: string, berth: Size = 'S'): string | null {
  if (!f.strategic) return null;
  if (!st || st.owner !== company || st.public || !stationSize(st)) return '광구 근처에 자사 S급 이상 전초기지가 필요합니다';
  if (sysAt(w.systems, f.pos)?.id !== sysAt(w.systems, st.pos)?.id || dist(f.pos, st.pos) > f.strategic.radius)
    return `광구 중심 ${f.strategic.radius.toLocaleString()}m 이내 정거장을 지정하세요`;
  if (!st.modules.some(m => m.kind === 'core' && m.built)) return '전초기지 코어 건설 중';
  if (!stationSupportOnline(st)) return '전초기지 전력 부족';
  if (!berthFits(st, berth)) return '전초기지 정박 규격 부족';
  return null;
}

export function strategicRaidValue(h: WorldSim, g: WGroup, at: Field['pos']): number {
  if (!h.st.strategicV || h.st.companies[g.owner]?.kind !== 'player') return 0;
  const ships = h.shipsOf(g).filter(s => s.state === 'space' && !s.warp);
  const order = h.opOf(g);
  const field = order.k === 'mine' ? h.st.fields[order.field] : undefined;
  const extracting = field?.strategic && dist(at, field.pos) <= field.radius + 1200
    && ships.some(s => s.task.k === 'mine' && s.task.field === field.id);
  const cargo = ships.reduce((sum, s) => sum + STRATEGIC_RAW.reduce((value, item) => value + qty(s.cargo, item) * itemPrice(item), 0), 0);
  return Math.min(2800, cargo * 0.3 + (extracting ? 180 + Math.min(650, field.amount / 8) : 0));
}

/** Only actual warships and staffed batteries in reach increase the cost of a raid. */
export function strategicDefense(h: WorldSim, company: string, at: Field['pos'], ignore: string): number {
  const w = h.st;
  const contracted = new Set(Object.values(w.contracts).flatMap(k => {
    const m = k.mil;
    if (k.done || !k.takenBy || !m?.group || m.poster !== company || coRelation(w, company, k.takenBy) === -1) return [];
    if (m.ward === ignore || m.field && m.at && dist(m.at, at) < 4500) return [m.group];
    return [];
  }));
  let value = 0;
  for (const g of Object.values(w.groups)) {
    if (g.id === ignore || g.fleeing || !g.shipIds.length || (coRelation(w, company, g.owner) !== 1 && !contracted.has(g.id))) continue;
    for (const s of h.shipsOf(g)) if (s.state === 'space' && !s.warp && econOf(s).military && dist(at, s.pos) <= 5500) {
      value += shipValue(s.classId) * (0.4 + 0.6 * s.hp);
    }
  }
  for (const s of Object.values(w.stations)) {
    if (s.public || dist(s.pos, at) > 5000 || coRelation(w, company, s.owner) !== 1 || !stationSupportOnline(s)) continue;
    value += s.modules.filter(m => m.kind === 'defense' && m.built).length * 300 * s.defenseHp;
  }
  return value;
}
