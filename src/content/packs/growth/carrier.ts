// P16.2 carrier content: strike-craft weapons for the H (hangar) slot, aviation modules for the flight bay,
// and one carrier hull. docs/P16_0_FIGHTERS_CARRIERS.md §5, docs/P16_2_CARRIER_CONTENT.md.
//
// What makes a carrier a carrier is its structure, not its class name: `hangar` hardpoints (only strike craft
// go there, and strike craft go nowhere else) and `flight` bays (only aviation modules) — content/rules.ts.
// Craft numbers start from the P16.1 prototype measurements; final balance is later work.
//
// RELEASE: the carrier hull is a PREVIEW hull (HullDef.preview). Strike craft only fly under battle rules ≥ 3
// and the default is still 2, so the world neither stocks, sells, builds nor offers it (its blueprint is not
// sold or awarded). Its craft weapons and aviation modules have recipes like any equipment, but fit only on
// an H slot / flight bay, which no released hull has.
import type { ArmContent, BlueprintDef, HardpointDef, HullDef, ModuleContent, PresetDef, VariantDef, AirSpec } from '../../schema';
import type { CraftStats } from '../../../sim/data/weapons';

export const CARRIER_HULL = 'carrier_dawn';

// ─────────────────────────────────────────────────────────── strike-craft weapons (H slot, size L)
const CRAFT_FIGHTER: CraftStats = { role: 'fighter', n: 8, spares: 4, hp: 24, speed: 140, agility: 2.2, radius: 1800, sortie: 70, turnaround: 14, launch: 0.6, gun: { damage: 10, pen: 22, range: 260, reload: 0.35 } };
const CRAFT_TORPEDO: CraftStats = { role: 'bomber', n: 6, spares: 3, hp: 36, speed: 110, agility: 1.4, radius: 1800, sortie: 80, turnaround: 20, launch: 0.8, gun: { damage: 6, pen: 12, range: 200, reload: 0.5 }, ordnance: 'air_torpedo' };
const CRAFT_INTERCEPTOR: CraftStats = { role: 'interceptor', n: 8, spares: 4, hp: 20, speed: 165, agility: 2.6, radius: 1200, sortie: 60, turnaround: 12, launch: 0.5, gun: { damage: 8, pen: 12, range: 240, reload: 0.3 } };

/** a craft weapon's combat row: it fires nothing itself (salvo 0); range = operating radius, reload = turnaround */
const wing = (id: string, name: string, role: ArmContent['role'], tech: string, cs: CraftStats, mass: number, power: number, inp: Record<string, number>, time: number, desc: string): ArmContent => ({
  id, name, desc, family: 'craft', tier: 1, role, size: 'L', mass, power, mounts: ['deck'], tech,
  combat: { kind: 'craft', damage: cs.gun?.damage ?? 0, pen: cs.gun?.pen ?? 0, range: cs.radius, speed: cs.speed, reload: cs.turnaround, salvo: 0, salvoGap: 0, spread: 0, turnSpeed: 360, caliber: 1, sound: 'auto', craft: cs },
  recipe: { fac: 'weapons_factory', time, in: inp },
});

export const CARRIER_ARMS: ArmContent[] = [
  wing('eq_wing_fighter', '전투기 비행대', 'general', 'combined_arms', CRAFT_FIGHTER, 22, 3, { structure: 6, engine: 1, electronics: 6, weapon_parts: 4 }, 2400,
    '기관포를 단 다목적 전투기 8기(예비 4). 적 함선과 비행체를 가리지 않고 공격하고, 항모 주변을 엄호한다.'),
  wing('eq_wing_torpedo', '뇌격기 비행대', 'anti-capital', 'torpedo_casting', CRAFT_TORPEDO, 24, 3, { structure: 6, engine: 1, electronics: 4, weapon_parts: 3, munitions: 10 }, 2700,
    '항공 경어뢰를 단 뇌격기 6기(예비 3). 대형함을 골라 출격마다 한 발씩 투하하고 돌아와 재무장한다. 방공포에 약하다.'),
  wing('eq_wing_interceptor', '요격기 비행대', 'anti-small', 'pd_network', CRAFT_INTERCEPTOR, 20, 3, { structure: 5, engine: 1, electronics: 7, weapon_parts: 3 }, 2400,
    '빠르고 가벼운 요격기 8기(예비 4). 적 비행체와 유도탄을 먼저 노리며 작전 반경이 짧다.'),
];

