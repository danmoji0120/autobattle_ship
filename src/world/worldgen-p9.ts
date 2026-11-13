// The P9 layout is applied only to a freshly created, already migrated growth world.
// Loading a save never calls this function, so legacy topology and assets remain untouched.
import type { WorldState, StarSystem, Market, V } from './types';
import { emptyCargo } from './types';
import { sysOriginX } from './geom';
import { secBand } from './worldgen';
import { seedSites } from './explore';
import { ITEMS, itemPrice } from './industry';
import { RAW_PRICE_V4 } from './econConfig';
import { valueOf } from './valuation';
import { marketBase } from './econChain';
import { targetFor } from './economy';
import { activateRegionalResources } from './regional';

type Def = { id: string; name: string; sec: number; x: number; y: number; desc: string; slots: number; tier: 1 | 2 | 3; color: string; planet?: boolean };
const DEFS: Def[] = [
  { id: 'lyra', name: '리라 교역권', sec: 84, x: .10, y: .12, desc: '수도권과 산업 회랑을 잇는 상업 항로. 설비와 합금의 꾸준한 수요가 있다.', slots: 1, tier: 1, color: '#ffe6aa', planet: true },
  { id: 'ceres', name: '세레스 공업권', sec: 76, x: .29, y: .12, desc: '광석을 금속으로 가공하고 기계를 공급하는 독립 산업 지대.', slots: 1, tier: 1, color: '#ffd6a0', planet: true },
  { id: 'anvil', name: '앤빌 광구', sec: 57, x: .48, y: .12, desc: '두 광맥과 작은 조합 항구가 있는 광업 성계. 현지 구매 예산은 넉넉하지 않다.', slots: 1, tier: 1, color: '#ffbd89', planet: true },
  { id: 'rime', name: '서리 변경', sec: 65, x: .67, y: .12, desc: '앤빌 끝자락의 빈 변경. 시설도 확인된 광상도 없는 막다른 공역이다.', slots: 0, tier: 1, color: '#aedcff' },
  { id: 'watch', name: '감시자의 틈', sec: 17, x: .82, y: .12, desc: '균열 항로를 지키는 해적 초소. 검은 관문에 이르는 마지막 요충지다.', slots: 1, tier: 2, color: '#f3aa86' },
  { id: 'junction', name: '북방 관문', sec: 48, x: .62, y: .35, desc: '드레이크와 북방 외곽을 잇는 보급 거점. 이곳 밖으로는 안전한 우회로가 없다.', slots: 1, tier: 1, color: '#fff1c4', planet: true },
  { id: 'shard', name: '파편 항로', sec: 28, x: .80, y: .35, desc: '수정과 희귀 광석이 섞인 무정거장 광구. 외곽으로 가는 병목이다.', slots: 1, tier: 2, color: '#a8cbff' },
  { id: 'blackgate', name: '검은 관문', sec: 6, x: .96, y: .12, desc: '반연합 세력의 미래 거점이 될 수 있는 외딴 무법 공역. 위험에 비해 확인된 유물은 드물다.', slots: 0, tier: 1, color: '#b391ff' },
  { id: 'harbor', name: '하버 거주권', sec: 82, x: .08, y: .62, desc: '헬리오스 외곽의 거주·상업 성계. 변경으로 향하는 선단의 중간 기항지다.', slots: 1, tier: 1, color: '#e7f3ff', planet: true },
  { id: 'forge', name: '포지 산업권', sec: 69, x: .26, y: .62, desc: '광석과 합금을 소비하는 구조재 생산지. 변경의 자원을 수도권으로 연결한다.', slots: 1, tier: 1, color: '#ffd0a0', planet: true },
  { id: 'sunder', name: '갈라진 회랑', sec: 40, x: .42, y: .62, desc: '산업권과 엠버를 잇는 개발 가능한 변경. 이곳의 가치는 우회 항로에 있다.', slots: 0, tier: 1, color: '#ffe7b5' },
  { id: 'frontier', name: '끝자락', sec: 35, x: .96, y: .62, desc: '검은 송곳니 바깥의 막다른 빈 공역. 발견된 시설이나 자원은 없다.', slots: 0, tier: 1, color: '#b6a8d8' },
  { id: 'quiet', name: '고요한 공백', sec: 60, x: .08, y: .87, desc: '하버에서 이어지는 빈 성계. 개발 여부는 방문자의 선택에 달렸다.', slots: 0, tier: 1, color: '#b6d3ff' },
  { id: 'salvage', name: '회수 항로', sec: 52, x: .26, y: .87, desc: '옛 수송선의 잔해가 남은 항로. 주변의 안정적인 항구와 인양 사업을 연결한다.', slots: 2, tier: 2, color: '#f3d6b2' },
  { id: 'rift', name: '균열 공백', sec: 32, x: .44, y: .87, desc: '정거장과 확인된 보물이 없는 위험한 통과 공역. 우회 항로의 가치는 높다.', slots: 0, tier: 1, color: '#e6a789' },
  { id: 'relic', name: '기록 보관지', sec: 48, x: .62, y: .87, desc: '오래된 기록의 흔적이 보고된 변경. 위험이 가장 큰 곳만이 탐사의 목적지는 아니다.', slots: 1, tier: 3, color: '#d0e4ff' },
  { id: 'dusk', name: '황혼 광맥', sec: 16, x: .80, y: .87, desc: '수정과 희귀 광석이 있는 해적 활동 지역. 송곳니로 통하는 남쪽 접근로다.', slots: 1, tier: 2, color: '#ff9b82' },
];

