// Blueprints (P6): the right to *produce* a hull, variant or item. Separate from research (tech) and
// from owning a ship: a company that buys a finished ship needs neither. Sources are data — new ways
// to obtain a blueprint are new rows. Rules: src/world/blueprints.ts, docs/CONTENT_SCHEMA.md §4.7.
import type { BlueprintDef, BlueprintSource } from '../../schema';

const YARDS_SMALL = ['helios', 'astra', 'bastion', 'drakeout', 'barcaco', 'cinderco', 'rustport'];
const shop = (price: number, stations = YARDS_SMALL): BlueprintSource => ({ kind: 'shop', stations, price });
const H = (hull: string, name: string, grade: BlueprintDef['grade'], sources: BlueprintSource[], requires?: string[], desc = ''): BlueprintDef =>
  ({ id: `bp_${hull}`, name: `${name} 설계도`, desc: desc || `${name} 선체를 자사 조선소에서 건조할 권리.`, grade, target: { kind: 'hull', id: hull }, sources, ...(requires ? { requires } : {}) });
// P14.0: six-faction catalogue, offered on reputation (repV) worlds only, at stations the faction holds in P10
const F = (faction: Extract<BlueprintSource, { kind: 'faction' }>['faction'], stations: string[], price: number, trust: number, contracts?: number): BlueprintSource =>
  ({ kind: 'faction', faction, stations, price, influence: 0, trust, ...(contracts ? { contracts } : {}), repOnly: true });
const V = (variant: string, name: string, grade: BlueprintDef['grade'], sources: BlueprintSource[], desc: string): BlueprintDef =>
  ({ id: `bp_${variant}`, name: `${name} 설계도`, desc, grade, target: { kind: 'variant', id: variant }, sources });