// ─────────────────────────────────────────────────────────── aviation modules (flight bay, size M)
const air = (id: string, name: string, a: AirSpec, mass: number, power: number, fac: string, time: number, inp: Record<string, number>, tech: string, desc: string): ModuleContent => ({
  id, name, desc, slot: 'flight', size: 'M', mass, power, fx: {}, air: a, tech, recipe: { fac, time, in: inp },
});

export const CARRIER_MODULES: ModuleContent[] = [
  // P16.3: the carrier computer (computer bay, any hull): stand-off from enemy guns inside the air wing's radius,
  // evasion when pressed, limited separation from its escorts (sim/ai/computer.ts 'carrier')
  { id: 'cpu_carrier', name: '항모 관제 컴퓨터', slot: 'computer', size: 'S', mass: 2, power: 4, fx: {}, cpu: { arch: 'carrier' }, tech: 'combined_arms',
    recipe: { fac: 'electronics_fab', time: 600, in: { electronics: 6, precision: 3, crystal: 1 } },
    desc: '적 함포 사거리 밖, 비행대 작전 반경 안에 항모를 두고, 적이 다가오거나 유도탄이 오면 회피한다. 호위 함대에서 너무 멀어지지 않는다. 함재기가 없으면 기본 제어.' },
  air('air_hangar_ext', '격납고 확장 모듈', { complement: 2 }, 10, 1, 'machine_shop', 1200, { structure: 8, machinery: 6 }, 'modular_assembly',
    '격납 갑판을 넓혀 H 슬롯마다 동시에 띄우는 기체를 2기 늘린다.'),
  air('air_control', '항공 관제 장치', { control: 1 }, 4, 4, 'electronics_fab', 1200, { electronics: 8, precision: 2 }, 'long_sensors',
    '비행대 관제 회선을 늘려 동시에 임무를 맡길 수 있는 비행대를 하나 더한다.'),
  air('air_maint', '함재기 정비 설비', { turnaround: 0.75, spares: 1.25 }, 8, 2, 'machine_shop', 1200, { machinery: 8, electronics: 2 }, 'damage_control',
    '재무장·정비 시간을 25% 줄이고 전투당 예비 기체를 25% 늘린다.'),
];

// ─────────────────────────────────────────────────────────── carrier hull
const hp = (id: string, pos: [number, number, number], facing: number, arc: number, size: HardpointDef['size'], type: HardpointDef['type'], mount: HardpointDef['mount']): HardpointDef => ({ id, pos, facing, arc, size, type, mount });
/** hardpoint order = combat mount order (custom fittings use it); the battle class loadout mirrors it */
export const DAWN_HP: HardpointDef[] = [
  hp('h1', [4, 6, 18], 90, 180, 'L', 'hangar', 'deck'),
  hp('h2', [-4, 6, 18], -90, 180, 'L', 'hangar', 'deck'),
  hp('h3', [4, 6, -4], 90, 180, 'L', 'hangar', 'deck'),
  hp('h4', [-4, 6, -4], -90, 180, 'L', 'hangar', 'deck'),
  hp('sec1', [0, 5, 27], 0, 140, 'M', 'ballistic', 'turret'),
  hp('sec2', [0, 5, -26], 180, 140, 'M', 'ballistic', 'turret'),
  hp('pd1', [5, 4, 26], 90, 175, 'S', 'pd', 'turret'),
  hp('pd2', [-5, 4, 26], -90, 175, 'S', 'pd', 'turret'),
  hp('pd3', [5, 4, 0], 90, 175, 'S', 'pd', 'turret'),
  hp('pd4', [-5, 4, 0], -90, 175, 'S', 'pd', 'turret'),
  hp('pd5', [5, 4, -26], 90, 175, 'S', 'pd', 'turret'),
  hp('pd6', [-5, 4, -26], -90, 175, 'S', 'pd', 'turret'),
];
/** the standard air group: fighters 2, torpedo bombers 1, interceptors 1, secondary guns 2, point defence 6 */
export const DAWN_STD_WEAPONS: Record<string, string> = {
  h1: 'eq_wing_fighter', h2: 'eq_wing_fighter', h3: 'eq_wing_torpedo', h4: 'eq_wing_interceptor',
  sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun', pd5: 'eq_pd_gun', pd6: 'eq_pd_gun',
};

