import type { FleetSpec, GroupSpec, ShipSpec } from '../fleet';

export interface ScenarioDef {
  id: string;
  name: string;
  subtitle: string;
  brief: string;
  tip: string;
  enemy: FleetSpec;
  difficulty: number; // 1..3
  backdrop: { planet: string; nebula: [string, string]; sun: string };
}

const S = (classId: string, loadoutId: string, n = 1): ShipSpec[] => Array.from({ length: n }, () => ({ classId, loadoutId }));
const G = (name: string, commanderId: string | null, order: GroupSpec['order'], ships: ShipSpec[], children: GroupSpec[] = [], retreatAt = 0): GroupSpec =>
  ({ name, commanderId, order, ships, children, retreatAt });

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'kestrel', name: '케스트렐 성운 조우전', subtitle: '정면 대결', difficulty: 1,
    brief: '헤게모니 제2함대가 성운을 가로질러 진격 중이다. 수적으로는 열세지만, 우리 지휘관들이 더 노련하다. 적 전열을 고정하고 측면을 무너뜨려라.',
    tip: '적 전함의 정면 장갑은 두껍다. 뇌격 편대를 측면으로 우회시키고, 주력이 적을 붙잡아 두게 하라.',
    backdrop: { planet: '#c27a4a', nebula: ['#3a1f5c', '#0e3a5a'], sun: '#ffd9a8' },
    enemy: {
      name: '헤게모니 제2함대',
      root: G('제2함대 본대', 'krause', 'engage', [], [
        G('중앙 전열', 'vorn', 'auto', [...S('battleship', 'std', 2), ...S('cruiser', 'multi', 2)], [], 0.2),
        G('미사일 전대', 'ilsa', 'auto', S('cruiser', 'missile', 2), [], 0.3),
        G('호위대', 'hesk', 'auto', S('destroyer', 'aa', 3), [], 0.25),
        G('습격대', 'rask', 'auto', [...S('corvette', 'torp', 4), ...S('corvette', 'gun', 2)], [], 0),
      ]),
    },
  },
  {
    id: 'bastion', name: '아르고스 요새선 돌파', subtitle: '방어선 공략', difficulty: 2,
    brief: '아르고스 관문을 지키는 헤게모니 요새 함대. 전함 4척이 진지를 사수하며 접근하는 모든 것을 포격한다. 정면 돌격은 자살이다.',
    tip: '요새형 전함은 느리다. 넓게 우회하는 부대로 진형을 흔들고, 레일건으로 장거리에서 압박하라.',
    backdrop: { planet: '#5a8ac2', nebula: ['#0d2a4a', '#2a1240'], sun: '#bfe0ff' },
    enemy: {
      name: '아르고스 방위함대',
      root: G('요새 함대', 'orsk', 'hold', [], [
        G('제1 포열', 'vorn', 'hold', [...S('battleship', 'fortress', 1), ...S('battleship', 'std', 1)], [], 0),
        G('제2 포열', 'ilsa', 'hold', [...S('battleship', 'std', 1), ...S('battleship', 'fortress', 1)], [], 0),
        G('방공 전대', 'hesk', 'auto', S('destroyer', 'aa', 4), [], 0.2),
        G('경계대', 'rask', 'engage', S('corvette', 'gun', 4), [], 0.3),
      ]),
    },
  },
  {
    id: 'wolfpack', name: '늑대 무리', subtitle: '고속 습격 방어', difficulty: 2,
    brief: '제타 칼리스의 초계함 떼가 우리 함대를 노린다. 수많은 어뢰정이 사방에서 파고들 것이다. 거함을 지켜라.',
    tip: '호위 구축함의 방공포가 생명줄이다. 주력함 곁에 붙여 두고, 강습 초계함으로 적 어뢰정을 사냥하라.',
    backdrop: { planet: '#8ac27a', nebula: ['#3a0f1f', '#1a2a50'], sun: '#ffc0a0' },
    enemy: {
      name: '늑대 무리',
      root: G('늑대 무리', 'zeta', 'engage', [], [
        G('송곳니 편대', 'rask', 'flank_left', S('corvette', 'torp', 6), [], 0),
        G('발톱 편대', null, 'flank_right', [...S('corvette', 'torp', 5), ...S('corvette', 'gun', 1)], [], 0),
        G('그림자 편대', 'vorn', 'auto', S('corvette', 'torp', 5), [], 0),
        G('사냥개 편대', 'hesk', 'auto', S('corvette', 'gun', 5), [], 0.3),
        G('모함 전대', 'ilsa', 'auto', [...S('cruiser', 'missile', 2), ...S('cruiser', 'gun', 1), ...S('destroyer', 'strike', 2)], [], 0.3),
      ]),
    },
  },
];

export function getScenario(id: string): ScenarioDef {
  return SCENARIOS.find(s => s.id === id) ?? SCENARIOS[0];
}
