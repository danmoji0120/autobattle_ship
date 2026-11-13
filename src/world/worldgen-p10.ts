// P10 layout: the P9 world plus 18 systems, six territorial factions, region types, and
// unidentified deposits. Applied only to a freshly created P9 world before any player joins
// (WorldSim.create(seed, { layout: 'p10' })). Existing saves are never converted by this module.
import type { WorldState, StarSystem, Market, V, Field } from './types';
import { emptyCargo } from './types';
import { sysOriginX } from './geom';
import { secBand } from './worldgen';
import { seedSites } from './explore';
import { ITEMS, itemPrice } from './industry';
import { RAW_PRICE_V4 } from './econConfig';
import { valueOf } from './valuation';
import { marketBase } from './econChain';
import { targetFor, PROFILES } from './economy';
import { FACTIONS, type RegionKind, type FactionState } from './territory';
import { sizeOf, LOOK_HINT, type FieldGeo, type GeoLayer, type GeoVein } from './geology';

/** chart size in px for the p10 projection (client reads s.map × size) */
export const P10_CHART = { w: 2400, h: 1150 };

type Def = { id: string; name: string; sec: number; at: [number, number]; desc: string; slots: number; tier: 1 | 2 | 3; color: string; planet?: boolean };
const DEFS: Def[] = [
  { id: 'crossroads', name: '교차로 시장', sec: 55, at: [1330, 500], desc: '북방·동부·엠버 항로가 만나는 길드 중립 시장. 여러 세력의 수요가 모이고 경쟁도 치열하다.', slots: 1, tier: 1, color: '#ffe9a8', planet: true },
  { id: 'meridian', name: '자오선 항구', sec: 58, at: [1960, 660], desc: '철갑 사령부와 변경을 잇는 길드 교역항.', slots: 1, tier: 1, color: '#fff0c8', planet: true },
  { id: 'kiln', name: '킬른 제련권', sec: 66, at: [835, 865], desc: '세레스 연맹의 합금 제련 단지. 금속과 티타늄 광석을 꾸준히 사들인다.', slots: 1, tier: 1, color: '#ffc58f', planet: true },
  { id: 'tundra', name: '툰드라 채굴장', sec: 44, at: [1190, 80], desc: '광업동맹의 북방 채굴 기지. 기계와 화학소재가 늘 모자란다.', slots: 1, tier: 2, color: '#cfe8ff', planet: true },
  { id: 'deepmine', name: '심층 광산', sec: 38, at: [640, 130], desc: '앤빌 뒤편의 깊은 광산 성계. 오래 파 들어갈수록 성분이 달라진다는 소문이 있다.', slots: 1, tier: 2, color: '#d9b48c' },
  { id: 'bulwark', name: '불워크 요새', sec: 93, at: [2000, 270], desc: '철갑 사령부의 수도 요새. 함선 부품과 장갑판의 최대 소비지다.', slots: 0, tier: 1, color: '#ffb0a0', planet: true },
  { id: 'arsenal', name: '아스널 조병창', sec: 78, at: [2190, 430], desc: '철갑 사령부의 조병 산업 지대. 합금과 화학소재로 무장 부품을 만든다.', slots: 0, tier: 1, color: '#ffc0a8', planet: true },
  { id: 'muster', name: '집결 기지', sec: 62, at: [1740, 340], desc: '검은 관문을 마주한 철갑 사령부의 국경 집결지.', slots: 1, tier: 1, color: '#f0c0b0' },
  { id: 'rampart', name: '성벽 회랑', sec: 46, at: [1720, 560], desc: '교차로 시장과 동부를 잇는 국경 회랑. 흉터 성운과 맞닿아 있어 분쟁 시 봉쇄된다.', slots: 1, tier: 2, color: '#f4d0b8' },
  { id: 'scar', name: '흉터 성운', sec: 12, at: [1450, 640], desc: '송곳니와 성벽 회랑 사이의 해적 근거지. 수정 광맥이 풍부하다.', slots: 1, tier: 2, color: '#e28a80' },
  { id: 'gloam', name: '어스름 공역', sec: 30, at: [1480, 70], desc: '공개 성도에 없는 북방 공역.', slots: 1, tier: 2, color: '#9fb4d8' },
  { id: 'zenith', name: '천정 공역', sec: 26, at: [1780, 110], desc: '공개 성도에 없는 북동 공역.', slots: 1, tier: 3, color: '#b8a8ff' },
  { id: 'veil', name: '장막 공역', sec: 15, at: [2290, 690], desc: '공개 성도에 없는 동쪽 끝 공역.', slots: 1, tier: 3, color: '#a890e0' },
  { id: 'drift', name: '표류 공역', sec: 33, at: [1700, 960], desc: '공개 성도에 없는 남동 공역.', slots: 1, tier: 2, color: '#b0c8e0' },
  { id: 'echo', name: '메아리 공역', sec: 22, at: [1960, 1060], desc: '공개 성도에 없는 남동 외곽.', slots: 1, tier: 3, color: '#c0a0d0' },
  { id: 'abyss', name: '심연 공역', sec: 8, at: [2230, 930], desc: '공개 성도에 없는 가장 깊은 공역.', slots: 2, tier: 3, color: '#8a70c0' },
  { id: 'cradle', name: '요람 공역', sec: 40, at: [130, 1010], desc: '공개 성도에 없는 서남 공역.', slots: 1, tier: 1, color: '#c8e0ff' },
  { id: 'mire', name: '늪 성운', sec: 28, at: [330, 1090], desc: '공개 성도에 없는 가스 성운.', slots: 1, tier: 2, color: '#a8c8b0' },
];
/** explicit, stable indices for the new systems (never reorder) */
const INDICES: Record<string, number> = { crossroads: 22, meridian: 23, kiln: 24, tundra: 25, deepmine: 26, bulwark: 27, arsenal: 28, muster: 29, rampart: 30, scar: 31, gloam: 32, zenith: 33, veil: 34, drift: 35, echo: 36, abyss: 37, cradle: 38, mire: 39 };
/** P9 systems keep their chart shape, shifted down to leave room for the northern uncharted belt */
const P9_AT: Record<string, [number, number]> = {
  helios: [410, 495], astra: [605, 520], lyra: [340, 350], ceres: [525, 340], anvil: [765, 275], rime: [990, 190], drake: [820, 450], junction: [1025, 375],
  shard: [1195, 285], watch: [1375, 210], blackgate: [1510, 350], harbor: [315, 665], forge: [530, 715], sunder: [745, 760], ember: [935, 670], fang: [1180, 745],
  frontier: [1460, 875], quiet: [140, 820], salvage: [405, 930], rift: [655, 975], relic: [910, 980], dusk: [1155, 945],
};
export const P10_LINKS: [string, string][] = [
  ['crossroads', 'junction'], ['crossroads', 'ember'], ['crossroads', 'rampart'], ['rampart', 'muster'], ['rampart', 'scar'], ['rampart', 'meridian'],
  ['muster', 'bulwark'], ['muster', 'blackgate'], ['bulwark', 'arsenal'], ['arsenal', 'meridian'], ['meridian', 'frontier'], ['scar', 'fang'],
  ['sunder', 'kiln'], ['kiln', 'relic'], ['rime', 'tundra'], ['tundra', 'gloam'], ['gloam', 'zenith'], ['zenith', 'bulwark'], ['anvil', 'deepmine'],
  ['frontier', 'drift'], ['drift', 'echo'], ['echo', 'abyss'], ['abyss', 'veil'], ['veil', 'arsenal'], ['quiet', 'cradle'], ['cradle', 'mire'],
];