export const CARRIER_HULLS: HullDef[] = [{
  id: CARRIER_HULL, classId: 'carrier', name: '여명급', maker: '바스티온 공창', tier: 3, size: 'L',
  moduleSlots: 3, power: 52, mass: 170, blueprint: 'rare', preview: true,
  // render-only silhouette until the carrier model (P16.4)
  mesh: { base: 'battlecruiser', scale: 1.15 },
  desc: '격납 갑판 네 곳(H 슬롯)과 항공 장비 베이 세 곳을 갖춘 항모. 함포는 부포와 방공포뿐이고, 화력은 함재기 비행대에서 나온다.',
  ops: { cruise: 88, berth: 'L' },
  build: { yard: 3, time: 16000, credits: 14000, tech: ['capital_hulls', 'combined_arms'], facilities: ['electronics_fab'], parts: { structure: 160, armor_plate: 40, engine: 4, reactor: 3, sensor: 4, electronics: 30, machinery: 20 } },
  upkeep: { credits: 2600, supplies: { chemicals: 2, electronics: 0.3 }, wear: 0.05 },
  // no `sale`: preview hull (see the file header)
  internals: [{ id: 'fl1', kind: 'flight', size: 'M' }, { id: 'fl2', kind: 'flight', size: 'M' }, { id: 'fl3', kind: 'flight', size: 'M' }, { id: 'sen1', kind: 'sensor', size: 'S' }, { id: 'bay1', kind: 'special', size: 'M' }],
  hardpoints: DAWN_HP,
}];

export const CARRIER_VARIANTS: VariantDef[] = [
  { id: 'carrier_dawn_std', hull: CARRIER_HULL, name: '표준형', desc: '격납 갑판 넷, 항공 장비 베이 셋을 갖춘 기본 구조.', blueprint: 'common' },
];

export const CARRIER_PRESETS: PresetDef[] = [
  { id: 'dawn_air_group', hull: CARRIER_HULL, variant: 'carrier_dawn_std', name: '표준 비행단', desc: '전투기 2, 뇌격기 1, 요격기 1 비행대와 부포 2, 방공포 6.', weapons: DAWN_STD_WEAPONS },
];

export const CARRIER_BLUEPRINTS: BlueprintDef[] = [
  // station sources only: a preview hull's blueprint must not take part in random awards (validator)
  { id: 'bp_carrier_dawn', name: '여명급 항모 설계도', desc: '여명급 항모 선체의 건조 권리. 대형 선체와 제병 협동 연구가 필요하다.', grade: 'rare', target: { kind: 'hull', id: CARRIER_HULL },
    sources: [{ kind: 'commercial', stations: ['helios', 'bastion'], price: 160000, rep: 35, contracts: 6 }], requires: ['capital_hulls', 'combined_arms'] },
];

/** P16.3 migration preparation: carrier gear market rows for public stations once carriers are released
 *  (world/industrialGear.ts migrateCarriers — refused while the hull is a preview; NOT run on any world yet).
 *  The stations are the blueprint's commercial sources. */
export const CARRIER_MARKETS: Record<string, string[]> = {
  helios: ['eq_wing_fighter', 'eq_wing_interceptor', 'air_control', 'air_maint', 'cpu_carrier'],
  bastion: ['eq_wing_fighter', 'eq_wing_torpedo', 'air_hangar_ext', 'air_maint', 'cpu_carrier'],
};
