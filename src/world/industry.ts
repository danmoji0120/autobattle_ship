// SIDERARIUM industry data: items, facilities, recipes, hull production, equipment and research.
// Everything here is plain data; the server-side engine (production.ts / research.ts) interprets it
// and the client renders it. Adding content = adding rows.
import type { Size } from '../content/schema';
import { REGIONAL_RECIPE_INPUTS, regionalOn } from './regional';

// ─────────────────────────────────────────────────────────────── items

export type ItemCat = 'raw' | 'refined' | 'part' | 'shippart' | 'equip' | 'blueprint';
export interface ItemDef { id: string; name: string; cat: ItemCat; tier: number; price: number; color: string; desc: string; /** growth-only content (contentV ≥ 3) */ growth?: boolean; /** available through P9.7 regional industry */ regional?: boolean }

export const ITEM_CAT_NAME: Record<ItemCat, string> = { raw: '원자재', refined: '정제 소재', part: '산업 부품', shippart: '함선 부품', equip: '장비·무장', blueprint: '설계도' };

const it = (id: string, name: string, cat: ItemCat, tier: number, price: number, color: string, desc: string): ItemDef => ({ id, name, cat, tier, price, color, desc });

export const ITEMS: Record<string, ItemDef> = Object.fromEntries([
  // raw (mined)
  it('ore', '철광석', 'raw', 1, 10, '#d9a06b', '가장 흔한 광석. 정련하면 금속이 된다.'),
  it('silicate', '규산염', 'raw', 1, 9, '#c9c3a0', '암석질 소행성의 주성분. 제련하면 실리콘.'),
  it('titanium_ore', '티타늄광', 'raw', 1, 18, '#a8b8c8', '고강도 금속의 원료.'),
  it('rare_ore', '희토류광', 'raw', 1, 45, '#c890ff', '전자부품과 반응로에 필요한 희귀 광물.'),
  it('gas', '수소 가스', 'raw', 1, 12, '#9fe7d0', '가스 구름·빙결대에서 채취. 화학소재의 원료.'),
  it('crystal', '크리스탈', 'raw', 1, 100, '#7fd8ff', '희귀 결정. 센서·반응로·고급 전자장비에 쓰인다.'),
  { ...it('dense_titanium_ore', '고밀도 티타늄 원광', 'raw', 3, 100, '#b6d5e3', '앤빌 광구의 고밀도 원광. 특수 합금의 원료.'), regional: true },
  { ...it('resonant_crystal', '공명 결정', 'raw', 3, 150, '#b6a4ff', '파편 항로의 결정. 공명 광학 소재의 원료.'), regional: true },
  { ...it('unstable_isotope', '불안정 동위원소', 'raw', 3, 130, '#f3b779', '황혼 광맥에서 채취하는 동력 소재.'), regional: true },
  { ...it('singular_ore', '특이 광석', 'raw', 3, 220, '#de99f3', '검은 관문의 특수 광석. 최상위 선체의 원료.'), regional: true },
  // refined
  it('metal', '정련 금속', 'refined', 2, 24, '#c0a890', '철광석을 정련한 기본 금속.'),
  it('alloy', '합금', 'refined', 2, 32, '#b8c8d8', '금속과 티타늄의 고강도 합금. 건설과 조선의 기본 소재.'),
  it('titanium', '티타늄', 'refined', 2, 48, '#d0dcea', '경량 고강도 금속.'),
  it('silicon', '실리콘', 'refined', 2, 26, '#e0d8b0', '전자부품용 반도체 소재.'),
  it('chemicals', '화학소재', 'refined', 2, 30, '#80e0b0', '연료, 폭약, 수지의 원료.'),
  it('composite', '복합소재', 'refined', 2, 70, '#e8c070', '실리콘·화학소재·금속을 결합한 장갑·구조용 소재.'),
  it('rare_metal', '희토류 금속', 'refined', 2, 120, '#d8a8ff', '정제된 희토류. 고급 부품의 핵심.'),
  { ...it('dense_alloy', '고강도 특수 합금', 'refined', 3, 300, '#c2e3ee', '고밀도 원광을 제련한 고급 장갑·무장 소재.'), regional: true },
  { ...it('resonant_optics', '공명 광학 소재', 'refined', 3, 650, '#cdbbff', '공명 결정을 정제한 고출력 광학 소재.'), regional: true },
  { ...it('stabilized_isotope', '안정화 동위원소', 'refined', 3, 600, '#ffcba0', '고출력 동력 장치에 사용하는 안정화 소재.'), regional: true },
  { ...it('singular_alloy', '특이 합금', 'refined', 4, 1800, '#e9bcf5', '특이 광석과 고밀도 합금을 결합한 최상위 소재.'), regional: true },
  // industrial parts
  it('machinery', '기계부품', 'part', 3, 90, '#c8b090', '모터, 기어, 유압장치.'),
  it('electronics', '전자부품', 'part', 3, 150, '#80c8ff', '회로, 프로세서, 배선.'),
  it('structure', '구조재', 'part', 3, 70, '#a0a8b0', '함체와 정거장의 골조 부재.'),
  it('precision', '정밀부품', 'part', 3, 210, '#f0d080', '정밀 가공된 베어링, 노즐, 렌즈.'),
  // ship parts
  it('engine', '엔진', 'shippart', 4, 1400, '#ffb070', '함선용 추진기 모듈.'),
  it('reactor', '반응로', 'shippart', 4, 2600, '#ff8080', '함선 동력원.'),
  it('sensor', '센서', 'shippart', 4, 1200, '#90e0ff', '탐색·사격통제 센서 묶음.'),
  it('armor_plate', '장갑판', 'shippart', 4, 260, '#b0b8c0', '함체 장갑 블록.'),
  it('weapon_parts', '무장 부품', 'shippart', 4, 420, '#ff9a7a', '포신, 급탄기, 발사관.'),
].map(x => [x.id, x]));

// ─────────────────────────────────────────────────────────────── equipment (fittings)

export type EquipKind = 'weapon' | 'module';
export interface EquipDef {
  id: string; name: string; kind: EquipKind;
  /** weapon id in the combat engine (weapons are mounted by loadouts) */
  weapon?: string;
  /** fitting slot size it needs (S=1, M=2, L=3) */
  size: 1 | 2 | 3;
  /** module effects on the hull in battle */
  fx?: Partial<FitFx>;
  /** growth combat effects (shields, …) — applied only in growth worlds */
  cfx?: import('../content/schema').CombatFx;
  /** goods consumed per hour of service (growth upkeep) */
  supply?: Record<string, number>;
  /** growth-only content (contentV ≥ 3) */
  growth?: boolean;
  /** account-exclusive equipment: never produced, bought, sold, hauled or dropped */
  exclusive?: boolean;
  desc: string;
  tech?: string;
}
export interface FitFx { hpMul: number; armorMul: number; speedMul: number; accMul: number; reloadMul: number; evasion: number; pdMul: number; rangeMul: number }