/** territory: faction (absent = unclaimed) and region type of every system */
export const P10_TERRITORY: Record<string, { f?: string; r: RegionKind }> = {
  helios: { f: 'union', r: 'capital' }, lyra: { f: 'union', r: 'industrial' }, harbor: { f: 'union', r: 'industrial' }, quiet: { f: 'union', r: 'resource' },
  astra: { f: 'guild', r: 'capital' }, salvage: { f: 'guild', r: 'resource' }, crossroads: { f: 'guild', r: 'neutral' }, meridian: { f: 'guild', r: 'neutral' },
  ceres: { f: 'ceres', r: 'capital' }, forge: { f: 'ceres', r: 'industrial' }, kiln: { f: 'ceres', r: 'industrial' }, sunder: { f: 'ceres', r: 'border' },
  anvil: { f: 'miners', r: 'capital' }, drake: { f: 'miners', r: 'resource' }, rime: { f: 'miners', r: 'resource' }, tundra: { f: 'miners', r: 'resource' },
  deepmine: { f: 'miners', r: 'resource' }, junction: { f: 'miners', r: 'border' }, ember: { f: 'miners', r: 'border' },
  bulwark: { f: 'iron', r: 'capital' }, arsenal: { f: 'iron', r: 'industrial' }, muster: { f: 'iron', r: 'border' }, rampart: { f: 'iron', r: 'border' },
  blackgate: { f: 'pirates', r: 'lawless' }, watch: { f: 'pirates', r: 'lawless' }, dusk: { f: 'pirates', r: 'lawless' }, fang: { f: 'pirates', r: 'lawless' }, scar: { f: 'pirates', r: 'border' },
  shard: { r: 'lawless' }, rift: { r: 'lawless' }, relic: { r: 'neutral' }, frontier: { r: 'lawless' },
  gloam: { r: 'uncharted' }, zenith: { r: 'uncharted' }, veil: { r: 'uncharted' }, drift: { r: 'uncharted' }, echo: { r: 'uncharted' }, abyss: { r: 'uncharted' }, cradle: { r: 'uncharted' }, mire: { r: 'uncharted' },
};

