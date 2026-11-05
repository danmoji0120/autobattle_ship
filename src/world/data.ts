import type { Res } from './types';
import { FACILITIES, ITEMS, itemName, type FacilityDef } from './industry';
import { SHIP_CLASSES } from '../sim/data/ships';
import type { Specialty, Voice } from '../sim/data/commanders';
import type { Rng } from '../sim/rng';

export interface ShipEcon {
  cruise: number;         // strategic speed (u/s)
  cargo: number;          // cargo capacity (units)
  mine: number;           // mining rate (units/s), 0 = cannot mine
  price: number;          // credits at a shipyard
  alloy: number;          // alloy needed when built at an own shipyard
  rep: number;            // Union standing needed to buy at public yards
  military: boolean;
}

export const ECON: Record<string, ShipEcon> = {
  corvette: { cruise: 150, cargo: 0, mine: 0, price: 3200, alloy: 60, rep: 0, military: true },
  frigate: { cruise: 130, cargo: 0, mine: 0, price: 4600, alloy: 90, rep: 5, military: true },
  light_cruiser: { cruise: 100, cargo: 0, mine: 0, price: 10500, alloy: 180, rep: 10, military: true },
  battlecruiser: { cruise: 80, cargo: 0, mine: 0, price: 26000, alloy: 420, rep: 40, military: true },
  dreadnought: { cruise: 55, cargo: 0, mine: 0, price: 120000, alloy: 1600, rep: 999, military: true },
  destroyer: { cruise: 115, cargo: 0, mine: 0, price: 6500, alloy: 120, rep: 0, military: true },
  cruiser: { cruise: 90, cargo: 0, mine: 0, price: 15000, alloy: 260, rep: 10, military: true },
  battleship: { cruise: 70, cargo: 0, mine: 0, price: 36000, alloy: 600, rep: 30, military: true },
  miner: { cruise: 70, cargo: 140, mine: 3.2, price: 4200, alloy: 80, rep: 0, military: false },
  hauler: { cruise: 85, cargo: 450, mine: 0, price: 5200, alloy: 100, rep: 0, military: false },
  constructor: { cruise: 65, cargo: 300, mine: 0, price: 9000, alloy: 150, rep: 0, military: false },
  platform: { cruise: 0, cargo: 0, mine: 0, price: 0, alloy: 0, rep: 0, military: true },
};

/** display name / colour of any item id (raw, refined, parts, equipment, blueprints) */
export const RES_NAME: Record<Res, string> = new Proxy({} as Record<Res, string>, { get: (_, k) => itemName(String(k)) });
export const RES_COLOR: Record<Res, string> = new Proxy({} as Record<Res, string>, { get: (_, k) => ITEMS[String(k)]?.color ?? (String(k).startsWith('bp:') ? '#9fd0ff' : '#e0c0a0') });

export function shipValue(classId: string): number { return SHIP_CLASSES[classId]?.cost ?? 50; }

/** station facilities — defined in industry.ts (data-driven) */
export type ModuleDef = FacilityDef;

/** how fast a docking hub's own crew builds (fraction of a constructor's base rate) */
export const STATION_CREW_RATE = 0.5;

export const MODULES: Record<string, FacilityDef> = FACILITIES;
/** facility kinds from older saves → their current equivalent */
export const LEGACY_MODULE: Record<string, string> = { shipyard: 'yard_s', depot: 'warehouse' };
export const MAX_MODULES = 40;

export const FOUND_COST = { credits: 8000, alloy: 300 };

// ---------------------------------------------------------------- commander generation

const SURNAMES = ['한', '레이', '오카다', '마르케스', '이바노바', '첸', '도우', '카터', '사토', '벨', '노박', '라일리', '박', '아베', '코왈스키', '모로', '케인', '하딩', '윤', '실바', '바스', '린드', '엔도', '로크'];
const GIVEN = ['서진', '아이리스', '마테오', '유나', '드미트리', '하나', '루카', '세라', '토비아스', '민', '에밀', '카라', '레오', '지우', '니코', '베라', '오렌', '사샤', '키란', '테오'];
const RANKS = ['대위', '소령', '중령', '대령'];
const COLORS = ['#7fd4ff', '#ffc27f', '#a7ff9f', '#ff9fd0', '#c8b0ff', '#ffe27a', '#8ff0e0', '#ffa080', '#b0d0ff'];
const VOICES: Voice[] = ['calm', 'bold', 'formal', 'nervous', 'savage'];
const SPECS: Specialty[] = ['tactics', 'gunnery', 'maneuver', 'defense', 'none'];
const BIOS = [
  '변경 순찰대 출신. 해적의 수법을 잘 안다.', '전직 화물선 선장. 위험을 피하는 감각이 탁월하다.', '정규군 장교 출신이지만 명령보다 결과를 중시한다.',
  '사관학교 수석 졸업. 실전 경험은 부족하다.', '채굴 조합에서 잔뼈가 굵었다. 소행성 지대를 손바닥처럼 안다.', '용병단을 전전한 베테랑. 돈 되는 일이면 마다하지 않는다.',
  '조용하지만 위기 때 판단이 빠르다.', '공격적인 함장. 부하들의 신뢰가 두텁다.',
];

export function generateCommander(rng: Rng, tier: number): Omit<import('./types').WCommander, 'id' | 'owner' | 'stationId'> {
  const skill = Math.min(0.92, 0.28 + tier * 0.12 + rng.range(0, 0.25));
  const aggression = rng.range(0.1, 0.95);
  const discipline = rng.range(0.3, 0.95);
  const rank = RANKS[Math.min(RANKS.length - 1, Math.floor(skill * 4.2))];
  return {
    name: `${rng.pick(SURNAMES)} ${rng.pick(GIVEN)}`,
    rank, skill, aggression, discipline,
    specialty: rng.pick(SPECS), voice: rng.pick(VOICES), color: rng.pick(COLORS), bio: rng.pick(BIOS),
    hireCost: Math.round((800 + skill * skill * 9000) / 100) * 100,
    xp: 0, level: 1, injuredUntil: 0, battles: 0,
  };
}

export const MILESTONES: { id: string; title: string; desc: string }[] = [
  { id: 'first_sale', title: '첫 수익', desc: '광석을 팔아 첫 수익을 올린다' },
  { id: 'first_contract', title: '첫 계약 완수', desc: '정거장의 계약을 하나 완수한다' },
  { id: 'first_victory', title: '첫 승리', desc: '해적과의 전투에서 승리한다' },
  { id: 'fleet_8', title: '함대 8척', desc: '함선 8척을 보유한다' },
  { id: 'commanders_3', title: '지휘부 구성', desc: '지휘관 3명을 보유한다' },
  { id: 'cruiser', title: '순양함 확보', desc: '순양함을 보유한다' },
  { id: 'station', title: '자체 정거장', desc: '자체 정거장의 도킹 허브를 완공한다' },
  { id: 'station_3', title: '산업 기지', desc: '정거장 모듈 3개를 완공한다' },
  { id: 'lair', title: '은신처 토벌', desc: '해적 은신처를 파괴한다' },
  { id: 'battleship', title: '전함 보유', desc: '전함을 보유한다' },
  { id: 'rich', title: '거대 기업', desc: '총자산 30만 크레딧을 넘긴다' },
];
