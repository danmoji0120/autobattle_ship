// BB-EX — static combat data (class, exclusive weapons, mount layout, tuning).
//
// One source of truth: the combat engine reads it directly, the content pack
// (src/content/packs/bbex) derives the hull's hardpoints and equipment from it, and the renderer
// reads the layout for the hull model. Everything here is account-exclusive content: the class is
// registered NON-ENUMERABLE in SHIP_CLASSES, so catalogues, the fleet editor, the legacy-loadout
// validator and every other "for each class" loop never see it — it only exists where it is asked
// for by id.
import { SHIP_CLASSES, type MountDef, type ShipClassDef } from '../data/ships';
import { WEAPONS, type WeaponDef } from '../data/weapons';
import type { CommanderDef } from '../data/commanders';

export const BBEX_CLASS = 'bbex';
export const BBEX_LOADOUT = 'angel';
export const BBEX_COMMANDER = 'bb';

/** exclusive weapon ids (combat ids; the equipment ids are `eq_<id>`) */
export const BBEX_WEAPON = {
  dcp: 'dcp_omega', lance: 'abyss_lance', edge: 'violet_edge', stinger: 'lilac_stinger',
  seraph: 'seraph_ex', rain: 'purple_rain', funnel: 'fnl_ex',
} as const;

// ─────────────────────────────────────────────────────────────────────────── tuning
export const BBEX = {
  funnels: 12,
  // ── arrival (ANGEL DESCENT phases 2–3)
  riftTime: 3.2,            // the rift is open this long before the hull emerges
  descentTime: 5.2,         // funnels eject, wings unfold, PARADOX deploys
  funnelStagger: 0.16,      // seconds between funnel ejections
  // ── FNL-EX funnels
  fHp: 420, fSpeed: 300, fBoost: 620, fAccel: 520, fRange: 380, fReload: 0.82, fEvade: 0.62,
  fRebuild: 13,             // REGENESIS rebuilds a lost funnel after this many seconds
  fGuardMin: 3, fGuardMax: 9, fInterceptRange: 430, fInterceptChance: 0.34,
  // ── PARADOX — local space displacement
  pField: 13,               // radius of the displacement field around the hull axis
  pEnergy: 12000, pRegen: 420, pDisplace: 0.84, pDisplaceSat: 0.5, pLoadSat: 28,
  pOverload: 7, pOverloadDisplace: 0.34, pReboot: 0.45,
  // ── REGENESIS
  regen: 0.0085,            // hull fraction per second
  // ── DCP-Ω
  dcpLock: 1.1, dcpCharge: 2.6, dcpFire: 1.15, dcpCool: 24, dcpPulse: 3,   // ticks between cut pulses
  dcpRange: 2700, dcpSeg: 1900, dcpRadius: 10, dcpDamage: 1250,              // per pulse, primary beam
  dcpFalloff: [1, 0.56, 0.38, 0.27, 0.21, 0.17],
  dcpWidth: [11, 7.5, 5, 3.6, 2.8, 2.2],
  dcpDepth: 3, dcpSplit: 3, dcpMaxSeg: 14,
  // ── BLACKOUT
  boEvery: 15, boRadius: 2100, boTime: 7.5, boSpread: 1.9, boMissileLoss: 0.4,
  // ── GRAVITY WELL
  gwEvery: 21, gwRadius: 460, gwTime: 7.5, gwPull: 30, gwDrag: 1.5, gwRange: 2600,
  // ── PHANTOM SHIFT
  psCool: 17, psRange: 820,
  // ── causality interference (commander BB)
  cVetoes: 3, cVetoCool: 38, cRewrite: 0.55, cDenyCool: 7, cDenyMin: 200,
  // ── BB CHANNEL: GAME OVER
  goSpread: 1.6, goCharge: 2.2, goFire: 2.5, goReplan: 24, goCool: 100, goDepth: 5, goSplit: 3, goMaxSeg: 34, goDamage: 0.6, goReload: 0.5,
} as const;