export const EQUIPMENT: Record<string, EquipDef> = {
  // weapons — produced at a weapons factory, consumed when a loadout is fitted
  eq_autocannon: { id: 'eq_autocannon', name: '30mm 기관포', kind: 'weapon', weapon: 'autocannon', size: 1, desc: '경함정용 탄막 무장.' },
  eq_pd_gun: { id: 'eq_pd_gun', name: '근접 방어 기관포', kind: 'weapon', weapon: 'pd_gun', size: 1, desc: '미사일·어뢰 요격 무장.' },
  eq_torpedo: { id: 'eq_torpedo', name: '플라즈마 어뢰 발사관', kind: 'weapon', weapon: 'torpedo', size: 2, desc: '근접 필살 무장.' },
  eq_medium_gun: { id: 'eq_medium_gun', name: '155mm 부포', kind: 'weapon', weapon: 'medium_gun', size: 2, desc: '다목적 함포.' },
  eq_missile_rack: { id: 'eq_missile_rack', name: 'VLS 미사일 발사기', kind: 'weapon', weapon: 'missile_rack', size: 2, desc: '유도 미사일 발사 장치.', tech: 'guided_missiles' },
  eq_laser: { id: 'eq_laser', name: '펄스 레이저', kind: 'weapon', weapon: 'pulse_laser', size: 2, desc: '에너지 무장. 탄속 무한, 장갑 관통은 낮다.', tech: 'energy_weapons' },
  eq_heavy_cannon: { id: 'eq_heavy_cannon', name: '460mm 주포', kind: 'weapon', weapon: 'heavy_cannon', size: 3, desc: '전함급 주포.', tech: 'heavy_ordnance' },
  eq_rail_cannon: { id: 'eq_rail_cannon', name: '레일 캐논', kind: 'weapon', weapon: 'rail_cannon', size: 3, desc: '초고속 관통탄 주포.', tech: 'railguns' },
  eq_lance: { id: 'eq_lance', name: '입자 창', kind: 'weapon', weapon: 'particle_lance', size: 3, desc: '고출력 에너지 주포.', tech: 'particle_lance' },
  // modules — go into fitting slots and change how the hull fights
  mod_armor: { id: 'mod_armor', name: '증가 장갑', kind: 'module', size: 2, fx: { armorMul: 1.15, hpMul: 1.08, speedMul: 0.94 }, desc: '장갑 +15%, 내구 +8%, 속도 -6%.' },
  mod_armor2: { id: 'mod_armor2', name: '복합 반응장갑', kind: 'module', size: 2, fx: { armorMul: 1.25, hpMul: 1.1, speedMul: 0.96 }, desc: '장갑 +25%, 내구 +10%, 속도 -4%.', tech: 'reactive_armor' },
  mod_engine: { id: 'mod_engine', name: '추진 강화', kind: 'module', size: 1, fx: { speedMul: 1.12, evasion: 0.05 }, desc: '속도·가속 +12%, 회피 +5%.' },
  mod_engine2: { id: 'mod_engine2', name: '벡터 추진기', kind: 'module', size: 1, fx: { speedMul: 1.2, evasion: 0.1 }, desc: '속도 +20%, 회피 +10%.', tech: 'vector_thrust' },
  mod_fcs: { id: 'mod_fcs', name: '사격통제장치', kind: 'module', size: 1, fx: { accMul: 1.2 }, desc: '명중률 +20%.', tech: 'fire_control' },
  mod_sensor: { id: 'mod_sensor', name: '장거리 센서', kind: 'module', size: 1, fx: { rangeMul: 1.1, accMul: 1.08 }, desc: '무장 사거리 +10%, 명중 +8%.', tech: 'long_sensors' },
  mod_ecm: { id: 'mod_ecm', name: '전자전 교란기', kind: 'module', size: 1, fx: { evasion: 0.18 }, desc: '적 명중률 -18%.', tech: 'ecm' },
  mod_reactor: { id: 'mod_reactor', name: '고출력 반응로', kind: 'module', size: 2, fx: { reloadMul: 0.88 }, desc: '재장전 -12%.', tech: 'reactor_tuning' },
  mod_pd: { id: 'mod_pd', name: '요격 통제 컴퓨터', kind: 'module', size: 1, fx: { pdMul: 1.5 }, desc: '방공포 요격률 +50%.', tech: 'pd_network' },
};

// ─────────────────────────────────────────────────────────────── facilities

export type FacCat = '기반' | '정제' | '부품' | '조선' | '군사' | '연구' | '물류';
export interface FacilityDef {
  kind: string; name: string; cat: FacCat; desc: string; /** growth-only content (contentV ≥ 3) */ growth?: boolean;
  credits: number;
  /** construction materials (taken from the station's storage via the plan queue) */
  mats: Record<string, number>;
  work: number;          // construction seconds (constructor base rate)
  power: number;         // + supply / - demand
  /** parallel production lines (or research / build slots) per instance */
  lines?: number;
  /** extra storage capacity */
  storage?: number;
  requires?: string;     // another facility that must be built first
  tech?: string;         // research needed before it can be planned
  /** at most this many per station (default unlimited for production) */
  max?: number;
  unlocks: string;
  /** research lab field(s) it can work on */
  lab?: string[];
  /** shipyard size class it can build */
  yard?: number;
  /** Minimum sized station for a new installation; independent of shipyard capability. */
  minStation?: Size;
  /** Pre-P9.6.3 terms, used only for c0 and old modules without a material snapshot. */
  legacyBuild?: { credits: number; mats: Record<string, number> };
}

/** New growth construction uses current terms; c0 retains its original economy. */
export const facilityBuild = (f: FacilityDef, growth: boolean): { credits: number; mats: Record<string, number> } =>
  growth ? f : f.legacyBuild ?? f;

/** Existing c0 worlds retain their original XL yard prerequisite. */
export const facilityTech = (f: FacilityDef, growth: boolean): string | undefined =>
  !growth && f.kind === 'yard_xl' ? 'dreadnought_program' : f.tech;

/** Yard capabilities in c0 still follow the original hull tiers. */
export function facilityDescription(f: FacilityDef, growth: boolean): string {
  if (!growth && f.kind === 'yard_l') return '중순양함·순양전함·전함을 건조한다.';
  if (!growth && f.kind === 'yard_xl') return '드레드노트급 초대형 함선 전용 건조 독.';
  return f.desc;
}