/** border fronts: gate pairs a conflict between the two factions closes */
export const P10_FRONTS: { a: string; b: string; edges: [string, string][] }[] = [
  { a: 'iron', b: 'pirates', edges: [['rampart', 'scar'], ['muster', 'blackgate']] },
  { a: 'miners', b: 'pirates', edges: [['junction', 'shard']] },
  { a: 'iron', b: 'guild', edges: [['crossroads', 'rampart']] },
  { a: 'ceres', b: 'miners', edges: [['sunder', 'ember']] },
];

const INIT: Record<string, { strength: number; infra: number; rel: Record<string, number> }> = {
  union: { strength: 60, infra: 50, rel: { pirates: -70, guild: 20, ceres: 10, miners: 5, iron: 0 } },
  guild: { strength: 25, infra: 40, rel: { pirates: -20, union: 20, ceres: 15, miners: 15, iron: -15 } },
  ceres: { strength: 30, infra: 45, rel: { miners: 0, union: 10, guild: 15, iron: -5, pirates: -40 } },
  miners: { strength: 25, infra: 30, rel: { ceres: 0, pirates: -50, union: 5, guild: 15, iron: 5 } },
  iron: { strength: 70, infra: 45, rel: { pirates: -85, guild: -15, union: 0, ceres: -5, miners: 5 } },
  pirates: { strength: 45, infra: 15, rel: { iron: -85, union: -70, miners: -50, guild: -20, ceres: -40 } },
};

