// Industrial hardpoint gear (growth worlds): mining lasers, construction rigs and salvage rigs in four
// sizes. A ship mines, builds or salvages only with this gear fitted in an `industrial` bay; the hull's
// design adds an efficiency bonus (HullOps.bonus) but no capability of its own (world/hullops.ts).
// Sizes trade capability for power, mass and price — an S rig fits every industrial hull, XL only the
// largest. Prices come from the recipes (industry.ts equipPrice), like every other module.
import type { ModuleContent, Size, IndWork } from '../../schema';

const NAME: Record<IndWork, string> = { mine: '채굴 레이저', build: '건설 장비', salvage: '인양 장비' };
const SIZE_NAME: Record<Size, string> = { S: '소형', M: '중형', L: '대형', XL: '초대형' };
const KEY: Record<IndWork, string> = { mine: 'mine', build: 'build', salvage: 'salv' };

const G = (work: IndWork, size: Size, rate: number, power: number, mass: number, time: number, inp: Record<string, number>, desc: string, tech?: string): ModuleContent => ({
  id: `ind_${KEY[work]}_${size.toLowerCase()}`, name: `${SIZE_NAME[size]} ${NAME[work]}`, desc,
  slot: 'industrial', size, mass, power, fx: {}, ind: { work, rate }, ...(tech ? { tech } : {}),
  recipe: { fac: 'machine_shop', time, in: inp },
});

export const IND_MODULES: ModuleContent[] = [
  // mining lasers — rate in ore units / s before the hull bonus (the old 곡괭이급 = S laser × 1.28)
  G('mine', 'S', 2.5, 4, 4, 300, { machinery: 4, precision: 1, crystal: 2 }, '기본 채굴 레이저. 초당 2.5 단위 채굴. 산업 하드포인트(S 이상)에 장착.'),
  G('mine', 'M', 5, 7, 8, 600, { machinery: 8, precision: 3, crystal: 4, electronics: 1 }, '중형 채굴 레이저. 초당 5 단위 채굴. 산업 하드포인트(M 이상)에 장착.'),
  G('mine', 'L', 10, 12, 14, 1200, { machinery: 16, precision: 6, crystal: 8, electronics: 4 }, '대형 굴착 레이저. 초당 10 단위 채굴. 심부 채굴 연구로 생산.', 'deep_core'),
  G('mine', 'XL', 20, 18, 22, 2400, { machinery: 30, precision: 14, crystal: 16, electronics: 10 }, '초대형 분쇄 레이저. 초당 20 단위 채굴. 초대형 산업 하드포인트 전용.', 'deep_core'),
  // construction rigs — work rate (1 = the old standard 석공급 constructor) before the hull bonus
  G('build', 'S', 0.4, 3, 5, 300, { machinery: 5, precision: 1, electronics: 1 }, '용접 드론 한 조. 건설 속도 0.4. 산업 하드포인트(S 이상)에 장착.'),
  G('build', 'M', 0.8, 6, 9, 600, { machinery: 10, precision: 3, electronics: 2 }, '조립 크레인과 드론 격납고. 건설 속도 0.8.'),
  G('build', 'L', 1.6, 10, 15, 1200, { machinery: 20, precision: 6, electronics: 6 }, '갠트리 크레인 세트. 건설 속도 1.6. 정거장 공학 연구로 생산.', 'station_engineering'),
  G('build', 'XL', 3.2, 16, 24, 2400, { machinery: 40, precision: 14, electronics: 14, composite: 10 }, '건설 드론 편대 격납고. 건설 속도 3.2. 초대형 산업 하드포인트 전용.', 'station_engineering'),
  // salvage rigs — multiplier on the salvage base rates (1 = the old 석공급 constructor) before the hull bonus
  G('salvage', 'S', 1, 3, 4, 300, { machinery: 4, precision: 1, composite: 2 }, '견인 빔과 절단 토치. 잔해의 화물·장비·선체·설계도 조각을 회수한다 (인양 효율 1.0).'),
  G('salvage', 'M', 1.6, 6, 8, 600, { machinery: 8, precision: 2, electronics: 1, composite: 4 }, '회수 크레인과 절단 드론. 인양 효율 1.6.'),
  G('salvage', 'L', 2.6, 10, 13, 1200, { machinery: 16, precision: 5, electronics: 3, composite: 8 }, '대형 인양 갠트리. 인양 효율 2.6. 전장 회수 연구로 생산.', 'salvage_ops'),
  G('salvage', 'XL', 4.2, 15, 20, 2400, { machinery: 30, precision: 12, electronics: 8, composite: 16 }, '해체 독 수준의 인양 설비. 인양 효율 4.2. 초대형 산업 하드포인트 전용.', 'salvage_ops'),
];

/** the industrial gear id of a work and size */
export const indGear = (work: IndWork, size: Size) => `ind_${KEY[work]}_${size.toLowerCase()}`;