export const BLUEPRINTS: BlueprintDef[] = [
  // ── mk1 hulls (core pack). Starter set is granted to every new company (STARTER_BLUEPRINTS).
  H('corvette_mk1', '초계함 (기본형)', 'common', [shop(2500)]),
  H('miner_mk1', '채굴선 S (곡괭이급)', 'common', [shop(2500)]),
  H('hauler_mk1', '수송선 S (짐꾼급)', 'common', [shop(2500)]),
  H('constructor_mk1', '공작선 M (석공급)', 'common', [shop(4000)]),
  H('destroyer_mk1', '구축함 (아이기스급)', 'common', [shop(6000)]),
  H('frigate_mk1', '호위함', 'common', [shop(15000, ['helios', 'bastion', 'astra', 'drakeout'])], ['frigate_design']),
  H('light_cruiser_mk1', '경순양함', 'advanced', [{ kind: 'commercial', stations: ['helios', 'bastion'], price: 45000, rep: 10 }], ['light_cruiser_design']),
  H('cruiser_mk1', '중순양함', 'advanced', [{ kind: 'commercial', stations: ['helios', 'bastion'], price: 140000, rep: 20, contracts: 6 }, { kind: 'explore', tier: 3, chance: 0.12 }], ['capital_hulls']),
  H('battlecruiser_mk1', '순양전함', 'faction', [{ kind: 'faction', faction: 'union', stations: ['helios'], price: 220000, influence: 60, rep: 40, trust: 32, contracts: 6 }, F('iron', ['p10_bulwark_yard'], 230000, 32, 6), { kind: 'contract', minTier: 4, chance: 0.25 }, { kind: 'explore', tier: 3, chance: 0.05 }], ['battlecruiser_design']),
  H('battleship_mk1', '전함', 'faction', [{ kind: 'faction', faction: 'union', stations: ['helios', 'bastion'], price: 380000, influence: 70, rep: 60, trust: 42, contracts: 10 }, F('iron', ['p10_bulwark_yard'], 400000, 45, 12), { kind: 'salvage', fragments: 8, chance: 0.04 }, { kind: 'explore', tier: 3, chance: 0.03 }], ['battleship_design'],
    '전열함 설계. 연합 영향력이 강한 성계에서 평판 60 이상인 회사에만 판매되며, 해적 전함 잔해나 무법 성계의 유기 함선에서 설계 조각을 모아 복원할 수도 있다.'),
  H('dreadnought_mk1', '드레드노트', 'unique', [{ kind: 'unique', limit: 3, minTier: 5 }, { kind: 'faction', faction: 'union', stations: ['helios'], price: 1500000, influence: 85, rep: 150, trust: 80, contracts: 30 }], ['dreadnought_program'],
    '세계에 3부까지만 존재하는 초대형 함선 설계. 최상위 해적 요새 토벌 보상이거나 연합의 최고 신뢰를 얻은 회사에만 넘어간다.'),
  // ── growth hulls
  H('destroyer_vls', '창살급 미사일 구축함', 'advanced', [{ kind: 'commercial', stations: ['helios'], price: 70000, rep: 15, contracts: 3 }, { kind: 'explore', tier: 2, chance: 0.08 }], ['guided_missiles']),
  H('destroyer_picket', '파수급 방공 구축함', 'advanced', [shop(48000, ['bastion', 'astra'])], ['fire_control']),
  H('destroyer_heavy', '철퇴급 중구축함', 'faction', [{ kind: 'faction', faction: 'union', stations: ['bastion'], price: 120000, influence: 60, rep: 30, trust: 24, contracts: 3 }, F('iron', ['p10_arsenal_works'], 125000, 22, 3), { kind: 'salvage', fragments: 5, chance: 0.06 }], ['heavy_ordnance']),
  H('destroyer_fast', '칼새급 고속 구축함', 'faction', [{ kind: 'faction', faction: 'guild', stations: ['rustport', 'drakeout'], price: 60000, influence: 45, trust: 12 }, F('guild', ['astra'], 60000, 12), F('pirates', ['rustport'], 66000, 15), { kind: 'contract', minTier: 2, chance: 0.2 }], ['ship_propulsion']),
  H('miner_m', '채굴선 M (굴착기급)', 'common', [shop(12000, ['astra', 'barcaco', 'drakeout'])]),
  H('miner_l', '채굴선 L (채광모함급)', 'advanced', [{ kind: 'commercial', stations: ['barcaco'], price: 60000, rep: 10, contracts: 2 }, F('miners', ['p9_anvil_port', 'drakeout'], 55000, 15, 2), { kind: 'explore', tier: 2, chance: 0.06 }], ['deep_core']),
  H('miner_xl', '채굴선 XL (분쇄기급)', 'rare', [{ kind: 'commercial', stations: ['helios'], price: 240000, rep: 35, contracts: 8 }, F('miners', ['p9_anvil_port'], 230000, 30, 8), { kind: 'salvage', fragments: 6, chance: 0.03 }], ['deep_core', 'capital_hulls']),
  H('hauler_m', '수송선 M (화물선급)', 'common', [shop(12000, ['astra', 'exchange', 'nova'])]),
  H('hauler_l', '수송선 L (벌크선급)', 'advanced', [{ kind: 'faction', faction: 'guild', stations: ['exchange', 'nova'], price: 55000, influence: 40, trust: 10 }, { kind: 'explore', tier: 1, chance: 0.05 }], ['logistics_ai']),
  H('hauler_xl', '수송선 XL (화물모함급)', 'rare', [{ kind: 'faction', faction: 'guild', stations: ['exchange'], price: 220000, influence: 60, rep: 30, trust: 24, contracts: 4 }, F('guild', ['astra', 'p10_crossroads_bazaar'], 220000, 24, 4)], ['logistics_ai', 'capital_hulls']),
  H('constructor_s', '공작선 S (땜장이급)', 'common', [shop(3000, ['astra', 'barcaco', 'drakeout'])]),
  H('salvager_s', '인양선 S (갈고리급)', 'common', [shop(3000, ['rustport', 'drakeout', 'astra'])]),
  H('constructor_l', '공작선 L (조립함급)', 'advanced', [{ kind: 'commercial', stations: ['astra'], price: 50000, rep: 10, contracts: 2 }, F('ceres', ['p9_ceres_works', 'p10_kiln_works'], 48000, 12, 2)], ['station_engineering']),
  H('constructor_xl', '공작선 XL (궤도조선창급)', 'rare', [{ kind: 'commercial', stations: ['helios'], price: 200000, rep: 35, contracts: 8 }, F('ceres', ['p9_ceres_works'], 195000, 30, 8), { kind: 'explore', tier: 3, chance: 0.04 }], ['station_engineering', 'capital_hulls']),
  // ── non-common variants (common variants are covered by their hull's blueprint)
  V('destroyer_vls_ext', '창살급 연장 발사관형', 'advanced', [{ kind: 'commercial', stations: ['helios'], price: 40000, rep: 25, contracts: 5 }, { kind: 'explore', tier: 2, chance: 0.06 }], '창살급을 VLS 6셀 구조로 짓거나 개조할 권리.'),
  V('destroyer_picket_cmd', '파수급 지휘형', 'faction', [{ kind: 'faction', faction: 'union', stations: ['bastion', 'helios'], price: 50000, influence: 55, rep: 20, trust: 16 }, F('iron', ['p10_muster_depot'], 52000, 16)], '파수급 지휘함 구조.'),
  V('destroyer_heavy_armored', '철퇴급 장갑 강화형', 'rare', [{ kind: 'salvage', fragments: 4, chance: 0.05 }, { kind: 'contract', minTier: 3, chance: 0.2 }, { kind: 'explore', tier: 2, chance: 0.07 }], '해적 개조함에서 나온 장갑 강화 구조. 판매되지 않는다.'),
  V('miner_l_drone', '채광모함급 드론 채굴형', 'advanced', [{ kind: 'commercial', stations: ['barcaco', 'helios'], price: 45000, rep: 15 }, F('miners', ['p10_deepmine_post'], 43000, 18), { kind: 'explore', tier: 1, chance: 0.05 }], '드론 채굴 구조.'),
];

/** blueprints every new company starts with (and existing companies receive at c3 for what they could build) */
export const STARTER_BLUEPRINTS = ['bp_corvette_mk1', 'bp_miner_mk1', 'bp_hauler_mk1', 'bp_constructor_mk1', 'bp_destroyer_mk1'];