// ─────────────────────────────────────────────────────────────────────────── weapons
const W: WeaponDef[] = [
  {
    id: BBEX_WEAPON.dcp, name: 'DCP-Ω 차원절단입자포', kind: 'shell', special: 'dcp',
    damage: 9000, pen: 999, range: BBEX.dcpRange, speed: 99999, reload: 24, salvo: 1, salvoGap: 0, spread: 0, turnSpeed: 40, caliber: 4.2,
    family: 'particle', tier: 5, role: 'anti-capital', hp: 'energy', vsShield: 2, sound: 'dcp_fire',
    vis: { color: 0xd9a8ff, len: 200, wid: 9, beam: true },
    desc: '반중력 입자유도식 국소공간 전이포. 공간 경계 자체를 재단하고, 퍼널이 펼친 공간 반사면을 따라 반사·분기해 함대 전체를 절단한다. 장갑은 의미가 없다.',
  },
  {
    id: BBEX_WEAPON.lance, name: 'ABYSS-LANCE 심연관통포', kind: 'shell', pierce: 3,
    damage: 620, pen: 175, range: 2100, speed: 3600, reload: 3.6, salvo: 1, salvoGap: 0, spread: 0.0022, turnSpeed: 80, caliber: 2.6,
    family: 'particle', tier: 5, role: 'anti-capital', hp: 'energy', vsShield: 1.35, sound: 'ex_lance',
    vis: { color: 0x9a3cff, len: 170, wid: 3.4 },
    desc: '짙은 자주색 에너지를 응축해 청백색 입자창으로 쏘아내는 대(對)대형함 주포. 전함의 장갑을 꿰뚫고 뒤의 함선까지 관통한다.',
  },
  {
    id: BBEX_WEAPON.edge, name: 'VIOLET EDGE 위상절삭포', kind: 'shell',
    damage: 46, pen: 80, range: 1500, speed: 5600, reload: 0.5, salvo: 1, salvoGap: 0, spread: 0.003, turnSpeed: 170, caliber: 1.2,
    family: 'laser', tier: 5, role: 'general', hp: 'energy', vsShield: 1.3, sound: 'ex_edge',
    vis: { color: 0xc77dff, len: 90, wid: 0.9, beam: true },
    desc: '얇고 날카로운 위상 절삭광을 빠르게 연사한다. 순양함과 구축함의 장갑에 발광 균열을 새긴다.',
  },
  {
    id: BBEX_WEAPON.stinger, name: 'LILAC STINGER 자율추적 광자포', kind: 'shell', seek: 2.6,
    damage: 20, pen: 30, range: 1150, speed: 1500, reload: 0.11, salvo: 1, salvoGap: 0, spread: 0.014, turnSpeed: 280, caliber: 0.6,
    family: 'plasma', tier: 5, role: 'anti-small', hp: 'energy', vsShield: 1.2, sound: 'ex_stinger',
    vis: { color: 0xff8be8, len: 13, wid: 0.75 },
    desc: '스스로 표적을 좇는 분홍빛 광자탄의 탄막. 고속 소형함이 숨을 곳이 없다.',
  },
  {
    id: BBEX_WEAPON.seraph, name: 'SERAPH-EX 공간침투 유도탄', kind: 'missile', phase: true,
    damage: 150, pen: 118, range: 2600, speed: 440, reload: 9.5, salvo: 6, salvoGap: 0.11, spread: 0.2, turnSpeed: 360, caliber: 1.2,
    guidedTurn: 2.7, munitionHp: 3, family: 'missile', tier: 5, role: 'general', hp: 'missile', vsShield: 1, sound: 'ex_seraph',
    vis: { color: 0xb46bff, len: 30, wid: 1 },
    desc: '방공망 앞에서 공간을 건너뛰어 재출현하는 유도탄. 탄두를 함내에서 직접 합성하므로 탄창 한도가 없다.',
  },
  {
    id: BBEX_WEAPON.rain, name: 'PURPLE RAIN 광자방어 어레이', kind: 'pd',
    damage: 22, pen: 24, range: 580, speed: 0, reload: 0.08, salvo: 1, salvoGap: 0, spread: 0, turnSpeed: 520, caliber: 0.5, pdChance: 0.42,
    family: 'pd', tier: 5, role: 'pd', hp: 'pd', vsShield: 1, sound: 'ex_rain',
    vis: { color: 0xc9a0ff, len: 10, wid: 0.4, beam: true },
    desc: '선체 전체에 매립된 16개 발진기의 광선망. 미사일과 어뢰를 걷어내고 접근한 소형함을 갈아낸다.',
  },
  {
    id: BBEX_WEAPON.funnel, name: 'FNL-EX 퍼널 광자포', kind: 'shell',
    damage: 88, pen: 105, range: BBEX.fRange, speed: 99999, reload: BBEX.fReload, salvo: 1, salvoGap: 0, spread: 0, turnSpeed: 999, caliber: 1,
    family: 'laser', tier: 5, role: 'general', hp: 'energy', vsShield: 1.3, sound: 'ex_funnel',
    vis: { color: 0xe0b0ff, len: 60, wid: 1.1, beam: true },
    desc: '다목적 퍼널의 고출력 광자포.',
  },
];
for (const w of W) WEAPONS[w.id] ??= w;