const F = (f: FacilityDef) => f;
export const FACILITIES: Record<string, FacilityDef> = Object.fromEntries([
  // ── 기반 시설
  F({ kind: 'core', name: '정거장 코어', cat: '기반', desc: '정거장의 심장. 정박·창고·자체 하역이 가능해진다.', credits: 8000, mats: { alloy: 300 }, work: 60, power: 20, storage: 20000, max: 1, unlocks: '정박 · 창고 20,000 · 하역 · 자체 건설반' }),
  F({ kind: 'power', name: '핵융합 발전소', cat: '기반', desc: '정거장 시설에 전력을 공급한다. 전력이 부족하면 모든 생산이 느려진다.', credits: 18000, mats: { alloy: 450, machinery: 20 }, minStation: 'S', legacyBuild: { credits: 6000, mats: { alloy: 160, machinery: 10 } }, work: 90, power: 120, requires: 'core', unlocks: '전력 +120' }),
  F({ kind: 'warehouse', name: '창고', cat: '기반', desc: '저장 용량을 늘린다.', credits: 6000, mats: { alloy: 240, structure: 15 }, minStation: 'S', legacyBuild: { credits: 3000, mats: { alloy: 120, structure: 10 } }, work: 60, power: -2, storage: 30000, requires: 'core', unlocks: '창고 용량 +30,000' }),
  F({ kind: 'dock', name: '하역시설', cat: '기반', desc: '하역 크레인. 채굴선·수송선 하역이 빨라지고 수송선 적재량이 늘어난다.', credits: 10000, mats: { alloy: 350, machinery: 20 }, minStation: 'S', legacyBuild: { credits: 4000, mats: { alloy: 150, machinery: 8 } }, work: 70, power: -6, requires: 'core', max: 2, unlocks: '하역 속도 2배 · 정거장 수송 효율 +' }),
  F({ kind: 'repair', name: '수리시설', cat: '기반', desc: '정박한 자사 함선을 수리한다 (부품 소모).', credits: 15000, mats: { alloy: 400, machinery: 24 }, minStation: 'S', legacyBuild: { credits: 5000, mats: { alloy: 180, machinery: 6 } }, work: 75, power: -10, requires: 'core', max: 2, unlocks: '정박 함선 수리 (합금·기계부품 소모)' }),
  F({ kind: 'habitat', name: '지원시설', cat: '기반', desc: '승무원 거주구와 보급. 지휘관 숙련 성장과 정거장 인력 효율을 높인다.', credits: 25000, mats: { alloy: 450, composite: 30, electronics: 10 }, minStation: 'S', legacyBuild: { credits: 7000, mats: { alloy: 200, composite: 20, electronics: 4 } }, work: 120, power: -8, requires: 'core', max: 1, unlocks: '모든 생산 속도 +10% · 정박 지휘관 경험 증가' }),
  // ── 자원 및 정제
  F({ kind: 'refinery', name: '광석 정제소', cat: '정제', desc: '철광석을 정련 금속으로.', credits: 20000, mats: { alloy: 500, machinery: 10 }, minStation: 'S', legacyBuild: { credits: 7000, mats: { alloy: 220 } }, work: 110, power: -15, lines: 1, requires: 'core', unlocks: '철광석 → 정련 금속' }),
  F({ kind: 'smelter', name: '제련소', cat: '정제', desc: '티타늄광과 규산염을 제련한다.', credits: 30000, mats: { alloy: 650, machinery: 25 }, minStation: 'S', legacyBuild: { credits: 9000, mats: { alloy: 260, machinery: 10 } }, work: 140, power: -18, lines: 1, requires: 'core', unlocks: '티타늄광 → 티타늄 · 규산염 → 실리콘' }),
  F({ kind: 'alloy_plant', name: '합금 공장', cat: '정제', desc: '정련 금속과 티타늄으로 합금을 만든다.', credits: 50000, mats: { alloy: 1000, machinery: 50 }, minStation: 'S', legacyBuild: { credits: 10000, mats: { alloy: 260, machinery: 14 } }, work: 150, power: -18, lines: 1, requires: 'core', unlocks: '정련 금속 + 티타늄 → 합금' }),
  F({ kind: 'rare_refinery', name: '희귀소재 정제시설', cat: '정제', desc: '희토류광을 정제한다.', credits: 200000, mats: { alloy: 2200, machinery: 120, electronics: 35, precision: 12 }, minStation: 'M', legacyBuild: { credits: 16000, mats: { alloy: 320, machinery: 20, electronics: 6 } }, work: 200, power: -24, lines: 1, requires: 'core', tech: 'rare_processing', unlocks: '희토류광 → 희토류 금속' }),
  F({ kind: 'gas_plant', name: '가스 처리시설', cat: '정제', desc: '수소 가스로 화학소재를 합성한다.', credits: 30000, mats: { alloy: 650, machinery: 30 }, minStation: 'S', legacyBuild: { credits: 9000, mats: { alloy: 240, machinery: 12 } }, work: 150, power: -16, lines: 1, requires: 'core', unlocks: '수소 가스 → 화학소재' }),
  F({ kind: 'composite_plant', name: '복합소재 공장', cat: '정제', desc: '실리콘·화학소재·금속을 복합소재로.', credits: 150000, mats: { alloy: 2000, machinery: 110, electronics: 35, chemicals: 100 }, minStation: 'M', legacyBuild: { credits: 14000, mats: { alloy: 300, machinery: 16, electronics: 4 } }, work: 190, power: -22, lines: 1, requires: 'core', tech: 'composites', unlocks: '실리콘 + 화학소재 + 금속 → 복합소재' }),
  // ── 부품 생산
  F({ kind: 'machine_shop', name: '기계 공장', cat: '부품', desc: '기계부품과 정밀부품을 만든다.', credits: 65000, mats: { alloy: 1200 }, minStation: 'S', legacyBuild: { credits: 9000, mats: { alloy: 260 } }, work: 140, power: -16, lines: 1, requires: 'core', unlocks: '기계부품 · 정밀부품' }),
  F({ kind: 'hull_works', name: '함체 가공공장', cat: '부품', desc: '구조재를 생산한다.', credits: 80000, mats: { alloy: 1300, machinery: 45 }, minStation: 'S', legacyBuild: { credits: 10000, mats: { alloy: 300, machinery: 12 } }, work: 160, power: -18, lines: 1, requires: 'core', unlocks: '구조재' }),
  F({ kind: 'electronics_fab', name: '전자부품 공장', cat: '부품', desc: '전자부품과 센서를 만든다.', credits: 120000, mats: { alloy: 1800, machinery: 110, silicon: 180 }, minStation: 'M', legacyBuild: { credits: 15000, mats: { alloy: 280, machinery: 16, silicon: 40 } }, work: 200, power: -22, lines: 1, requires: 'core', unlocks: '전자부품 · 센서' }),
  F({ kind: 'engine_plant', name: '엔진 공장', cat: '부품', desc: '함선 엔진을 만든다.', credits: 250000, mats: { alloy: 3000, machinery: 200, precision: 60 }, minStation: 'M', legacyBuild: { credits: 18000, mats: { alloy: 340, machinery: 24, precision: 6 } }, work: 240, power: -26, lines: 1, requires: 'core', tech: 'ship_propulsion', unlocks: '엔진' }),
  F({ kind: 'reactor_plant', name: '반응로 공장', cat: '부품', desc: '함선 반응로를 만든다.', credits: 450000, mats: { alloy: 5200, machinery: 260, electronics: 130 }, minStation: 'M', legacyBuild: { credits: 24000, mats: { alloy: 380, machinery: 24, electronics: 12 } }, work: 280, power: -30, lines: 1, requires: 'core', tech: 'fusion_reactors', unlocks: '반응로' }),
  F({ kind: 'weapons_factory', name: '무기 공장', cat: '부품', desc: '무장 부품과 함포·발사관을 만든다.', credits: 180000, mats: { alloy: 2400, machinery: 160, precision: 40 }, minStation: 'M', legacyBuild: { credits: 16000, mats: { alloy: 320, machinery: 20, precision: 4 } }, work: 220, power: -24, lines: 1, requires: 'core', unlocks: '무장 부품 · 함포·미사일·레이저 장비' }),
  F({ kind: 'armor_plant', name: '장갑 공장', cat: '부품', desc: '장갑판과 장갑 모듈을 만든다.', credits: 90000, mats: { alloy: 1600, machinery: 90 }, minStation: 'M', legacyBuild: { credits: 12000, mats: { alloy: 320, machinery: 14 } }, work: 180, power: -20, lines: 1, requires: 'core', unlocks: '장갑판 · 장갑 모듈' }),
  // ── 조선 및 군사
  F({ kind: 'yard_s', name: '소형 조선소', cat: '조선', desc: '초계함·호위함과 채굴선·수송선을 건조한다. 증설할 때마다 건조 슬롯 +1.', credits: 55000, mats: { alloy: 1000, structure: 90, machinery: 35 }, minStation: 'S', legacyBuild: { credits: 15000, mats: { alloy: 400, structure: 20, machinery: 12 } }, work: 240, power: -20, lines: 1, yard: 1, requires: 'core', unlocks: '건조 슬롯 1 (소형 함선)' }),
  F({ kind: 'yard_m', name: '중형 조선소', cat: '조선', desc: '구축함·경순양함과 공작선까지 건조한다.', credits: 250000, mats: { alloy: 5500, structure: 350, machinery: 150, electronics: 60 }, minStation: 'M', legacyBuild: { credits: 40000, mats: { alloy: 900, structure: 60, machinery: 30, electronics: 10 } }, work: 600, power: -35, lines: 1, yard: 2, requires: 'yard_s', tech: 'medium_hulls', unlocks: '건조 슬롯 1 (중형 이하)' }),
  F({ kind: 'yard_l', name: '대형 조선소', cat: '조선', desc: '중순양함·순양전함과 대형 산업선을 건조한다.', credits: 1200000, mats: { alloy: 26000, structure: 2500, machinery: 850, composite: 300, electronics: 250 }, minStation: 'L', legacyBuild: { credits: 120000, mats: { alloy: 2400, structure: 200, machinery: 80, composite: 60, electronics: 30 } }, work: 1800, power: -60, lines: 1, yard: 3, requires: 'yard_m', tech: 'capital_hulls', unlocks: '건조 슬롯 1 (대형 이하)' }),
  F({ kind: 'yard_xl', name: '초대형 건조 독', cat: '조선', desc: '전함·드레드노트와 초대형 산업선을 건조한다.', credits: 6000000, mats: { alloy: 70000, structure: 7000, machinery: 2200, composite: 1600, electronics: 700, precision: 350 }, minStation: 'XL', legacyBuild: { credits: 400000, mats: { alloy: 8000, structure: 800, composite: 300, electronics: 120, precision: 60 } }, work: 5400, power: -120, lines: 1, yard: 4, requires: 'yard_l', tech: 'capital_hulls', max: 1, unlocks: '초대형 함선 건조' }),
  F({ kind: 'fitting', name: '피팅 시설', cat: '조선', desc: '함선의 무장 구성 변경과 모듈 장착.', credits: 22000, mats: { alloy: 400, machinery: 25 }, minStation: 'S', legacyBuild: { credits: 8000, mats: { alloy: 200, machinery: 10 } }, work: 120, power: -10, requires: 'core', max: 1, unlocks: '무장 구성 변경 · 장비 모듈 장착/해제' }),
  F({ kind: 'armory', name: '군수창고', cat: '군사', desc: '탄약·미사일 보급. 정박 함선의 미사일 탄창과 전투 지속력이 오른다.', credits: 35000, mats: { alloy: 650, chemicals: 100 }, minStation: 'S', legacyBuild: { credits: 9000, mats: { alloy: 220, chemicals: 30 } }, work: 140, power: -6, requires: 'core', max: 1, unlocks: '이 정거장 함선 미사일 탄창 +50%' }),
  F({ kind: 'defense', name: '방어시설', cat: '군사', desc: '정거장 주변 전투에 중포대로 참전한다.', credits: 40000, mats: { alloy: 900, weapon_parts: 20 }, minStation: 'S', legacyBuild: { credits: 9000, mats: { alloy: 300, weapon_parts: 4 } }, work: 160, power: -12, requires: 'core', max: 6, unlocks: '방어 포대 1기 · 주변 치안 상승' }),
  F({ kind: 'hangar', name: '격납시설', cat: '군사', desc: '정박 정원을 늘리고 정박 중인 함선의 수리·정비 속도를 높인다.', credits: 30000, mats: { alloy: 800, structure: 70, machinery: 25 }, minStation: 'S', legacyBuild: { credits: 7000, mats: { alloy: 260, structure: 20 } }, work: 150, power: -8, requires: 'core', max: 2, unlocks: '정박 함선 정비 속도 +50%' }),
  // ── 연구
  F({ kind: 'lab_basic', name: '기초과학 연구소', cat: '연구', desc: '기초 연구. 산업·자원·정거장 공학 분야.', credits: 30000, mats: { alloy: 600, electronics: 20 }, minStation: 'S', legacyBuild: { credits: 10000, mats: { alloy: 240, electronics: 6 } }, work: 200, power: -15, lines: 1, lab: ['industry', 'resources', 'station', 'logistics'], requires: 'core', unlocks: '연구 슬롯 1 (산업·자원·정거장)' }),
  F({ kind: 'lab_materials', name: '재료공학 연구소', cat: '연구', desc: '재료와 방어 기술 연구.', credits: 110000, mats: { alloy: 1600, electronics: 65, composite: 50 }, minStation: 'M', legacyBuild: { credits: 16000, mats: { alloy: 300, electronics: 10, composite: 10 } }, work: 260, power: -20, lines: 1, lab: ['defense', 'industry', 'shipeng', 'power'], requires: 'lab_basic', unlocks: '연구 슬롯 1 (방어·산업·함선공학)' }),
  F({ kind: 'lab_propulsion', name: '추진기관 연구소', cat: '연구', desc: '추진·항법 연구.', credits: 110000, mats: { alloy: 1500, electronics: 70, machinery: 120 }, minStation: 'M', legacyBuild: { credits: 16000, mats: { alloy: 300, electronics: 10, machinery: 20 } }, work: 260, power: -20, lines: 1, lab: ['propulsion', 'shipeng'], requires: 'lab_basic', unlocks: '연구 슬롯 1 (추진·함선공학)' }),
  F({ kind: 'lab_electronics', name: '전자공학 연구소', cat: '연구', desc: '전자공학·센서 연구.', credits: 130000, mats: { alloy: 1600, electronics: 120, silicon: 80 }, minStation: 'M', legacyBuild: { credits: 18000, mats: { alloy: 300, electronics: 20 } }, work: 260, power: -22, lines: 1, lab: ['electronics', 'weapons'], requires: 'lab_basic', unlocks: '연구 슬롯 1 (전자·무장)' }),
  F({ kind: 'lab_weapons', name: '무장 연구소', cat: '연구', desc: '무장 기술 연구.', credits: 150000, mats: { alloy: 2000, weapon_parts: 50, electronics: 80 }, minStation: 'M', legacyBuild: { credits: 20000, mats: { alloy: 360, weapon_parts: 10, electronics: 10 } }, work: 300, power: -24, lines: 1, lab: ['weapons', 'kinetic', 'energy', 'missile'], requires: 'lab_basic', unlocks: '연구 슬롯 1 (무장)' }),
  F({ kind: 'design_bureau', name: '함선 설계국', cat: '연구', desc: '함선 설계 연구. 새 함급의 설계도를 완성한다.', credits: 300000, mats: { alloy: 3200, electronics: 200, precision: 80, composite: 100 }, minStation: 'L', legacyBuild: { credits: 24000, mats: { alloy: 400, electronics: 16, precision: 6 } }, work: 320, power: -20, lines: 1, lab: ['shipeng'], requires: 'lab_basic', unlocks: '연구 슬롯 1 (함선공학)' }),
  F({ kind: 'lab_industry', name: '산업기술 연구소', cat: '연구', desc: '생산 공정 연구.', credits: 80000, mats: { alloy: 1400, machinery: 100 }, minStation: 'M', legacyBuild: { credits: 14000, mats: { alloy: 280, machinery: 20 } }, work: 240, power: -18, lines: 1, lab: ['industry', 'resources'], requires: 'lab_basic', unlocks: '연구 슬롯 1 (산업·자원)' }),
  F({ kind: 'lab_tactics', name: '군사전술 연구소', cat: '연구', desc: '함대 운용과 전술 연구.', credits: 85000, mats: { alloy: 1300, electronics: 50 }, minStation: 'M', legacyBuild: { credits: 14000, mats: { alloy: 260, electronics: 8 } }, work: 240, power: -12, lines: 1, lab: ['tactics'], requires: 'lab_basic', unlocks: '연구 슬롯 1 (군사 전술)' }),
  // ── 물류
  F({ kind: 'logistics', name: '물류센터', cat: '물류', desc: '자동 보급: 수송선이 이 정거장의 생산에 부족한 원료를 다른 자사 정거장에서 실어 온다.', credits: 24000, mats: { alloy: 450, machinery: 25, electronics: 8 }, minStation: 'S', legacyBuild: { credits: 8000, mats: { alloy: 220, machinery: 10, electronics: 2 } }, work: 140, power: -8, requires: 'core', max: 1, unlocks: '"자동 보급" 수송 명령 · 정거장 간 물류 현황' }),
  F({ kind: 'trade_hub', name: '거래시설', cat: '물류', desc: '이 정거장에 거래소를 연다: 다른 PMC가 매물을 사고팔 수 있다.', credits: 30000, mats: { alloy: 600, electronics: 30 }, minStation: 'S', legacyBuild: { credits: 12000, mats: { alloy: 260, electronics: 6 } }, work: 160, power: -8, requires: 'core', max: 1, unlocks: '정거장 거래소 (플레이어 간 매매)' }),
  F({ kind: 'comms', name: '센서·통신시설', cat: '물류', desc: '일부 지휘형 함선 구조를 건조하기 위한 통신 기반 시설이다.', credits: 35000, mats: { alloy: 500, electronics: 35, sensor: 2 }, minStation: 'M', legacyBuild: { credits: 9000, mats: { alloy: 200, electronics: 8, sensor: 1 } }, work: 160, power: -10, requires: 'core', max: 1, unlocks: '일부 지휘형 함선 구조의 건조 선행 조건' }),
].map(f => [f.kind, f]));

