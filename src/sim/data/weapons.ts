/** 'craft' (P16, battle rules ≥ 3): a strike-craft weapon on an H (hangar) mount. It fires nothing itself:
 *  the mount launches a squadron of light craft (sim/craft.ts) described by WeaponDef.craft. Its
 *  `salvo` is 0, so generic firepower sums (damage × salvo / reload) count it as no gun firepower. */
export type WeaponKind = 'shell' | 'missile' | 'torpedo' | 'pd' | 'craft';
/** P16: a strike-craft (H slot) weapon — no gun: never part of gun range, gun firepower or gun bands */
export const isCraft = (w: { kind: WeaponKind } | undefined): boolean => w?.kind === 'craft';
/** a weapon that fires at ships itself (shell / missile / torpedo): what gun range and firepower sums count */
export const isShipGun = (w: { kind: WeaponKind } | undefined): boolean => !!w && w.kind !== 'pd' && w.kind !== 'craft';
const ROLE_KO = { fighter: '전투기', bomber: '뇌격기', interceptor: '요격기' } as const;
/** one-line summary of a strike-craft weapon (UI: fitting, lab, catalogue) */
export function craftSummary(w: { craft?: CraftStats }): string {
  const c = w.craft; if (!c) return '';
  return `${ROLE_KO[c.role]} ${c.n}기 (예비 ${c.spares}) · 작전 반경 ${c.radius} · 출격 ${c.sortie}초 · 재출격 준비 ${c.turnaround}초${c.ordnance ? ` · 대함: ${WEAPONS[c.ordnance]?.name ?? c.ordnance}` : ''}`;
}

/** P16 strike craft carried by a 'craft' weapon (docs/P16_0_FIGHTERS_CARRIERS.md §5.1). Everything is per
 *  battle: losses are replaced from `spares`, nothing carries over to the next battle. */
export interface CraftStats {
  /** target preference: fighter = ships and craft, bomber = large ships (ordnance), interceptor = craft and guided rounds */
  role: 'fighter' | 'bomber' | 'interceptor';
  /** complement: craft this mount keeps in the air at once */
  n: number;
  /** spare airframes for this battle (replace losses) */
  spares: number;
  hp: number;
  /** m/s, rad/s turn rate */
  speed: number; agility: number;
  /** operating radius from the carrier: targets beyond it are not attacked */
  radius: number;
  /** seconds per sortie; then the craft returns (or, without a carrier, leaves) */
  sortie: number;
  /** seconds to re-arm a recovered craft or ready a spare */
  turnaround: number;
  /** seconds between launches from this mount */
  launch: number;
  /** hitscan gun (no munition objects) */
  gun?: { damage: number; pen: number; range: number; reload: number };
  /** anti-ship ordnance: a WEAPONS id fired as an ordinary munition, once per sortie */
  ordnance?: string;
}

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  damage: number;
  pen: number;          // armor penetration
  range: number;
  speed: number;        // projectile speed (u/s); pd is hitscan
  reload: number;       // seconds between salvos
  salvo: number;        // shots per salvo
  salvoGap: number;     // seconds between shots in a salvo
  spread: number;       // radians dispersion (1 sigma)
  turnSpeed: number;    // turret traverse deg/s
  caliber: number;      // visual size scale
  guidedTurn?: number;  // rad/s for guided munitions
  munitionHp?: number;  // hits needed for PD to kill
  pdChance?: number;    // PD hit chance per shot vs missiles
  magazine?: number;    // salvos available (undefined = unlimited)
  sound: string;
  desc: string;
  // ── P5 (growth content; absent on the built-in weapons in c0 combat, which never meets shields)
  /** family / tier in the arsenal tree */
  family?: string;
  tier?: number;
  /** what it is for (target preference) */
  role?: 'anti-small' | 'general' | 'anti-capital' | 'pd';
  /** hardpoint category (default: derived from kind / built-in ids) */
  hp?: 'ballistic' | 'energy' | 'missile' | 'pd' | 'hangar';
  /** effectiveness against shields (default 1) */
  vsShield?: number;
  /** combat visual: tracer/beam colour (0xRRGGBB) and size */
  vis?: { color: number; len: number; wid: number; beam?: boolean };
  // ── exotic behaviours (BB-EX exclusive weapons; absent everywhere else)
  /** a shell that keeps flying through this many extra hulls after its first hit */
  pierce?: number;
  /** a shell that steers toward its target (rad/s) */
  seek?: number;
  /** a guided munition that skips ahead through space once, past the outer point-defence envelope */
  phase?: boolean;
  /** not fired by the ordinary mount logic: driven by its own system (sim/bbex/system.ts) */
  special?: 'dcp';
  /** P15 battle rules (BattleSetup.rules ≥ 1; older recorded battles keep the fields above unchanged):
   *  `unguided` — leaves the tube on a lead solution and runs straight (no homing, no retargeting);
   *  `magazine` — salvos carried, for a weapon that had no magazine before */
  p15?: { unguided?: boolean; magazine?: number };
  /** P16: strike craft launched by a kind 'craft' weapon */
  craft?: CraftStats;
}