// New public markets. Stock is the usual target fill; the budgets are finite (fundsMax) like every other NPC market.
const STATIONS = [
  { sys: 'crossroads', id: 'p10_crossroads_bazaar', name: '교차로 대시장', owner: 'guild', funds: 160000, desc: '여러 세력의 상인이 모이는 중립 대시장.' },
  { sys: 'meridian', id: 'p10_meridian_port', name: '자오선 교역항', owner: 'guild', funds: 90000, desc: '동부 국경의 길드 교역항.' },
  { sys: 'kiln', id: 'p10_kiln_works', name: '킬른 합금 공장', owner: 'guild', funds: 140000, desc: '금속과 티타늄 광석으로 합금을 만드는 세레스 연맹 공장.' },
  { sys: 'tundra', id: 'p10_tundra_camp', name: '툰드라 채굴 캠프', owner: 'guild', funds: 30000, desc: '작은 광부 캠프. 소모품을 들여오면 반긴다.' },
  { sys: 'deepmine', id: 'p10_deepmine_post', name: '심층 광산 전초', owner: 'guild', funds: 25000, desc: '광산 입구의 보급 전초.' },
  { sys: 'bulwark', id: 'p10_bulwark_yard', name: '불워크 군항', owner: 'union', funds: 200000, desc: '철갑 사령부의 수도 군항. 함선 부품과 장갑판을 대량으로 사들인다.' },
  { sys: 'arsenal', id: 'p10_arsenal_works', name: '아스널 조병창', owner: 'union', funds: 150000, desc: '합금과 화학소재로 무장 부품을 만드는 조병창.' },
  { sys: 'muster', id: 'p10_muster_depot', name: '집결 보급창', owner: 'union', funds: 70000, desc: '국경 함대를 위한 보급창.' },
];
/** NPC market profiles for the new stations (registered into PROFILES at module load) */
export const P10_PROFILES: Record<string, (typeof PROFILES)[string]> = {
  p10_crossroads_bazaar: { make: [], use: { alloy: 0.15, machinery: 0.03, chemicals: 0.04 }, sell: ['ore', 'metal', 'alloy', 'titanium_ore', 'crystal', 'chemicals', 'machinery', 'electronics', 'structure'] },
  p10_meridian_port: { make: [], use: { alloy: 0.1, chemicals: 0.03 }, sell: ['ore', 'alloy', 'metal', 'chemicals', 'machinery'] },
  p10_kiln_works: { make: [], use: { ore: 0.2 }, conv: [{ in: { metal: 1, titanium_ore: 0.5 }, out: { alloy: 0.9 }, rate: 0.8 }], sell: ['ore', 'metal', 'titanium_ore', 'alloy'] },
  p10_tundra_camp: { make: ['ore'], use: { machinery: 0.03, chemicals: 0.03 }, sell: ['ore', 'titanium_ore', 'machinery', 'chemicals', 'alloy', 'structure'] },
  p10_deepmine_post: { make: [], use: { machinery: 0.03, chemicals: 0.02 }, sell: ['ore', 'rare_ore', 'machinery', 'chemicals'] },
  p10_bulwark_yard: { mult: 1.1, make: [], use: { alloy: 0.2 }, sell: ['alloy', 'armor_plate', 'weapon_parts', 'electronics', 'chemicals', 'structure'] },
  p10_arsenal_works: { make: ['weapon_parts'], use: { alloy: 0.25, chemicals: 0.05 }, sell: ['alloy', 'metal', 'titanium', 'chemicals', 'machinery', 'weapon_parts', 'armor_plate'] },
  p10_muster_depot: { make: [], use: { chemicals: 0.04 }, sell: ['alloy', 'chemicals', 'weapon_parts', 'armor_plate'] },
};
for (const [k, v] of Object.entries(P10_PROFILES)) PROFILES[k] ??= v;