export const FAC_CATS: FacCat[] = ['기반', '정제', '부품', '조선', '군사', '연구', '물류'];

// ─────────────────────────────────────────────────────────────── recipes

export interface RecipeDef { id: string; name: string; fac: string; time: number; in: Record<string, number>; out: Record<string, number>; tech?: string; /** growth-only */ growth?: boolean; /** P9.7 only */ regional?: boolean }
const R = (id: string, name: string, fac: string, time: number, inp: Record<string, number>, out: Record<string, number>, tech?: string): RecipeDef => ({ id, name, fac, time, in: inp, out, tech });

export const RECIPES: Record<string, RecipeDef> = Object.fromEntries([
  // refining
  R('metal', '금속 정련', 'refinery', 60, { ore: 40 }, { metal: 20 }),
  R('alloy_direct', '직접 합금 정련 (저효율)', 'refinery', 60, { ore: 60 }, { alloy: 14 }),
  R('metal_eff', '고효율 금속 정련', 'refinery', 60, { ore: 40 }, { metal: 26 }, 'refining_2'),
  R('titanium', '티타늄 제련', 'smelter', 80, { titanium_ore: 30 }, { titanium: 12 }),
  R('silicon', '실리콘 제련', 'smelter', 70, { silicate: 40 }, { silicon: 18 }),
  R('alloy', '합금 제조', 'alloy_plant', 90, { metal: 20, titanium: 6 }, { alloy: 22 }),
  R('alloy_scrap', '고철 재활용 합금', 'alloy_plant', 90, { metal: 34 }, { alloy: 14 }),
  R('rare_metal', '희토류 정제', 'rare_refinery', 150, { rare_ore: 30 }, { rare_metal: 8 }),
  R('chemicals', '화학 합성', 'gas_plant', 80, { gas: 40 }, { chemicals: 16 }),
  R('composite', '복합소재 적층', 'composite_plant', 140, { silicon: 10, chemicals: 8, metal: 10 }, { composite: 10 }),
  { ...R('dense_alloy', '고강도 합금 제련', 'smelter', 180, { dense_titanium_ore: 40, titanium: 10, metal: 10 }, { dense_alloy: 12 }, 'rare_processing'), regional: true },
  { ...R('resonant_optics', '공명 광학 소재 정제', 'rare_refinery', 240, { resonant_crystal: 30, silicon: 12, crystal: 4 }, { resonant_optics: 8 }, 'rare_processing'), regional: true },
  { ...R('stabilized_isotope', '동위원소 안정화', 'rare_refinery', 240, { unstable_isotope: 30, chemicals: 16, electronics: 4 }, { stabilized_isotope: 8 }, 'rare_processing'), regional: true },
  { ...R('singular_alloy', '특이 합금 정제', 'rare_refinery', 360, { singular_ore: 40, dense_alloy: 8, rare_metal: 4 }, { singular_alloy: 10 }, 'rare_processing'), regional: true },
  // parts
  R('machinery', '기계부품 가공', 'machine_shop', 120, { metal: 16, alloy: 6 }, { machinery: 6 }),
  R('precision', '정밀 가공', 'machine_shop', 200, { titanium: 8, alloy: 4, machinery: 2 }, { precision: 3 }),
  R('structure', '구조재 성형', 'hull_works', 110, { alloy: 18, metal: 10 }, { structure: 10 }),
  R('structure_c', '복합 구조재', 'hull_works', 110, { alloy: 10, composite: 6 }, { structure: 12 }, 'composites'),
  R('electronics', '회로 조립', 'electronics_fab', 160, { silicon: 12, metal: 4, crystal: 1 }, { electronics: 4 }),
  R('electronics_r', '고밀도 회로', 'electronics_fab', 160, { silicon: 10, rare_metal: 2, crystal: 1 }, { electronics: 7 }, 'microelectronics'),
  R('sensor', '센서 조립', 'electronics_fab', 420, { electronics: 6, crystal: 4, precision: 1 }, { sensor: 1 }),
  R('engine', '엔진 조립', 'engine_plant', 600, { machinery: 8, alloy: 30, precision: 4, chemicals: 6 }, { engine: 1 }),
  R('reactor', '반응로 조립', 'reactor_plant', 900, { rare_metal: 6, composite: 10, electronics: 6, crystal: 6 }, { reactor: 1 }),
  R('reactor_basic', '소형 핵분열로', 'reactor_plant', 900, { alloy: 40, electronics: 8, crystal: 8, machinery: 6 }, { reactor: 1 }),
  R('armor_plate', '장갑판 압연', 'armor_plant', 150, { alloy: 16, titanium: 6 }, { armor_plate: 4 }),
  R('armor_plate_c', '복합 장갑판', 'armor_plant', 150, { alloy: 10, composite: 6 }, { armor_plate: 6 }, 'reactive_armor'),
  R('weapon_parts', '무장 부품 가공', 'weapons_factory', 240, { alloy: 14, precision: 2, chemicals: 4 }, { weapon_parts: 3 }),
  // equipment
  R('eq_autocannon', '기관포 조립', 'weapons_factory', 300, { weapon_parts: 1, metal: 6 }, { eq_autocannon: 1 }),
  R('eq_pd_gun', '방어 기관포 조립', 'weapons_factory', 300, { weapon_parts: 1, electronics: 1 }, { eq_pd_gun: 1 }),
  R('eq_torpedo', '어뢰 발사관 조립', 'weapons_factory', 600, { weapon_parts: 3, chemicals: 10, electronics: 1 }, { eq_torpedo: 1 }),
  R('eq_medium_gun', '155mm 부포 조립', 'weapons_factory', 600, { weapon_parts: 3, alloy: 12 }, { eq_medium_gun: 1 }),
  R('eq_missile_rack', '미사일 발사기 조립', 'weapons_factory', 900, { weapon_parts: 3, electronics: 3, chemicals: 12 }, { eq_missile_rack: 1 }, 'guided_missiles'),
  R('eq_laser', '펄스 레이저 조립', 'weapons_factory', 900, { weapon_parts: 2, electronics: 4, crystal: 4 }, { eq_laser: 1 }, 'energy_weapons'),
  R('eq_heavy_cannon', '주포 조립', 'weapons_factory', 2400, { weapon_parts: 10, alloy: 60, precision: 4 }, { eq_heavy_cannon: 1 }, 'heavy_ordnance'),
  R('eq_rail_cannon', '레일 캐논 조립', 'weapons_factory', 3000, { weapon_parts: 10, electronics: 8, rare_metal: 6, precision: 4 }, { eq_rail_cannon: 1 }, 'railguns'),
  R('eq_lance', '입자 창 조립', 'weapons_factory', 3600, { weapon_parts: 8, electronics: 12, crystal: 16, rare_metal: 6 }, { eq_lance: 1 }, 'particle_lance'),
  R('mod_armor', '증가 장갑 제작', 'armor_plant', 600, { armor_plate: 6, structure: 2 }, { mod_armor: 1 }),
  R('mod_armor2', '반응장갑 제작', 'armor_plant', 900, { armor_plate: 6, composite: 8, chemicals: 6 }, { mod_armor2: 1 }, 'reactive_armor'),
  R('mod_engine', '추진 강화 키트', 'machine_shop', 600, { machinery: 4, precision: 2, chemicals: 4 }, { mod_engine: 1 }),
  R('mod_engine2', '벡터 추진기 제작', 'engine_plant', 900, { precision: 4, machinery: 4, composite: 4 }, { mod_engine2: 1 }, 'vector_thrust'),
  R('mod_fcs', '사격통제장치 조립', 'electronics_fab', 600, { electronics: 4, precision: 1, crystal: 2 }, { mod_fcs: 1 }, 'fire_control'),
  R('mod_sensor', '장거리 센서 조립', 'electronics_fab', 600, { sensor: 1, electronics: 2 }, { mod_sensor: 1 }, 'long_sensors'),
  R('mod_ecm', '교란기 조립', 'electronics_fab', 900, { electronics: 6, rare_metal: 2, crystal: 2 }, { mod_ecm: 1 }, 'ecm'),
  R('mod_reactor', '고출력 반응로 개조', 'reactor_plant', 900, { reactor: 1, electronics: 2 }, { mod_reactor: 1 }, 'reactor_tuning'),
  R('mod_pd', '요격 통제 컴퓨터 조립', 'electronics_fab', 600, { electronics: 4, sensor: 1 }, { mod_pd: 1 }, 'pd_network'),
].map(r => [r.id, r]));