// ─────────────────────────────────────────────────────────────────────────── mount layout
const m = (weapon: string, pos: [number, number, number], facing: number, arc: number): MountDef => ({ weapon, pos, facing, arc });
const pair = (weapon: string, x: number, y: number, z: number, facing: number, arc: number): MountDef[] => [m(weapon, [x, y, z], facing, arc), m(weapon, [-x, y, z], -facing, arc)];

/** hardpoint ids, in mount order (the content hull uses the same order, so `fit.mounts` built from
 *  the hull's hardpoints equals this list exactly) */
export const BBEX_MOUNTS: { id: string; mount: MountDef; size: 'S' | 'M' | 'L' | 'XL'; style: 'turret' | 'fixed' | 'vls' | 'spinal'; type: 'energy' | 'missile' | 'pd' }[] = [];
{
  const add = (prefix: string, list: MountDef[], size: 'S' | 'M' | 'L' | 'XL', style: 'turret' | 'fixed' | 'vls' | 'spinal', type: 'energy' | 'missile' | 'pd') =>
    list.forEach((mount, i) => BBEX_MOUNTS.push({ id: `${prefix}${String(i + 1).padStart(2, '0')}`, mount, size, style, type }));
  // DCP-Ω: keel-long emitter between the twin prows
  add('dcp', [m(BBEX_WEAPON.dcp, [0, 0.4, 17.5], 0, 14)], 'XL', 'spinal', 'energy');
  // ABYSS-LANCE ×4: two forward blisters, two aft dorsal barbettes
  add('lance', [...pair(BBEX_WEAPON.lance, 2.7, 2.5, 8.6, 18, 160), ...pair(BBEX_WEAPON.lance, 2.9, 2.9, -7.8, 162, 160)], 'L', 'turret', 'energy');
  // VIOLET EDGE ×8: flank blades
  add('edge', [...pair(BBEX_WEAPON.edge, 3.9, 1.3, 12.4, 62, 130), ...pair(BBEX_WEAPON.edge, 4.9, 1.0, 4.4, 88, 130), ...pair(BBEX_WEAPON.edge, 5.1, 1.0, -3.2, 96, 130), ...pair(BBEX_WEAPON.edge, 4.5, 1.3, -12.2, 122, 130)], 'M', 'turret', 'energy');
  // LILAC STINGER ×8: dorsal and ventral ball mounts
  add('sting', [...pair(BBEX_WEAPON.stinger, 1.5, 3.3, 13.2, 40, 175), ...pair(BBEX_WEAPON.stinger, 2.1, 3.7, 1.6, 90, 175), ...pair(BBEX_WEAPON.stinger, 2.0, -2.5, 6.4, 80, 175), ...pair(BBEX_WEAPON.stinger, 2.0, -2.5, -8.2, 110, 175)], 'S', 'turret', 'energy');
  // SERAPH-EX ×8: two dorsal cell blocks
  add('vls', [...pair(BBEX_WEAPON.seraph, 1.35, 3.3, -1.6, 0, 180), ...pair(BBEX_WEAPON.seraph, 1.35, 3.3, -4.2, 0, 180), ...pair(BBEX_WEAPON.seraph, 1.35, 3.2, -11.2, 0, 180), ...pair(BBEX_WEAPON.seraph, 1.35, 3.2, -13.8, 0, 180)], 'M', 'vls', 'missile');
  // PURPLE RAIN ×16: flush emitters around the whole hull
  add('rain', [
    ...pair(BBEX_WEAPON.rain, 3.3, 2.0, 16.2, 60, 180), ...pair(BBEX_WEAPON.rain, 5.2, 0.1, 8.6, 90, 180), ...pair(BBEX_WEAPON.rain, 5.6, 0.1, 0.6, 90, 180), ...pair(BBEX_WEAPON.rain, 5.3, 0.1, -7.6, 90, 180),
    ...pair(BBEX_WEAPON.rain, 4.0, 1.7, -16.4, 130, 180), ...pair(BBEX_WEAPON.rain, 2.9, -2.2, 12.2, 70, 180), ...pair(BBEX_WEAPON.rain, 3.3, -2.4, -1.2, 90, 180), ...pair(BBEX_WEAPON.rain, 2.9, -2.2, -14.2, 120, 180),
  ], 'S', 'turret', 'pd');
}