/** Unidentified deposits. Shares here are the hidden truth; nobody sees them except through samples. */
interface GeoDef { sys: string; id: string; name: string; look: string; amount: number; rich: number; angle: number; layers: GeoLayer[]; veins: GeoVein[]; hidden?: boolean; hints: string[] }
const L = (until: number, mix: Record<string, number>): GeoLayer => ({ until, mix });
const GEO: GeoDef[] = [
  { sys: 'tundra', id: 'p10_tundra_ore', name: '툰드라 동토 광상', look: 'ore', amount: 15000, rich: 1.2, angle: 1.0, hints: ['철질 반응이 넓게 퍼져 있음'],
    layers: [L(1500, { ore: .8, silicate: .2 }), L(1e12, { ore: .6, titanium_ore: .3, silicate: .1 })], veins: [{ item: 'dense_titanium_ore', share: .08, after: 4000, zones: [1] }] },
  { sys: 'deepmine', id: 'p10_deepmine_shaft', name: '심층 수직갱', look: 'ore', amount: 22000, rich: 1.3, angle: 2.2, hints: ['깊이에 따라 반응이 달라짐'],
    layers: [L(2000, { ore: .9, silicate: .1 }), L(6000, { ore: .65, titanium_ore: .25, rare_ore: .1 }), L(1e12, { ore: .45, titanium_ore: .3, rare_ore: .25 })], veins: [{ item: 'singular_ore', share: .04, after: 8000, zones: [2] }] },
  { sys: 'scar', id: 'p10_scar_crystal', name: '흉터 결정대', look: 'crystal', amount: 5000, rich: 1.6, angle: 3.1, hints: ['반투명 결정 반사'],
    layers: [L(1e12, { crystal: .55, rare_ore: .35, gas: .1 })], veins: [{ item: 'resonant_crystal', share: .1, after: 1500, zones: [0, 2] }] },
  { sys: 'shard', id: 'p10_shard_outer', name: '파편 외곽 잔해대', look: 'crystal', amount: 3000, rich: 1.3, angle: 5.6, hidden: true, hints: ['약한 결정 반응'],
    layers: [L(1e12, { crystal: .4, silicate: .6 })], veins: [] },
  { sys: 'gloam', id: 'p10_gloam_ice', name: '어스름 빙하체', look: 'gas', amount: 9000, rich: 1.4, angle: 0.7, hints: ['휘발성 가스 방출'],
    layers: [L(1e12, { gas: .6, silicate: .3, crystal: .1 })], veins: [{ item: 'unstable_isotope', share: .12, after: 2500, zones: [1, 3] }] },
  { sys: 'zenith', id: 'p10_zenith_vein', name: '천정 금속맥', look: 'titanium_ore', amount: 12000, rich: 1.5, angle: 2.4, hints: ['밝은 금속 광택'],
    layers: [L(3000, { titanium_ore: .5, ore: .5 }), L(1e12, { titanium_ore: .45, rare_ore: .2, ore: .35 })], veins: [{ item: 'dense_titanium_ore', share: .15, after: 3000, zones: [0, 1] }] },
  { sys: 'veil', id: 'p10_veil_anomaly', name: '장막 중력 이상', look: 'rare_ore', amount: 6000, rich: 1.8, angle: 4.0, hidden: true, hints: ['이상 중력 반응 — 정밀 탐사 필요'],
    layers: [L(1e12, { rare_ore: .5, ore: .4, crystal: .1 })], veins: [{ item: 'singular_ore', share: .2, after: 1200, zones: [0, 1, 2] }] },
  { sys: 'drift', id: 'p10_drift_rubble', name: '표류 암괴군', look: 'ore', amount: 11000, rich: 1.25, angle: 1.6, hints: ['철질 암괴 다수'],
    layers: [L(1e12, { ore: .7, silicate: .3 })], veins: [] },
  { sys: 'echo', id: 'p10_echo_geode', name: '메아리 정동', look: 'crystal', amount: 4000, rich: 1.7, angle: 5.0, hidden: true, hints: ['내부 공동에서 반향'],
    layers: [L(800, { silicate: .7, crystal: .3 }), L(1e12, { crystal: .6, rare_ore: .2, silicate: .2 })], veins: [{ item: 'resonant_crystal', share: .2, after: 1600, zones: [1] }] },
  { sys: 'abyss', id: 'p10_abyss_core', name: '심연 핵', look: 'rare_ore', amount: 9000, rich: 2.0, angle: 3.3, hints: ['짙은 금속 광맥 · 강한 방사'],
    layers: [L(1e12, { rare_ore: .45, ore: .35, crystal: .2 })], veins: [{ item: 'singular_ore', share: .15, after: 2000, zones: [0, 3] }, { item: 'unstable_isotope', share: .1, after: 4000, zones: [1] }] },
  { sys: 'cradle', id: 'p10_cradle_field', name: '요람 얕은 광상', look: 'ore', amount: 8000, rich: 1.1, angle: 2.0, hints: ['얕은 철질 반응'],
    layers: [L(1e12, { ore: .75, titanium_ore: .15, silicate: .1 })], veins: [] },
  { sys: 'mire', id: 'p10_mire_cloud', name: '늪 가스 구름', look: 'gas', amount: 10000, rich: 1.3, angle: 4.4, hints: ['짙은 가스층'],
    layers: [L(1e12, { gas: .7, silicate: .2, crystal: .1 })], veins: [{ item: 'unstable_isotope', share: .06, after: 5000, zones: [2] }] },
];
/** Existing P9 frontier fields that become unidentified in a P10 world: their old mix is the shallow layer. */
const P9_TO_GEO: Record<string, { veins: GeoVein[]; hints: string[] }> = {
  p9_shard_crystal: { veins: [{ item: 'resonant_crystal', share: .05, after: 2500, zones: [3] }], hints: ['반투명 결정 반사'] },
  p9_dusk_vein: { veins: [], hints: ['결정과 금속 반응'] },
  p9_blackgate_ore: { veins: [], hints: ['철질 암괴'] },
  p97_shard_resonance: { veins: [], hints: ['공명 반응'] },
  p97_dusk_isotope: { veins: [], hints: ['방사 반응'] },
  p97_blackgate_singular: { veins: [], hints: ['이상 중력 반응'] },
};