const REGIONAL_RECIPES: Record<string, RecipeDef> = Object.fromEntries(Object.entries(REGIONAL_RECIPE_INPUTS).map(([id, extra]) => {
  const r = RECIPES[id];
  return [id, { ...r, in: { ...r.in, ...extra } }];
}));

/** One shared source of truth for new batches, logistics and the UI. */
export function recipeFor(w: { regionalV?: number } | undefined, id: string): RecipeDef | undefined {
  const r = Object.hasOwn(RECIPES, id) ? RECIPES[id] : undefined;
  if (!r || (r.regional && !regionalOn(w))) return undefined;
  return regionalOn(w) ? REGIONAL_RECIPES[id] ?? r : r;
}

// ─────────────────────────────────────────────────────────────── hull production

export interface HullDef {
  classId: string;
  /** shipyard size needed (1 small … 4 capital) */
  yard: number;
  time: number;              // seconds in one build slot
  parts: Record<string, number>;
  credits: number;           // labour / overhead
  /** fitting module slots */
  slots: number;
  tech?: string;
}

export const HULLS: Record<string, HullDef> = {
  corvette: { classId: 'corvette', yard: 1, time: 1500, credits: 1500, slots: 2, parts: { structure: 16, armor_plate: 6, engine: 1, reactor: 1, sensor: 1, electronics: 4 } },
  frigate: { classId: 'frigate', yard: 1, time: 2400, credits: 2500, slots: 2, tech: 'frigate_design', parts: { structure: 26, armor_plate: 12, engine: 2, reactor: 1, sensor: 1, electronics: 6 } },
  miner: { classId: 'miner', yard: 1, time: 1800, credits: 1500, slots: 1, parts: { structure: 24, armor_plate: 4, engine: 1, reactor: 1, machinery: 10 } },
  hauler: { classId: 'hauler', yard: 1, time: 1800, credits: 1500, slots: 1, parts: { structure: 34, engine: 2, reactor: 1, machinery: 8 } },
  destroyer: { classId: 'destroyer', yard: 2, time: 5400, credits: 4000, slots: 3, parts: { structure: 46, armor_plate: 22, engine: 2, reactor: 2, sensor: 2, electronics: 10 } },
  light_cruiser: { classId: 'light_cruiser', yard: 2, time: 10800, credits: 7000, slots: 3, tech: 'light_cruiser_design', parts: { structure: 80, armor_plate: 40, engine: 4, reactor: 3, sensor: 3, electronics: 16 } },
  constructor: { classId: 'constructor', yard: 2, time: 3600, credits: 3000, slots: 1, parts: { structure: 50, machinery: 24, engine: 2, reactor: 1, electronics: 6 } },
  cruiser: { classId: 'cruiser', yard: 3, time: 18000, credits: 12000, slots: 4, parts: { structure: 130, armor_plate: 70, engine: 6, reactor: 4, sensor: 4, electronics: 22, composite: 20 } },
  battlecruiser: { classId: 'battlecruiser', yard: 3, time: 32400, credits: 20000, slots: 5, tech: 'battlecruiser_design', parts: { structure: 220, armor_plate: 110, engine: 10, reactor: 6, sensor: 5, electronics: 32, composite: 40 } },
  battleship: { classId: 'battleship', yard: 3, time: 57600, credits: 30000, slots: 6, tech: 'battleship_design', parts: { structure: 340, armor_plate: 200, engine: 12, reactor: 8, sensor: 6, electronics: 40, composite: 80 } },
  dreadnought: { classId: 'dreadnought', yard: 4, time: 144000, credits: 90000, slots: 8, tech: 'dreadnought_program', parts: { structure: 900, armor_plate: 520, engine: 30, reactor: 20, sensor: 12, electronics: 100, composite: 240, precision: 40 } },
};