export const BBEX_CLASS_DEF: ShipClassDef = {
  id: BBEX_CLASS, name: 'BB-EX', enemyName: 'BB-EX', type: '실험형 경순양함', role: 'line',
  length: 42, radius: 5, hp: 54000, armor: { front: 112, side: 98, rear: 84 },
  maxSpeed: 86, accel: 34, turnRate: 46, lateral: 0.8, cost: 12000,
  desc: '세계에 단 한 척뿐인 실험형 지휘·전자전 경순양함. 공간 제어와 12기의 다목적 퍼널, 차원절단입자포로 함대 하나를 상대한다.',
  loadouts: [{ id: BBEX_LOADOUT, name: 'ANGEL DESCENT', desc: 'DCP-Ω 1 · ABYSS-LANCE 4 · VIOLET EDGE 8 · LILAC STINGER 8 · SERAPH-EX 8 · PURPLE RAIN 16 · FNL-EX 12', mounts: BBEX_MOUNTS.map(x => x.mount), mesh: { base: 'bbex', scale: 1 } }],
};
// Non-enumerable on purpose (see the header): lookups by id work, enumeration never reveals it.
if (!Object.getOwnPropertyDescriptor(SHIP_CLASSES, BBEX_CLASS)) Object.defineProperty(SHIP_CLASSES, BBEX_CLASS, { value: BBEX_CLASS_DEF, enumerable: false, writable: false, configurable: false });

/** BB — the one commander of BB-EX. Not in the COMMANDERS roster (never offered anywhere). */
export const BB_COMMANDER: CommanderDef = {
  id: BBEX_COMMANDER, team: 0, name: 'BB', rank: '', skill: 0.98, aggression: 0.72, discipline: 0.95, specialty: 'tactics', voice: 'cold', color: '#c77dff',
  bio: 'BB-EX의 유일한 지휘관. 전투 결과가 확정되기 전에 개입하는 인과율 간섭 능력을 지녔다.', causal: true,
};

export const isBbexClass = (classId: string) => classId === BBEX_CLASS;