const LAIRS = [{ sys: 'scar', id: 'p10_scar_lair', name: '흉터 해적 소굴', tier: 2 }];

function gatePos(s: StarSystem, target: StarSystem): V {
  const angle = Math.atan2(target.map.y - s.map.y, target.map.x - s.map.x);
  return { x: s.origin.x + Math.cos(angle) * s.radius * .82, y: 40, z: s.origin.z + Math.sin(angle) * s.radius * .82 };
}

function geoOf(look: string, max: number, layers: GeoLayer[], veins: GeoVein[], hints: string[], hidden?: boolean): FieldGeo {
  return { look, size: sizeOf(max), hints: [LOOK_HINT[look] ?? look, ...hints], layers, veins, zones: 4, mined: 0, draws: 0, ...(hidden ? { hidden } : {}) };
}

/** Only for a P9 world straight out of expandFreshWorld (no players, no history). */
export function expandP10(w: WorldState): void {
  if (w.worldLayout !== 'p9' || w.regionalV !== 1 || Object.keys(w.systems).length !== 22 || Object.values(w.companies).some(c => c.kind === 'player') || w.time > 0)
    throw new Error('P10 layout requires a fresh P9 world');
  for (const [id, [x, y]] of Object.entries(P9_AT)) w.systems[id].map = { x: x / P10_CHART.w, y: y / P10_CHART.h };
  for (const d of DEFS) {
    const idx = INDICES[d.id];
    if (idx === undefined || w.systems[d.id] || Object.values(w.systems).some(s => s.idx === idx)) throw new Error(`P10 duplicate or missing system index: ${d.id}`);
    const s: StarSystem = { id: d.id, name: d.name, idx, origin: { x: sysOriginX(idx), y: 0, z: 0 }, radius: 50000, security: d.sec, kind: secBand(d.sec).kind, heat: 0, desc: d.desc,
      star: { name: d.name, color: d.color, size: 2200 }, nebula: ['#142841', '#242039'], map: { x: d.at[0] / P10_CHART.w, y: d.at[1] / P10_CHART.h }, planets: [], gates: [], lanes: [],
      stats: { pirateKills: 0, unionLosses: 0, civLosses: 0, raids: 0, bands: 0 }, exploration: { slots: d.slots, tier: d.tier } };
    if (d.planet) s.planets.push({ id: `p10_${d.id}_planet`, name: `${d.name} I`, pos: { x: s.origin.x - 16000, y: -250, z: 6000 }, size: 1700, color: '#7a8c9c', atmo: '#a8c4d8', ring: false, moons: [], desc: `${d.name}의 행성.` });
    w.systems[s.id] = s;
  }
  for (const [a, b] of P10_LINKS) for (const [from, to] of [[a, b], [b, a]]) {
    const s = w.systems[from], target = w.systems[to];
    if (!s || !target || s.gates.some(g => g.to === to)) throw new Error(`P10 link error ${from}>${to}`);
    s.gates.push({ id: `gate:${from}>${to}`, name: `${target.name} 점프게이트`, to, exit: `gate:${to}>${from}`, pos: gatePos(s, target) });
  }
  for (const [id, t] of Object.entries(P10_TERRITORY)) {
    const s = w.systems[id]; if (!s) throw new Error(`P10 territory for unknown system ${id}`);
    if (t.f) s.faction = t.f;
    s.region = t.r;
    s.charted = t.r !== 'uncharted';
  }
  for (const def of STATIONS) {
    const s = w.systems[def.sys], market: Market = {}, p = P10_PROFILES[def.id];
    for (const id of new Set([...p.make, ...p.sell, ...Object.keys(p.use), ...(p.conv ?? []).flatMap(c => [...Object.keys(c.in), ...Object.keys(c.out)])])) {
      const target = targetFor(id);
      const base = marketBase(w, id, p.mult ?? 1, () => Math.round((ITEMS[id]?.cat === 'raw' ? itemPrice(id) * RAW_PRICE_V4 : valueOf(id)) * (p.mult ?? 1) * 10) / 10);
      market[id] = { stock: Math.round(target * .5), target, base };
    }
    const storage = Object.fromEntries(Object.keys(w.companies).map(id => [id, emptyCargo()]));
    w.stations[def.id] = { id: def.id, name: def.name, owner: def.owner, public: true, style: def.sys === 'kiln' || def.sys === 'arsenal' ? 2 : 0,
      pos: { x: s.origin.x + 8000, y: 0, z: 6000 }, radius: 240, market, services: { repair: true, shipyard: [], recruit: false, contracts: true, refit: false },
      storage, modules: [], defenseHp: 1, founded: 0, tax: s.security >= 90 ? .08 : s.security >= 70 ? .05 : .02, garrison: s.region === 'capital' ? 2 : 0, fundsMax: def.funds, funds: def.funds * .6, desc: def.desc };
    s.lanes = s.gates.map(g => [g.id, def.id]);
  }
  // every public market belongs to the faction that holds its system (pirate markets included)
  for (const st of Object.values(w.stations)) if (st.public && st.market) {
    const sys = Object.values(w.systems).find(s => Math.abs(st.pos.x - s.origin.x) < s.radius + 20000);
    if (sys?.faction) st.faction = sys.faction;
  }
  for (const d of GEO) {
    const s = w.systems[d.sys], pos = { x: s.origin.x + Math.cos(d.angle) * 21000, y: 0, z: s.origin.z + Math.sin(d.angle) * 21000 };
    if (w.fields[d.id]) throw new Error(`P10 field collision ${d.id}`);
    const f: Field = { id: d.id, name: d.name, pos, radius: 900, res: d.look, amount: d.amount, max: d.amount, regen: d.amount / 8000, rocks: 100, salvage: false, expires: 0,
      danger: s.security >= 40 ? 2 : 3, rich: d.rich, geo: geoOf(d.look, d.amount, d.layers.map(l => ({ until: l.until, mix: { ...l.mix } })), d.veins.map(v => ({ ...v, zones: [...v.zones] })), d.hints, d.hidden) };
    w.fields[d.id] = f;
  }
  for (const [id, conv] of Object.entries(P9_TO_GEO)) {
    const f = w.fields[id]; if (!f?.mix) throw new Error(`P10 missing P9 field ${id}`);
    f.geo = geoOf(f.res, f.max, [{ until: 1e12, mix: { ...f.mix } }], conv.veins.map(v => ({ ...v, zones: [...v.zones] })), conv.hints);
    delete f.mix;   // the composition is now hidden truth inside geo layers
  }
  for (const d of LAIRS) {
    const s = w.systems[d.sys];
    w.lairs[d.id] = { id: d.id, name: d.name, owner: 'pirates', pos: { x: s.origin.x - 26000, y: 0, z: -12000 }, hp: 1, alive: true, respawnAt: 0, nextBand: 240, maxBands: 1, tier: d.tier, kind: 'hideout' };
  }
  w.factions = {};
  for (const id of Object.keys(FACTIONS)) {
    const i = INIT[id];
    w.factions[id] = { id, strength: i.strength, infra: i.infra, stock: {}, made: { ships: 0, infra: 0, upkeep: 0 }, rel: { ...i.rel } } satisfies FactionState;
  }
  w.conflicts = {};
  w.intel = {};
  w.fog = 1;
  w.worldLayout = 'p10';
  seedSites(w);
}