export const WEAPONS: Record<string, WeaponDef> = {
  heavy_cannon: {
    id: 'heavy_cannon', name: '460mm 질량투사 주포', kind: 'shell',
    damage: 360, pen: 88, range: 1550, speed: 620, reload: 8.5, salvo: 3, salvoGap: 0.14,
    spread: 0.0085, turnSpeed: 22, caliber: 3.2, sound: 'heavy', desc: '전함의 상징. 느리지만 거함의 장갑을 찢는다.',
  },
  rail_cannon: {
    id: 'rail_cannon', name: '전자기 레일 캐논', kind: 'shell',
    damage: 300, pen: 120, range: 2000, speed: 1400, reload: 10, salvo: 2, salvoGap: 0.25,
    spread: 0.0045, turnSpeed: 14, caliber: 2.4, sound: 'rail', desc: '초고속 관통탄. 장거리 저격용, 회피가 거의 불가능.',
  },
  medium_gun: {
    id: 'medium_gun', name: '155mm 속사 부포', kind: 'shell',
    damage: 68, pen: 42, range: 950, speed: 820, reload: 2.4, salvo: 2, salvoGap: 0.16,
    spread: 0.014, turnSpeed: 55, caliber: 1.4, sound: 'medium', desc: '균형 잡힌 다목적 포. 순양함 이하에 유효.',
  },
  autocannon: {
    id: 'autocannon', name: '30mm 회전 기관포', kind: 'shell',
    damage: 12, pen: 15, range: 560, speed: 1100, reload: 0.11, salvo: 1, salvoGap: 0,
    spread: 0.028, turnSpeed: 220, caliber: 0.6, sound: 'auto', desc: '경함정 사냥용 탄막. 중장갑엔 튕겨나간다.',
  },
  missile_rack: {
    id: 'missile_rack', name: 'VLS 대함 미사일', kind: 'missile',
    damage: 125, pen: 58, range: 1650, speed: 270, reload: 15, salvo: 4, salvoGap: 0.25, magazine: 6,
    spread: 0.2, turnSpeed: 360, caliber: 1.0, guidedTurn: 1.7, munitionHp: 1, sound: 'missile',
    desc: '수직발사 유도탄. 일제 사격으로 방공망을 포화시킨다.',
  },
  torpedo: {
    id: 'torpedo', name: '중(重) 플라즈마 어뢰', kind: 'torpedo',
    damage: 1100, pen: 100, range: 820, speed: 175, reload: 21, salvo: 2, salvoGap: 0.45,
    spread: 0.05, turnSpeed: 360, caliber: 1.8, guidedTurn: 0.65, munitionHp: 2, sound: 'torpedo', p15: { unguided: true },
    desc: '비유도 플라즈마 어뢰. 발사 순간의 예측 사격 방향으로 직진하며 탄약 제한이 없다. 크고 느린 함선을 근접에서 노리는 필살의 일격.',
  },
  pd_gun: {
    id: 'pd_gun', name: '근접 방어 기관포', kind: 'pd',
    damage: 4, pen: 8, range: 320, speed: 0, reload: 0.1, salvo: 1, salvoGap: 0,
    spread: 0, turnSpeed: 400, caliber: 0.4, pdChance: 0.05, sound: 'pd',
    desc: '미사일과 어뢰를 요격한다. 접근한 초계함도 긁는다.',
  },
  pulse_laser: {
    id: 'pulse_laser', name: '펄스 레이저', kind: 'shell',
    damage: 40, pen: 34, range: 900, speed: 3200, reload: 1.6, salvo: 3, salvoGap: 0.08,
    spread: 0.004, turnSpeed: 90, caliber: 1.0, sound: 'medium', desc: '거의 즉발하는 에너지 펄스. 빠른 표적에 강하고 중장갑엔 약하다.',
  },
  particle_lance: {
    id: 'particle_lance', name: '입자 창', kind: 'shell',
    damage: 520, pen: 110, range: 1800, speed: 2600, reload: 12, salvo: 1, salvoGap: 0,
    spread: 0.003, turnSpeed: 16, caliber: 2.8, sound: 'rail', desc: '고출력 입자빔. 먼 거리에서 대형함의 장갑을 꿰뚫는다.',
  },
  // P16: ordnance of strike craft (CraftStats.ordnance). Not equipment and on no hardpoint: a torpedo bomber
  // drops one per sortie as an ordinary munition (ship point defence, guidance and hull rules apply).
  air_torpedo: {
    id: 'air_torpedo', name: '항공 경어뢰', kind: 'torpedo',
    damage: 520, pen: 80, range: 700, speed: 200, reload: 1, salvo: 1, salvoGap: 0,
    spread: 0.03, turnSpeed: 360, caliber: 1, guidedTurn: 0.9, munitionHp: 2, sound: 'torpedo',
    desc: '뇌격기가 출격마다 한 발 투하하는 경어뢰. 함재기 전용 탄체.',
  },
};
