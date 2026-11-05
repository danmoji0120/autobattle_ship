import type { Res } from './types';
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
  destroyer: { cruise: 115, cargo: 0, mine: 0, price: 6500, alloy: 120, rep: 0, military: true },
  cruiser: { cruise: 90, cargo: 0, mine: 0, price: 15000, alloy: 260, rep: 10, military: true },
  battleship: { cruise: 70, cargo: 0, mine: 0, price: 36000, alloy: 600, rep: 30, military: true },
  miner: { cruise: 70, cargo: 140, mine: 3.2, price: 4200, alloy: 80, rep: 0, military: false },
  hauler: { cruise: 85, cargo: 450, mine: 0, price: 5200, alloy: 100, rep: 0, military: false },
  constructor: { cruise: 65, cargo: 300, mine: 0, price: 9000, alloy: 150, rep: 0, military: false },
  platform: { cruise: 0, cargo: 0, mine: 0, price: 0, alloy: 0, rep: 0, military: true },
};

export const RES_NAME: Record<Res, string> = { ore: '광석', alloy: '합금', crystal: '크리스탈' };
export const RES_COLOR: Record<Res, string> = { ore: '#d9a06b', alloy: '#b8c8d8', crystal: '#7fd8ff' };

export function shipValue(classId: string): number { return SHIP_CLASSES[classId]?.cost ?? 50; }

export interface ModuleDef {
  kind: string;
  name: string;
  desc: string;
  alloy: number;
  crystal: number;
  credits: number;
  work: number;            // seconds of constructor work
  requires?: string;
  /** management category */
  cat: '산업' | '조선' | '물류' | '군사' | '기타';
  /** what completing it switches on */
  unlocks: string;
}

/** how fast a docking hub's own crew builds (fraction of a constructor's base rate) */
export const STATION_CREW_RATE = 0.5;

export const MODULES: Record<string, ModuleDef> = {
  core: { kind: 'core', name: '도킹 허브', desc: '정거장의 심장. 정박·창고·자체 하역이 가능해진다.', alloy: 300, crystal: 0, credits: 8000, work: 60, cat: '기타', unlocks: '정박 · 자사 창고 · 채굴선 하역 · 정거장 자체 건설반 (공작선 없이도 다른 시설 건설)' },
  repair: { kind: 'repair', name: '정비소', desc: '정박한 자사 함선을 무료로 천천히 수리한다.', alloy: 180, crystal: 0, credits: 5000, work: 45, requires: 'core', cat: '군사', unlocks: '정박 함선 무료 수리' },
  refinery: { kind: 'refinery', name: '정제소', desc: '창고의 광석을 합금으로 정제한다 (광석 2 → 합금 1).', alloy: 220, crystal: 0, credits: 7000, work: 55, requires: 'core', cat: '산업', unlocks: '광석 → 합금 자동 정제 (초당 광석 4)' },
  defense: { kind: 'defense', name: '방어 포대', desc: '정거장 주변 전투에 중포대로 참전한다. 해적이 접근을 꺼린다.', alloy: 300, crystal: 10, credits: 9000, work: 60, requires: 'core', cat: '군사', unlocks: '정거장 방어 포대 (여러 기 건설 가능) · 주변 치안 상승' },
  shipyard: { kind: 'shipyard', name: '조선소', desc: '합금으로 함선을 직접 건조한다 (공용 조선소의 절반 가격).', alloy: 400, crystal: 40, credits: 15000, work: 90, requires: 'core', cat: '조선', unlocks: '함선 자체 건조 (가격 50% + 합금) · 장비 개조' },
  depot: { kind: 'depot', name: '확장 창고', desc: '정제 효율 +50%, 채굴선 하역 속도 증가.', alloy: 150, crystal: 0, credits: 3000, work: 35, requires: 'core', cat: '물류', unlocks: '정제 속도 +50% · 하역 속도 증가' },
};
export const MAX_MODULES = 7;

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