/** weapons a loadout needs, as equipment items */
export function loadoutEquipment(mounts: { weapon: string }[]): Record<string, number> {
  const need: Record<string, number> = {};
  for (const m of mounts) { const eq = Object.values(EQUIPMENT).find(e => e.weapon === m.weapon); if (eq) need[eq.id] = (need[eq.id] ?? 0) + 1; }
  return need;
}

// ─────────────────────────────────────────────────────────────── research

export type Field = 'shipeng' | 'weapons' | 'defense' | 'propulsion' | 'electronics' | 'industry' | 'resources' | 'station' | 'tactics' | 'power' | 'kinetic' | 'energy' | 'missile' | 'logistics';
export const FIELD_NAME: Record<Field, string> = { shipeng: '함선 공학', weapons: '무장 기술', defense: '방어 기술', propulsion: '추진 및 항법', electronics: '전자공학·센서', industry: '산업 및 생산', resources: '자원·채굴', station: '정거장 공학', tactics: '군사 전술', power: '동력', kinetic: '실탄 무장', energy: '에너지 무장', missile: '유도 무장', logistics: '물류' };

export interface TechDef {
  id: string; name: string; field: Field; desc: string;
  /** research seconds in one lab slot */
  time: number;
  /** consumed when the project starts (from the lab station's storage) */
  cost: Record<string, number>;
  credits: number;
  pre?: string[];
  /** what it actually unlocks / changes */
  unlocks: string;
  /** numeric effects applied while known */
  fx?: Partial<{ mineMul: number; prodMul: number; buildMul: number; researchMul: number; refineMul: number; cargoMul: number; skillGain: number; repairMul: number; cruiseMul: number; constructMul: number; supplyMul: number; upkeepMul: number }>;
  /** NPC tech brokers sell this blueprint (credits) */
  bp?: number;
  /** growth: research area of the 13-area tree (content/schema ResearchArea) */
  area?: string;
  /** growth: the station must have this specialised lab */
  needLab?: string;
  /** growth: combat effects while known */
  cfx?: import('../content/schema').CombatFx;
  /** growth-only content (contentV ≥ 3) */
  growth?: boolean;
}