// The original five links and all in-system coordinates are retained. Each added edge creates both gates.
const LINKS: [string, string][] = [
  ['helios', 'lyra'], ['lyra', 'ceres'], ['ceres', 'astra'], ['ceres', 'anvil'], ['anvil', 'drake'], ['anvil', 'rime'],
  ['helios', 'harbor'], ['harbor', 'forge'], ['forge', 'astra'], ['forge', 'sunder'], ['sunder', 'ember'],
  ['harbor', 'quiet'], ['forge', 'salvage'], ['salvage', 'rift'], ['sunder', 'rift'], ['rift', 'relic'], ['relic', 'dusk'], ['dusk', 'fang'], ['fang', 'frontier'],
  ['drake', 'junction'], ['junction', 'shard'], ['shard', 'watch'], ['watch', 'blackgate'],
];
const LEGACY_MAP: Record<string, [number, number]> = { helios: [.08, .35], astra: [.26, .35], drake: [.44, .35], ember: [.60, .62], fang: [.78, .62] };
// Stable spatial indices are explicit: reordering or appending definitions cannot move an existing system.
const INDICES: Record<string, number> = { lyra: 5, ceres: 6, anvil: 7, rime: 8, watch: 9, junction: 10, shard: 11, blackgate: 12, harbor: 13, forge: 14, sunder: 15, frontier: 16, quiet: 17, salvage: 18, rift: 19, relic: 20, dusk: 21 };

const STATIONS = [
  { sys: 'lyra', id: 'p9_lyra_port', name: '리라 상업항', funds: 180000, goods: ['ore', 'alloy', 'metal', 'electronics', 'machinery'], desc: '산업 설비를 소비하는 수도권 외곽 상업항.' },
  { sys: 'ceres', id: 'p9_ceres_works', name: '세레스 제련단지', funds: 150000, goods: ['ore', 'metal', 'alloy', 'machinery'], desc: '광석을 금속으로 제련하고 기계를 공급한다.' },
  { sys: 'anvil', id: 'p9_anvil_port', name: '앤빌 광부조합', funds: 35000, goods: ['ore', 'titanium_ore', 'alloy', 'machinery'], desc: '광구의 작은 항구. 거래 예산이 작아 장거리 판매가 중요하다.' },
  { sys: 'harbor', id: 'p9_harbor_port', name: '하버 정거장', funds: 130000, goods: ['ore', 'metal', 'alloy', 'machinery'], desc: '주민과 상선이 이용하는 민간 기항지.' },
  { sys: 'forge', id: 'p9_forge_works', name: '포지 구조재 공장', funds: 145000, goods: ['ore', 'metal', 'alloy', 'structure'], desc: '변경 광석을 가공하고 구조재를 생산한다.' },
  { sys: 'junction', id: 'p9_junction_port', name: '북방 보급소', funds: 60000, goods: ['ore', 'alloy', 'machinery'], desc: '북방 병목의 소규모 보급항. 군사적인 방어는 보장되지 않는다.' },
];
const FIELDS: { sys: string; id: string; name: string; res: string; mix: Record<string, number>; amount: number; rich: number; angle: number }[] = [
  { sys: 'anvil', id: 'p9_anvil_ore', name: '앤빌 철광대', res: 'ore', mix: { ore: .7, titanium_ore: .3 }, amount: 17000, rich: 1.25, angle: 1.2 },
  { sys: 'anvil', id: 'p9_anvil_titanium', name: '앤빌 티타늄맥', res: 'ore', mix: { ore: .35, titanium_ore: .5, silicate: .15 }, amount: 11000, rich: 1.15, angle: 3.5 },
  { sys: 'shard', id: 'p9_shard_crystal', name: '파편 결정대', res: 'crystal', mix: { crystal: .65, rare_ore: .35 }, amount: 3800, rich: 1.35, angle: 2.5 },
  { sys: 'salvage', id: 'p9_salvage_debris', name: '회수 항로 잔해', res: 'alloy', mix: { alloy: .5, metal: .35, electronics: .15 }, amount: 3000, rich: .9, angle: 2 },
  { sys: 'dusk', id: 'p9_dusk_vein', name: '황혼 결정맥', res: 'crystal', mix: { crystal: .5, rare_ore: .5 }, amount: 4200, rich: 1.5, angle: 3 },
  { sys: 'blackgate', id: 'p9_blackgate_ore', name: '관문 외곽 광맥', res: 'ore', mix: { ore: .65, rare_ore: .35 }, amount: 6500, rich: 1.05, angle: 3.6 },
];
const LAIRS: { sys: string; id: string; name: string; tier: number }[] = [
  { sys: 'watch', id: 'p9_watch_lair', name: '감시자의 해적 초소', tier: 2 },
  { sys: 'blackgate', id: 'p9_blackgate_lair', name: '검은 관문 은신처', tier: 3 },
  { sys: 'dusk', id: 'p9_dusk_lair', name: '황혼 약탈단', tier: 2 },
];

