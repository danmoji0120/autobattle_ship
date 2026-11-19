/** 'craft' (P16, battle rules ≥ 3): a strike-craft weapon on an H (hangar) mount. It fires nothing itself:
 *  the mount launches a squadron of light craft (sim/craft.ts) described by WeaponDef.craft. Its
 *  `salvo` is 0, so generic firepower sums (damage × salvo / reload) count it as no gun firepower. */
export type WeaponKind = 'shell' | 'missile' | 'torpedo' | 'pd' | 'craft' | 'repair';
/** P16: a strike-craft (H slot) weapon — no gun: never part of gun range, gun firepower or gun bands */
export const isCraft = (w: { kind: WeaponKind } | undefined): boolean => w?.kind === 'craft';
/** a weapon that fires at ships itself (shell / missile / torpedo): what gun range and firepower sums count */
export const isShipGun = (w: { kind: WeaponKind } | undefined): boolean => !!w && w.kind !== 'pd' && w.kind !== 'craft' && w.kind !== 'repair';
/** P16.7: a combat repair rig on a support (R) hardpoint — no gun: it repairs friendly ships (sim/repair.ts) */
export const isRepair = (w: { kind: WeaponKind } | undefined): boolean => w?.kind === 'repair';
/** one-line summary of a combat repair rig (UI: fitting, lab, catalogue) */
export function repairSummary(w: { repair?: RepairStats; range: number; reload: number }): string {
  const r = w.repair; if (!r) return '';
  return `응급 수리 — ${w.reload}초마다 아군 1척 · 선체 최대체력 ${(r.hull * 100).toFixed(1)}% · 화재·기관·함교·무장 손상 시간 ${Math.round(r.crit * 100)}% 단축 · 사거리 ${w.range}`;
}
/** P16.7 combat repair rig (kind 'repair'): what one work cycle (`reload` seconds) does to one friendly ship */
export interface RepairStats {
  /** hull restored per cycle, as a share of the target's maximum hull (within the battle's emergency budget) */
  hull: number;
  /** share of the remaining fire / engine / bridge / weapon damage time cut per cycle */
  crit: number;
}
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
  hp?: 'ballistic' | 'energy' | 'missile' | 'pd' | 'hangar' | 'support';
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
  /** P16.7: what a kind 'repair' rig does per cycle */
  repair?: RepairStats;
  /** P17.3 special mechanism (sim/mech17.ts); absent on every older weapon, so older battles replay unchanged */
  mech?: Mech17;
}

/** P17.3 weapon mechanisms. Each one changes what the weapon physically does in the battle (sim/mech17.ts),
 *  not only its numbers; the renderer draws each one (render/mech17Fx.ts). */
export interface Mech17 {
  /** container missile: the mother splits `at` m from its target into `n` real child munitions of weapon
   *  `child`, spread in a cone (rad) over enemy ships within `radius` m of the target. Shot down before
   *  that, it releases nothing. */
  split?: { n: number; child: string; at: number; cone: number; radius: number };
  /** two-stage missile: cruises at `cruise` × speed, drops the booster `at` m out and sprints (full speed,
   *  turn × `turn`; point defence hits the sprint stage less often) */
  stage?: { at: number; cruise: number; turn: number };
  /** decoys: `at` m from the target the missile releases `n` decoys that fly like it (point defence cannot
   *  tell them apart) but carry no warhead */
  decoy?: { n: number; at: number; life: number };
  /** time on target: the rounds of one salvo fan out and pace themselves to arrive together */
  tot?: { slack: number; fan: number };
  /** charged shot: the mount charges `time` s on target before it fires (losing the target drops the charge) */
  charge?: { time: number };
  /** chain arc: on a hit the discharge jumps to up to `n` more enemy ships within `radius` m, × `falloff` each */
  chain?: { n: number; radius: number; falloff: number };
  /** plasma burst: proximity-fused bolt that bursts within `fuse` m of a hull (or at the end of its run) and
   *  burns every enemy ship within `radius` m */
  burst?: { radius: number; fuse: number };
  /** proximity flak (point defence): each shot bursts at the round it tracks and can kill every enemy round
   *  within `radius` m (each with chance `p`) */
  flak?: { radius: number; p: number };
  /** mine: flies to a point ahead of the target, stops, arms after `arm` s and waits `life` s; an enemy hull
   *  within `trigger` m sets it off (blast `radius` m). Point defence can clear it. */
  mine?: { arm: number; trigger: number; radius: number; life: number };
  /** sustained beam: one shot holds the beam for `time` s, a damage pulse every `tick` s while on target */
  sustain?: { time: number; tick: number };
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

/** P17.3 child munitions of the container missiles (WeaponDef.mech.split). Not equipment: nothing fits,
 *  builds or sells them — they exist only as the rounds a container releases in battle. */
export const SUBMUNITIONS: Record<string, WeaponDef> = {
  swarm_dart: {
    id: 'swarm_dart', name: '군집 자탄', kind: 'missile', damage: 46, pen: 48, range: 650, speed: 430, reload: 1, salvo: 1, salvoGap: 0,
    spread: 0, turnSpeed: 360, caliber: 0.4, guidedTurn: 3.0, munitionHp: 1, sound: 'missile', desc: '컨테이너가 뿌린 독립 유도 자탄.',
    family: 'missile', role: 'general', hp: 'missile', vsShield: 0.8, vis: { color: 0xffd090, len: 0, wid: 0.35 },
  },
  cluster_dart: {
    id: 'cluster_dart', name: '확산 자탄', kind: 'missile', damage: 34, pen: 38, range: 520, speed: 460, reload: 1, salvo: 1, salvoGap: 0,
    spread: 0, turnSpeed: 360, caliber: 0.35, guidedTurn: 3.2, munitionHp: 1, sound: 'missile', desc: '확산탄의 경량 자탄.',
    family: 'missile', role: 'anti-small', hp: 'missile', vsShield: 0.8, vis: { color: 0xffe0b0, len: 0, wid: 0.3 },
  },
  swarm_lance: {
    id: 'swarm_lance', name: '관통 자탄', kind: 'missile', damage: 150, pen: 88, range: 760, speed: 380, reload: 1, salvo: 1, salvoGap: 0,
    spread: 0, turnSpeed: 360, caliber: 0.6, guidedTurn: 2.2, munitionHp: 1, sound: 'missile', desc: '관통 컨테이너의 대함 자탄.',
    family: 'missile', role: 'anti-capital', hp: 'missile', vsShield: 0.85, vis: { color: 0xffa070, len: 0, wid: 0.45 },
  },
};
Object.assign(WEAPONS, SUBMUNITIONS);