const T = (t: TechDef) => t;
export const TECHS: Record<string, TechDef> = Object.fromEntries([
  // industry
  T({ id: 'process_control', name: '공정 제어', field: 'industry', time: 1800, credits: 4000, cost: { electronics: 4, machinery: 6 }, desc: '생산 라인 자동화.', unlocks: '모든 시설 생산 속도 +10%', fx: { prodMul: 1.1 } }),
  T({ id: 'refining_2', name: '고효율 정련', field: 'industry', time: 2400, credits: 5000, cost: { machinery: 8, chemicals: 10 }, pre: ['process_control'], desc: '정련 수율 개선.', unlocks: '레시피: 고효율 금속 정련 (금속 +30%)' }),
  T({ id: 'composites', name: '복합소재 공학', field: 'industry', time: 3600, credits: 8000, cost: { silicon: 20, chemicals: 20, machinery: 6 }, pre: ['process_control'], desc: '적층 복합소재.', unlocks: '시설: 복합소재 공장 · 레시피: 복합 구조재', bp: 30000 }),
  T({ id: 'microelectronics', name: '미세 전자공학', field: 'electronics', time: 4800, credits: 10000, cost: { electronics: 10, silicon: 20, crystal: 4 }, pre: ['process_control'], desc: '고밀도 회로.', unlocks: '레시피: 고밀도 회로 (전자부품 +75%)' }),
  T({ id: 'research_methods', name: '연구 방법론', field: 'station', time: 2400, credits: 5000, cost: { electronics: 6 }, desc: '실험 설계와 자료 공유 표준화.', unlocks: '모든 연구 속도 +20%', fx: { researchMul: 1.2 } }),
  T({ id: 'quantum_computing', name: '양자 연산', field: 'electronics', time: 10800, credits: 30000, cost: { electronics: 30, crystal: 20, rare_metal: 6 }, pre: ['microelectronics', 'research_methods'], desc: '시뮬레이션 기반 설계.', unlocks: '모든 연구 속도 +25%', fx: { researchMul: 1.25 } }),
  T({ id: 'lean_production', name: '린 생산', field: 'industry', time: 7200, credits: 14000, cost: { machinery: 20, electronics: 10 }, pre: ['refining_2'], desc: '재고와 대기 시간 최소화.', unlocks: '모든 시설 생산 속도 +15%', fx: { prodMul: 1.15 } }),
  T({ id: 'modular_assembly', name: '모듈식 조립', field: 'shipeng', time: 7200, credits: 16000, cost: { structure: 30, precision: 6, electronics: 10 }, pre: ['process_control'], desc: '블록 단위 선체 조립.', unlocks: '함선 건조 속도 +20%', fx: { buildMul: 1.2 } }),
  T({ id: 'automated_yards', name: '자동화 조선', field: 'shipeng', time: 21600, credits: 40000, cost: { electronics: 40, precision: 20, machinery: 40 }, pre: ['modular_assembly', 'lean_production'], desc: '로봇 조선 라인.', unlocks: '함선 건조 속도 +25%', fx: { buildMul: 1.25 } }),
  // resources
  T({ id: 'mining_lasers', name: '채굴 레이저 개량', field: 'resources', time: 1800, credits: 3000, cost: { machinery: 6, crystal: 2 }, desc: '채굴 출력 향상.', unlocks: '채굴 속도 +20%', fx: { mineMul: 1.2 } }),
  T({ id: 'rare_processing', name: '희토류 처리', field: 'resources', time: 3600, credits: 8000, cost: { machinery: 10, chemicals: 10, electronics: 4 }, pre: ['mining_lasers'], desc: '희토류 분리 공정.', unlocks: '시설: 희귀소재 정제시설', bp: 25000 }),
  T({ id: 'deep_core', name: '심부 채굴', field: 'resources', time: 7200, credits: 12000, cost: { machinery: 16, precision: 6 }, pre: ['mining_lasers'], desc: '소행성 심부 굴착.', unlocks: '채굴 속도 +25%', fx: { mineMul: 1.25 } }),
  T({ id: 'cargo_compression', name: '화물 압축', field: 'resources', time: 5400, credits: 9000, cost: { composite: 10, machinery: 10 }, pre: ['mining_lasers'], desc: '화물칸 압축 저장.', unlocks: '채굴선·수송선 적재량 +25%', fx: { cargoMul: 1.25 } }),
  // station
  T({ id: 'station_engineering', name: '정거장 공학', field: 'station', time: 2400, credits: 5000, cost: { structure: 10, machinery: 6 }, desc: '건설 공정 표준화.', unlocks: '정거장 시설 건설 속도 +25%', fx: { constructMul: 1.25 } }),
  T({ id: 'fusion_reactors', name: '핵융합 반응로', field: 'station', time: 4800, credits: 12000, cost: { electronics: 10, crystal: 10, machinery: 10 }, pre: ['station_engineering'], desc: '소형 융합로 설계.', unlocks: '시설: 반응로 공장', bp: 45000 }),
  T({ id: 'logistics_ai', name: '물류 AI', field: 'station', time: 3600, credits: 6000, cost: { electronics: 8 }, pre: ['station_engineering'], desc: '수송 경로 최적화.', unlocks: '수송선 적재량 +15% · 자동 보급 효율', fx: { cargoMul: 1.15 } }),
  // propulsion
  T({ id: 'ship_propulsion', name: '함선 추진기관', field: 'propulsion', time: 2400, credits: 5000, cost: { machinery: 8, chemicals: 10 }, desc: '함선용 추진기 생산 기술.', unlocks: '시설: 엔진 공장', bp: 20000 }),
  T({ id: 'vector_thrust', name: '벡터 추진', field: 'propulsion', time: 5400, credits: 10000, cost: { precision: 6, machinery: 10 }, pre: ['ship_propulsion'], desc: '추력 편향 노즐.', unlocks: '장비: 벡터 추진기' }),
  T({ id: 'warp_tuning', name: '워프 조율', field: 'propulsion', time: 7200, credits: 14000, cost: { electronics: 12, crystal: 8 }, pre: ['ship_propulsion'], desc: '워프 정렬 시간 단축.', unlocks: '전 함선 순항 속도 +10%', fx: { cruiseMul: 1.1 } }),
  // electronics
  T({ id: 'fire_control', name: '사격통제', field: 'electronics', time: 3600, credits: 8000, cost: { electronics: 8, precision: 2 }, desc: '탄도 계산기.', unlocks: '장비: 사격통제장치' }),
  T({ id: 'long_sensors', name: '장거리 센서', field: 'electronics', time: 4800, credits: 9000, cost: { sensor: 1, electronics: 6 }, pre: ['fire_control'], desc: '고감도 탐지.', unlocks: '장비: 장거리 센서' }),
  T({ id: 'ecm', name: '전자전', field: 'electronics', time: 7200, credits: 14000, cost: { electronics: 16, rare_metal: 4 }, pre: ['long_sensors'], desc: '적 사격통제 교란.', unlocks: '장비: 전자전 교란기' }),
  T({ id: 'pd_network', name: '방공 네트워크', field: 'electronics', time: 5400, credits: 10000, cost: { electronics: 10, sensor: 1 }, pre: ['fire_control'], desc: '함대 방공 연동.', unlocks: '장비: 요격 통제 컴퓨터' }),
  // weapons
  T({ id: 'guided_missiles', name: '유도 미사일', field: 'weapons', time: 3600, credits: 8000, cost: { electronics: 6, chemicals: 16, weapon_parts: 2 }, desc: '대함 유도탄.', unlocks: '장비: VLS 미사일 발사기', bp: 30000 }),
  T({ id: 'energy_weapons', name: '에너지 무장', field: 'weapons', time: 7200, credits: 16000, cost: { electronics: 16, crystal: 12, weapon_parts: 4 }, pre: ['fire_control'], desc: '펄스 레이저.', unlocks: '장비: 펄스 레이저' }),
  T({ id: 'heavy_ordnance', name: '대구경 포', field: 'weapons', time: 10800, credits: 20000, cost: { weapon_parts: 10, precision: 8, alloy: 120 }, pre: ['guided_missiles'], desc: '전함급 주포.', unlocks: '장비: 460mm 주포', bp: 60000 }),
  T({ id: 'railguns', name: '레일건', field: 'weapons', time: 21600, credits: 40000, cost: { rare_metal: 20, electronics: 20, precision: 10 }, pre: ['heavy_ordnance', 'microelectronics'], desc: '전자기 투사.', unlocks: '장비: 레일 캐논' }),
  T({ id: 'particle_lance', name: '입자 창', field: 'weapons', time: 28800, credits: 60000, cost: { crystal: 40, rare_metal: 20, electronics: 30 }, pre: ['energy_weapons', 'railguns'], desc: '고출력 입자빔.', unlocks: '장비: 입자 창' }),
  // defense
  T({ id: 'reactive_armor', name: '반응장갑', field: 'defense', time: 5400, credits: 10000, cost: { composite: 12, chemicals: 10 }, pre: ['composites'], desc: '폭발 반응 장갑.', unlocks: '장비: 복합 반응장갑 · 레시피: 복합 장갑판' }),
  T({ id: 'damage_control', name: '응급 수리', field: 'defense', time: 3600, credits: 6000, cost: { machinery: 10, electronics: 4 }, desc: '함내 손상 통제.', unlocks: '수리 비용 -33%', fx: { repairMul: 1.5 } }),
  // ship engineering (hull designs)
  T({ id: 'frigate_design', name: '호위함 설계', field: 'shipeng', time: 3600, credits: 8000, cost: { structure: 10, electronics: 6 }, desc: '경량 호위함 설계.', unlocks: '함선: 호위함 건조', bp: 20000 }),
  T({ id: 'medium_hulls', name: '중형 선체', field: 'shipeng', time: 5400, credits: 14000, cost: { structure: 30, precision: 4, electronics: 8 }, pre: ['frigate_design'], desc: '중형 선체 골조.', unlocks: '시설: 중형 조선소', bp: 40000 }),
  T({ id: 'light_cruiser_design', name: '경순양함 설계', field: 'shipeng', time: 10800, credits: 24000, cost: { structure: 40, electronics: 16, precision: 8 }, pre: ['medium_hulls'], desc: '고속 순양함.', unlocks: '함선: 경순양함 건조' }),
  T({ id: 'capital_hulls', name: '대형 선체', field: 'shipeng', time: 21600, credits: 50000, cost: { structure: 120, composite: 40, precision: 16, electronics: 24 }, pre: ['light_cruiser_design', 'composites'], desc: '대형 선체 골조.', unlocks: '시설: 대형 조선소 · 초대형 건조 독 · 함선: 중순양함', bp: 150000 }),
  T({ id: 'battlecruiser_design', name: '순양전함 설계', field: 'shipeng', time: 32400, credits: 70000, cost: { structure: 160, electronics: 40, precision: 20 }, pre: ['capital_hulls', 'heavy_ordnance'], desc: '전함의 화력, 순양함의 속도.', unlocks: '함선: 순양전함 건조' }),
  T({ id: 'battleship_design', name: '전함 설계', field: 'shipeng', time: 43200, credits: 100000, cost: { structure: 240, composite: 80, electronics: 60, precision: 30 }, pre: ['battlecruiser_design', 'reactive_armor'], desc: '전열함의 정점.', unlocks: '함선: 전함 건조' }),
  T({ id: 'dreadnought_program', name: '드레드노트 계획', field: 'shipeng', time: 86400, credits: 300000, cost: { structure: 600, composite: 200, electronics: 160, rare_metal: 80, precision: 60 }, pre: ['battleship_design', 'automated_yards'], desc: '초대형 함선 계획.', unlocks: '함선: 드레드노트' }),
  T({ id: 'reactor_tuning', name: '반응로 출력 강화', field: 'shipeng', time: 7200, credits: 12000, cost: { reactor: 1, electronics: 8 }, pre: ['fusion_reactors'], desc: '과출력 운전.', unlocks: '장비: 고출력 반응로' }),
  // tactics
  T({ id: 'fleet_doctrine', name: '함대 교리', field: 'tactics', time: 3600, credits: 6000, cost: { electronics: 4 }, desc: '지휘 계통 표준화.', unlocks: '지휘관 경험 획득 +50%', fx: { skillGain: 1.5 } }),
  T({ id: 'combined_arms', name: '제병 협동', field: 'tactics', time: 7200, credits: 12000, cost: { electronics: 10, sensor: 1 }, pre: ['fleet_doctrine'], desc: '이종 함급 협동 전술.', unlocks: '전투 시 함대 명중률 +5% (모든 함선)' }),
  T({ id: 'salvage_ops', name: '전장 회수', field: 'tactics', time: 5400, credits: 8000, cost: { machinery: 10 }, pre: ['fleet_doctrine'], desc: '격침된 적함에서 부품 회수.', unlocks: '해적 격침 시 무장 부품·전자부품 노획 · 노획 장비 분석' }),
].map(t => [t.id, t]));

