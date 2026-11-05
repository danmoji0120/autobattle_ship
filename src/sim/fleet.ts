// Serializable fleet description (used by the setup screen, saves, scenarios and replays).
import { SHIP_CLASSES, shipCost } from './data/ships';

export type InitialOrder = 'auto' | 'engage' | 'flank_left' | 'flank_right' | 'escort' | 'hold' | 'reserve' | 'retreat';

export interface ShipSpec { classId: string; loadoutId: string; name?: string; /** external id (persistent world) */ ref?: string; /** starting hull fraction */ hp?: number; /** fitted equipment / research effects */ fx?: ShipFx }
/** combat effects of fitted modules and research (all default 1, evasion 0) */
export interface ShipFx { hpMul?: number; armorMul?: number; speedMul?: number; accMul?: number; reloadMul?: number; evasion?: number; pdMul?: number; rangeMul?: number; magMul?: number }

export interface GroupSpec {
  name: string;
  commanderId?: string | null;
  /** inline commander (persistent world commanders are not in the static roster) */
  commander?: import('./data/commanders').CommanderDef | null;
  /** external id (persistent world group / synthetic root) */
  ref?: string;
  order: InitialOrder;
  /** for escort: index path of the group to protect; empty → nearest line sibling */
  escortTarget?: string;
  retreatAt: number; // 0 = never
  ships: ShipSpec[];
  children: GroupSpec[];
}

export interface FleetSpec { name: string; root: GroupSpec }

export const INITIAL_ORDER_TEXT: Record<InitialOrder, string> = {
  auto: '상급 지휘관에 위임',
  engage: '자유 교전',
  flank_left: '좌측 우회',
  flank_right: '우측 우회',
  escort: '아군 호위',
  hold: '진지 사수',
  reserve: '예비대 (대기 후 투입)',
  retreat: '후퇴',
};

export function fleetCost(f: FleetSpec): number {
  let c = 0;
  walk(f.root, g => { for (const s of g.ships) c += shipCost(s.classId, s.loadoutId); });
  return c;
}

export function fleetShipCount(f: FleetSpec): number {
  let c = 0; walk(f.root, g => { c += g.ships.length; }); return c;
}

export function walk(g: GroupSpec, fn: (g: GroupSpec, depth: number, parent: GroupSpec | null) => void, depth = 0, parent: GroupSpec | null = null) {
  fn(g, depth, parent);
  for (const c of g.children) walk(c, fn, depth + 1, g);
}

export function cloneFleet(f: FleetSpec): FleetSpec { return JSON.parse(JSON.stringify(f)); }

export function validateFleet(f: unknown): f is FleetSpec {
  if (!f || typeof f !== 'object') return false;
  const ff = f as FleetSpec;
  if (typeof ff.name !== 'string' || !ff.root) return false;
  let ok = true;
  const check = (g: GroupSpec) => {
    if (!g || typeof g.name !== 'string' || !Array.isArray(g.ships) || !Array.isArray(g.children)) { ok = false; return; }
    for (const s of g.ships) if (!SHIP_CLASSES[s.classId]) ok = false;
    g.children.forEach(check);
  };
  check(ff.root);
  return ok;
}

const S = (classId: string, loadoutId: string): ShipSpec => ({ classId, loadoutId });

export function defaultPlayerFleet(): FleetSpec {
  return {
    name: '연합 제7 기동함대',
    root: {
      name: '제7 기동함대', commanderId: 'barros', order: 'engage', retreatAt: 0, ships: [],
      children: [
        { name: '주력 전대', commanderId: 'wolf', order: 'auto', retreatAt: 0.25,
          ships: [S('battleship', 'std'), S('battleship', 'std'), S('cruiser', 'multi')], children: [] },
        { name: '호위 전대', commanderId: 'song', order: 'auto', retreatAt: 0.2,
          ships: [S('destroyer', 'aa'), S('destroyer', 'aa'), S('destroyer', 'aa'), S('destroyer', 'strike')], children: [] },
        { name: '지원 전대', commanderId: 'mizuki', order: 'auto', retreatAt: 0.3,
          ships: [S('cruiser', 'missile'), S('cruiser', 'missile')], children: [] },
        { name: '강습 전대', commanderId: 'kairen', order: 'auto', retreatAt: 0, ships: [],
          children: [
            { name: '뇌격 1편대', commanderId: 'kostov', order: 'auto', retreatAt: 0, ships: [S('corvette', 'torp'), S('corvette', 'torp'), S('corvette', 'torp')], children: [] },
            { name: '뇌격 2편대', commanderId: 'gray', order: 'auto', retreatAt: 0, ships: [S('corvette', 'torp'), S('corvette', 'torp'), S('corvette', 'torp'), S('corvette', 'gun')], children: [] },
          ] },
      ],
    },
  };
}

export const PLAYER_BUDGET = 1700;
