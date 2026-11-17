// P15.1 combat computers: real equipment for the dedicated `computer` bay (registry COMPUTER_BAY, one per
// combat hull). A computer changes how its own ship fights — engagement range, approach and withdrawal,
// line keeping, cover, torpedo runs (sim/ai/computer.ts) — inside its commander's orders. It has no stat
// effect (fx stays empty): the existing mod_fcs (accuracy) and mod_pd (interception) stay what they were.
//
// The product id is separate from the behaviour archetype (cpu.arch), so cheaper, better, obsolete or
// export versions of one behaviour are new rows. Price comes from the recipe like every module; research,
// blueprints and sale are independent of the behaviour. No hull class is required: any hull with a free
// computer bay and the power / mass to spare can run any of them. docs/P15_1_COMBAT_COMPUTERS.md
import type { ModuleContent, CpuModSpec } from '../../schema';

const C = (id: string, name: string, cpu: CpuModSpec, power: number, mass: number, time: number, inp: Record<string, number>, desc: string, tech?: string): ModuleContent => ({
  id, name, desc, slot: 'computer', size: 'S', mass, power, fx: {}, cpu, ...(tech ? { tech } : {}),
  recipe: { fac: 'electronics_fab', time, in: inp },
});

export const CPU_MODULES: ModuleContent[] = [
  // cheap generic: the line behaviour on slow, simple hardware (re-decides every 1.6 s)
  C('cpu_generic', '범용 전투 컴퓨터', { arch: 'line', react: 1.6 }, 2, 2, 300, { electronics: 3, precision: 1 },
    '저가 범용형. 전열 행동(사거리 중앙값·전열 유지)을 느린 판단 주기(1.6초)로 수행한다.'),
  // one standard product per archetype (re-decides every second)
  C('cpu_swarm', '군집 돌격 컴퓨터', { arch: 'swarm' }, 3, 2, 480, { electronics: 5, precision: 2 },
    '주무장 최단 사거리 안쪽까지 접근해 표적 주위를 선회하거나 스치듯 반복 강습한다.', 'fire_control'),
  C('cpu_picket', '초계 컴퓨터', { arch: 'picket' }, 3, 2, 480, { electronics: 5, precision: 2 },
    '가장 가치 있는 아군 곁에서 근접 위협·초계함·어뢰정을 먼저 막고, 아군을 노린 미사일까지 요격한다.', 'fire_control'),
  C('cpu_line', '전열 컴퓨터', { arch: 'line' }, 3, 2, 480, { electronics: 5, precision: 2 },
    '유효 사거리 중앙값에서 전열을 맞추고 가장 많은 포가 지향되는 각도로 표적을 유지한다.', 'fire_control'),
  C('cpu_artillery', '포격 컴퓨터', { arch: 'artillery' }, 4, 3, 600, { electronics: 6, precision: 3, crystal: 1 },
    '주무장 최장 사거리를 지키고, 적이 다가오면 거리를 벌리며 측방으로 비켜 선다.', 'fire_control'),
  C('cpu_siege', '공성 뇌격 컴퓨터', { arch: 'siege' }, 4, 3, 600, { electronics: 6, precision: 3, crystal: 1 },
    '대형함을 골라 측후방 발사각으로 어뢰 사거리까지 돌입, 발사 후 이탈했다가 재장전되면 다시 들어간다. 어뢰가 없으면 기본 제어.', 'fire_control'),
];

/** public stations that sell the standard computers from the start of a new growth world */
export const CPU_MARKETS: Record<string, string[]> = {
  helios: ['cpu_generic', 'cpu_line', 'cpu_artillery', 'cpu_picket'],
  astra: ['cpu_generic', 'cpu_swarm', 'cpu_picket'],
  bastion: ['cpu_generic', 'cpu_line', 'cpu_siege'],
  drakeout: ['cpu_generic', 'cpu_swarm', 'cpu_siege'],
};