/** Preserve the original c0 research messages as well as its unlock rules. */
export function techUnlocks(id: string, growth: boolean): string {
  if (!growth && id === 'capital_hulls') return '시설: 대형 조선소 · 함선: 중순양함';
  if (!growth && id === 'dreadnought_program') return '시설: 초대형 건조 독 · 함선: 드레드노트';
  return TECHS[id]?.unlocks ?? '';
}

/** combat effects of a ship's fitted modules plus company research */
export function fitFx(fit: string[] | undefined, tech: string[] | undefined, armory = false) {
  const fx = { hpMul: 1, armorMul: 1, speedMul: 1, accMul: 1, reloadMul: 1, evasion: 0, pdMul: 1, rangeMul: 1, magMul: armory ? 1.5 : 1 };
  for (const id of fit ?? []) {
    const e = EQUIPMENT[id]?.fx; if (!e) continue;
    for (const [k, v] of Object.entries(e)) { if (k === 'evasion') fx.evasion += v as number; else (fx as any)[k] *= v as number; }
  }
  if (tech?.includes('combined_arms')) fx.accMul *= 1.05;
  return fx;
}

/** growth (P5) combat effects on top of fitFx: shield modules, research combat effects (global and
 *  per weapon family). Only keys that change anything are returned, so a ship without P5 content
 *  fights with exactly the fitFx object. Never called below contentV 3. */
export function growthFx(fit: string[] | undefined, tech: string[] | undefined): { hpMul?: number; armorMul?: number; speedMul?: number; accMul?: number; pdMul?: number; evasion?: number; shield?: number; shieldRegen?: number; fam?: Record<string, { dmg?: number; reload?: number; range?: number }> } {
  const out: ReturnType<typeof growthFx> = {};
  const mul = (k: 'hpMul' | 'armorMul' | 'speedMul' | 'accMul' | 'pdMul', v?: number) => { if (v !== undefined && v !== 1) out[k] = (out[k] ?? 1) * v; };
  let shield = 0, regen = 0, shieldMul = 1, regenMul = 1;
  const apply = (c: import('../content/schema').CombatFx | undefined) => {
    if (!c) return;
    if (c.family) {
      for (const f of Array.isArray(c.family) ? c.family : [c.family]) {
        const e = ((out.fam ??= {})[f] ??= {});
        if (c.dmgMul) e.dmg = (e.dmg ?? 1) * c.dmgMul;
        if (c.reloadMul) e.reload = (e.reload ?? 1) * c.reloadMul;
        if (c.rangeMul) e.range = (e.range ?? 1) * c.rangeMul;
      }
      return;
    }
    mul('hpMul', c.hpMul); mul('armorMul', c.armorMul); mul('speedMul', c.speedMul); mul('accMul', c.accMul); mul('pdMul', c.pdMul);
    if (c.evasion) out.evasion = (out.evasion ?? 0) + c.evasion;
    if (c.shield) { shield += c.shield; regen = Math.max(regen, c.shieldRegen ?? 0); }
    if (c.shieldMul) shieldMul *= c.shieldMul;
    if (c.shieldRegenMul) regenMul *= c.shieldRegenMul;
  };
  for (const id of fit ?? []) apply(EQUIPMENT[id]?.cfx);
  for (const id of tech ?? []) apply(TECHS[id]?.cfx);
  if (shield > 0) { out.shield = shield * shieldMul; out.shieldRegen = regen * regenMul; }
  return out;
}

/** a company's effective multipliers from known techs */
export function techFx(known: string[] | undefined) {
  const out = { mineMul: 1, prodMul: 1, buildMul: 1, researchMul: 1, refineMul: 1, cargoMul: 1, skillGain: 1, repairMul: 1, cruiseMul: 1, constructMul: 1, supplyMul: 1, upkeepMul: 1 };
  for (const id of known ?? []) { const t = TECHS[id]; if (!t?.fx) continue; for (const [k, v] of Object.entries(t.fx)) (out as any)[k] *= v as number; }
  return out;
}

/** extra item names registered by modules that cannot be imported here (e.g. blueprint fragments) */
export const ITEM_NAME_HOOKS: ((id: string) => string | undefined)[] = [];
export const itemName = (id: string) => ITEMS[id]?.name ?? EQUIPMENT[id]?.name ?? (id.startsWith('bp:') ? `설계도: ${TECHS[id.slice(3)]?.name ?? id}` : ITEM_NAME_HOOKS.map(f => f(id)).find(Boolean) ?? id);
export const itemPrice = (id: string): number => ITEMS[id]?.price ?? (EQUIPMENT[id] ? equipPrice(id) : id.startsWith('bp:') ? TECHS[id.slice(3)]?.bp ?? 10000 : 50);
function equipPrice(id: string): number {
  const r = RECIPES[id]; if (!r) return 2000;
  let v = 0; for (const [k, n] of Object.entries(r.in)) v += (ITEMS[k]?.price ?? 100) * n;
  return Math.round(v * 1.4 + r.time * 0.5);
}
export const itemCat = (id: string): ItemCat => ITEMS[id]?.cat ?? (EQUIPMENT[id] ? 'equip' : id.startsWith('bp:') ? 'blueprint' : 'raw');
