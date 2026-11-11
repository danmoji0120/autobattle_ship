// BB-EX trial fleets: the decisive-fleet opponents used by the combat trials (scripts/bbex-trials.ts,
// tests/bbex-combat.test.ts) and by the ANGEL DESCENT showcase. Opponents are ordinary hulls with
// their ordinary loadouts and commanders — nothing about them is weakened.
import type { FleetSpec, GroupSpec, ShipSpec } from '../fleet';
import type { BattleSetup } from '../world';
import { COMMANDERS } from '../data/commanders';
import { BBEX_CLASS, BBEX_LOADOUT, BB_COMMANDER } from './data';
import type { ExSpec } from './system';

export type Comp = [classId: string, loadoutId: string, n: number][];

const HEG = COMMANDERS.filter(c => c.team === 1);
const TYPE: Record<string, string> = { dreadnought: '초대형 전함', battleship: '전함', battlecruiser: '순양전함', cruiser: '중순양함', light_cruiser: '경순양함', destroyer: '구축함', frigate: '호위함', corvette: '초계함' };

/** a fleet of ordinary hulls in squadrons of `per`, each under a roster commander */
export function lineFleet(name: string, comp: Comp, per = 6, team: 0 | 1 = 1): FleetSpec {
  const roster = team === 1 ? HEG : COMMANDERS.filter(c => c.team === 0);
  const children: GroupSpec[] = [];
  let k = 0;
  for (const [classId, loadoutId, n] of comp) {
    for (let i = 0; i < n; i += per) {
      const ships: ShipSpec[] = Array.from({ length: Math.min(per, n - i) }, () => ({ classId, loadoutId }));
      const c = roster[1 + (k % (roster.length - 1))];
      children.push({ name: `${TYPE[classId] ?? classId} ${Math.floor(i / per) + 1}전대${comp.filter(x => x[0] === classId).length > 1 ? ` (${loadoutId})` : ''}`, commanderId: c.id, order: 'auto', retreatAt: 0, ships, children: [] });
      k++;
    }
  }
  return { name, root: { name, commanderId: roster[0].id, order: 'engage', retreatAt: 0, ships: [], children } };
}

/** BB-EX alone (commander BB unless `bb` is false) */
export function bbexFleet(ex: ExSpec = {}, bb = true, escorts?: FleetSpec): FleetSpec {
  const own: GroupSpec = { name: 'BB-EX', commander: bb ? { ...BB_COMMANDER } : null, order: 'engage', retreatAt: 0, ships: [{ classId: BBEX_CLASS, loadoutId: BBEX_LOADOUT, name: 'BB-EX', ex }], children: [] };
  if (!escorts) return { name: 'BB-EX', root: own };
  return { name: escorts.name, root: { ...escorts.root, children: [...escorts.root.children, { ...own, order: 'engage' }] } };
}

export const DECISIVE_200: Comp = [
  ['dreadnought', 'std', 4], ['dreadnought', 'lance', 2],
  ['battleship', 'std', 18], ['battleship', 'rail', 8], ['battleship', 'fortress', 4],
  ['battlecruiser', 'heavy', 10], ['battlecruiser', 'rail', 5], ['battlecruiser', 'lance', 5],
  ['cruiser', 'multi', 14], ['cruiser', 'missile', 12], ['cruiser', 'gun', 8],
  ['light_cruiser', 'gun', 12], ['light_cruiser', 'missile', 10], ['light_cruiser', 'laser', 8],
  ['destroyer', 'aa', 26], ['destroyer', 'strike', 14],
  ['frigate', 'patrol', 8], ['frigate', 'aa', 8], ['frigate', 'missile', 8],
  ['corvette', 'torp', 10], ['corvette', 'gun', 6],
];

export interface Trial { id: string; name: string; enemy: Comp; ex?: ExSpec; bb?: boolean; note: string }

export const TRIALS: Trial[] = [
  { id: 'bb50', name: '전함 50척', enemy: [['battleship', 'std', 30], ['battleship', 'rail', 12], ['battleship', 'fortress', 8]], note: '목표: 2~3분 내 섬멸' },
  { id: 'bb100', name: '전함 100척', enemy: [['battleship', 'std', 60], ['battleship', 'rail', 24], ['battleship', 'fortress', 16]], note: '목표: 약 5분 내 섬멸' },
  { id: 'mixed200', name: '연합 혼성 결전함대 200척', enemy: DECISIVE_200, note: '단독 승리' },
  { id: 'missile', name: '대규모 미사일 포화 (130척)', enemy: [['cruiser', 'missile', 60], ['light_cruiser', 'missile', 40], ['frigate', 'missile', 30]], note: 'PURPLE RAIN · 퍼널 요격 · BLACKOUT' },
  { id: 'swarm', name: '고속 소형함 160척', enemy: [['corvette', 'torp', 70], ['corvette', 'gun', 50], ['frigate', 'patrol', 40]], note: 'LILAC STINGER · PURPLE RAIN' },
  { id: 'aa', name: '강화 방공망 (120척)', enemy: [['battleship', 'fortress', 30], ['destroyer', 'aa', 60], ['frigate', 'aa', 30]], note: 'SERAPH-EX 공간침투 · 퍼널 소모' },
  { id: 'funnel_loss', name: '퍼널 손실 (4기, 재구성 불가) vs 200척', enemy: DECISIVE_200, ex: { funnels: 4, rebuild: false }, note: '퍼널 손실 이후의 전투' },
  { id: 'no_dcp', name: '주포 비활성화 vs 200척', enemy: DECISIVE_200, ex: { dcp: false }, note: 'DCP-Ω 없는 기본 화력' },
  { id: 'overload', name: 'PARADOX 과부하 상태로 진입 vs 200척', enemy: DECISIVE_200, ex: { paradox: 0 }, note: '결계 없이 시작' },
  { id: 'game_over', name: '결전 프로토콜 즉시 발동 vs 200척', enemy: DECISIVE_200, ex: { over: true }, note: 'BB CHANNEL: GAME OVER' },
  { id: 'no_bb', name: 'BB 미탑승 vs 200척', enemy: DECISIVE_200, bb: false, note: '인과율 간섭·결전 프로토콜 없음' },
];

export function trialSetup(t: Trial, seed: number): BattleSetup {
  return { seed, scenarioId: 'kestrel', layout: 'ranks', timeLimit: 900, fleets: [bbexFleet(t.ex, t.bb !== false), lineFleet('연합 관리청 결전함대', t.enemy)] };
}

/** ANGEL DESCENT: a vanguard is already locked in battle with the Union decisive fleet when the rift
 *  opens in the middle of it */
export function angelDescentSetup(seed: number, opts: { arrive?: number; n?: number } = {}): BattleSetup {
  const vanguard = lineFleet('자유항 전위함대', [['battleship', 'std', 3], ['battlecruiser', 'heavy', 3], ['cruiser', 'multi', 6], ['destroyer', 'aa', 8], ['corvette', 'torp', 8]], 6, 0);
  const scale = (opts.n ?? 200) / 200;
  const enemy = DECISIVE_200.map(([c, l, n]) => [c, l, Math.max(1, Math.round(n * scale))] as [string, string, number]);
  return {
    seed, scenarioId: 'bastion', layout: 'ranks', spawnZ: 1050, timeLimit: 900,
    fleets: [bbexFleet({ arrive: opts.arrive ?? 20, at: { x: 0, y: 46, z: -40 } }, true, vanguard), lineFleet('연합 관리청 결전함대', enemy)],
  };
}