/** Only call for a newly generated content-v4 world, before any player joins. */
export function expandFreshWorld(w: WorldState): void {
  if (w.worldLayout || (w.contentV ?? 0) < 4 || Object.keys(w.systems).length !== 5 || Object.values(w.companies).some(c => c.kind === 'player')) throw new Error('P9 layout requires a fresh growth world');
  for (const [id, [x, y]] of Object.entries(LEGACY_MAP)) w.systems[id].map = { x, y };
  for (const d of DEFS) {
    const idx = INDICES[d.id];
    if (idx === undefined || w.systems[d.id] || Object.values(w.systems).some(s => s.idx === idx)) throw new Error(`P9 duplicate or missing system index: ${d.id}`);
    const s: StarSystem = { id: d.id, name: d.name, idx, origin: { x: sysOriginX(idx), y: 0, z: 0 }, radius: 50000, security: d.sec, kind: secBand(d.sec).kind, heat: 0, desc: d.desc,
      star: { name: d.name, color: d.color, size: 2200 }, nebula: ['#142841', '#242039'], map: { x: d.x, y: d.y }, planets: [], gates: [], lanes: [],
      stats: { pirateKills: 0, unionLosses: 0, civLosses: 0, raids: 0, bands: 0 }, exploration: { slots: d.slots, tier: d.tier } };
    if (d.planet) s.planets.push({ id: `p9_${d.id}_planet`, name: `${d.name} I`, pos: { x: s.origin.x - 16000, y: -250, z: 6000 }, size: 1700, color: '#647c93', atmo: '#9dc2db', ring: false, moons: [], desc: `${d.name}의 행성.` });
    w.systems[s.id] = s;
  }
  for (const [a, b] of LINKS) for (const [from, to] of [[a, b], [b, a]]) {
    const s = w.systems[from], target = w.systems[to];
    const angle = Math.atan2(target.map.y - s.map.y, target.map.x - s.map.x);
    const pos: V = { x: s.origin.x + Math.cos(angle) * s.radius * .82, y: 40, z: s.origin.z + Math.sin(angle) * s.radius * .82 };
    s.gates.push({ id: `gate:${from}>${to}`, name: `${target.name} 점프게이트`, to, exit: `gate:${to}>${from}`, pos });
  }
  for (const def of STATIONS) {
    const s = w.systems[def.sys], market: Market = {};
    for (const id of def.goods) {
      const target = targetFor(id);
      // Same c4 raw/production-cost price baseline as the existing economy.
      const base = marketBase(w, id, 1, () => Math.round((ITEMS[id]?.cat === 'raw' ? itemPrice(id) * RAW_PRICE_V4 : valueOf(id)) * 10) / 10);
      market[id] = { stock: Math.round(target * (id === 'ore' && (def.sys === 'ceres' || def.sys === 'forge') ? .25 : .6)), target, base };
    }
    const storage = Object.fromEntries(Object.keys(w.companies).map(id => [id, emptyCargo()]));
    w.stations[def.id] = { id: def.id, name: def.name, owner: 'guild', public: true, style: def.sys === 'ceres' || def.sys === 'forge' || def.sys === 'anvil' ? 2 : 0,
      pos: { x: s.origin.x + 8000, y: 0, z: 6000 }, radius: 240, market, services: { repair: true, shipyard: [], recruit: false, contracts: true, refit: false },
      storage, modules: [], defenseHp: 1, founded: 0, tax: s.security >= 70 ? .05 : .02, garrison: 0, fundsMax: def.funds, funds: def.funds * .6, desc: def.desc };
    s.lanes = s.gates.map(g => [g.id, def.id]);
  }
  for (const d of FIELDS) {
    const s = w.systems[d.sys], pos = { x: s.origin.x + Math.cos(d.angle) * 22000, y: 0, z: Math.sin(d.angle) * 22000 };
    w.fields[d.id] = { id: d.id, name: d.name, pos, radius: 900, res: d.res, mix: { ...d.mix }, amount: d.amount, max: d.amount, regen: d.amount / 8000, rocks: 100, salvage: false, expires: 0, danger: s.security >= 40 ? 2 : 3, rich: d.rich };
  }
  for (const d of LAIRS) {
    const s = w.systems[d.sys];
    w.lairs[d.id] = { id: d.id, name: d.name, owner: 'pirates', pos: { x: s.origin.x - 26000, y: 0, z: -12000 }, hp: 1, alive: true, respawnAt: 0, nextBand: 240, maxBands: 1, tier: d.tier, kind: 'hideout' };
  }
  w.worldLayout = 'p9';
  seedSites(w);
  activateRegionalResources(w);
}
