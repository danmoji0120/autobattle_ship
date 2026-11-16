export type Voice = 'calm' | 'bold' | 'formal' | 'nervous' | 'cold' | 'savage';
export type Specialty = 'tactics' | 'gunnery' | 'maneuver' | 'defense' | 'none';

export interface CommanderDef {
  id: string;
  name: string;
  rank: string;
  skill: number;       // 0..1 판단력 / 반응 속도 / 표적 선정
  aggression: number;  // 0..1 교전 거리, 후퇴 시점, 돌격 성향
  discipline: number;  // 0..1 명령 준수 vs 독자 판단
  specialty: Specialty;
  voice: Voice;
  color: string;
  bio: string;
  team: 0 | 1;
  /** causality interference (the unique commander BB): may intervene before a result is final */
  causal?: boolean;
  /** B-1 officer effects for this group in battle (resolved and capped by the world when the battle is set up;
   *  replays carry them in the setup, so a replay is the same battle) */
  ofx?: Record<string, number>;
}

export const SPECIALTY_TEXT: Record<Specialty, string> = {
  tactics: '전술 — 빠른 상황 판단, 조율된 협공',
  gunnery: '포술 — 명중률 향상',
  maneuver: '기동 — 속도·선회 향상',
  defense: '방공 — 요격률 향상',
  none: '특기 없음',
};

export const COMMANDERS: CommanderDef[] = [
  { id: 'barros', team: 0, name: '엘레나 바로스', rank: '제독', skill: 0.9, aggression: 0.5, discipline: 0.8, specialty: 'tactics', voice: 'calm', color: '#5fd4ff',
    bio: '냉정한 계산으로 이름난 함대 사령관. 망치와 모루 전술의 대가로, 하위 부대의 타이밍을 맞추는 데 능하다.' },
  { id: 'wolf', team: 0, name: '하인츠 볼프', rank: '대령', skill: 0.78, aggression: 0.35, discipline: 0.9, specialty: 'gunnery', voice: 'formal', color: '#9fb8ff',
    bio: '전함 함장 출신의 노장. 적정 교전 거리를 지키며 집중 포격으로 하나씩 무너뜨린다.' },
  { id: 'kairen', team: 0, name: '카이 렌', rank: '중령', skill: 0.82, aggression: 0.9, discipline: 0.4, specialty: 'maneuver', voice: 'bold', color: '#ffb35f',
    bio: '초계함대의 에이스. 적의 빈틈을 귀신같이 찾아내지만, 명령보다 자신의 감을 믿는다.' },
  { id: 'song', team: 0, name: '미라 송', rank: '소령', skill: 0.72, aggression: 0.2, discipline: 0.88, specialty: 'defense', voice: 'calm', color: '#7dffb0',
    bio: '방공 전문가. 호위 대상과 위협 사이에 정확히 함선을 배치한다.' },
  { id: 'mizuki', team: 0, name: '아야 미즈키', rank: '소령', skill: 0.64, aggression: 0.5, discipline: 0.7, specialty: 'gunnery', voice: 'formal', color: '#d79fff',
    bio: '미사일 화력 통제 장교 출신. 표적 분배가 정확하다.' },
  { id: 'kostov', team: 0, name: '이반 코스토프', rank: '중령', skill: 0.55, aggression: 1.0, discipline: 0.25, specialty: 'maneuver', voice: 'savage', color: '#ff6f6f',
    bio: '무모하지만 결정적인 순간 무언가를 해내는 돌격광. 후퇴라는 단어를 싫어한다.' },
  { id: 'gray', team: 0, name: '토마스 그레이', rank: '대위', skill: 0.32, aggression: 0.7, discipline: 0.5, specialty: 'none', voice: 'nervous', color: '#c8c8c8',
    bio: '사관학교를 갓 졸업한 신참. 의욕은 넘치지만 판단이 느리고 자주 표적을 놓친다.' },
  { id: 'bell', team: 0, name: '오도 벨', rank: '대위', skill: 0.5, aggression: 0.12, discipline: 0.85, specialty: 'defense', voice: 'nervous', color: '#ffe27a',
    bio: '신중함이 지나친 함장. 함선을 잃지는 않지만 결정타를 넣는 일도 드물다.' },

  // Hegemony
  { id: 'krause', team: 1, name: '발렌 크로스', rank: '대제독', skill: 0.66, aggression: 0.72, discipline: 0.8, specialty: 'tactics', voice: 'cold', color: '#ff5050',
    bio: '헤게모니 제2함대 사령관. 물량으로 밀어붙이는 정공법을 선호한다.' },
  { id: 'vorn', team: 1, name: '드라크 보른', rank: '준장', skill: 0.58, aggression: 0.6, discipline: 0.9, specialty: 'gunnery', voice: 'cold', color: '#ff7a50',
    bio: '전열 지휘관. 정면 포격전에 강하지만 측면 위협에 둔감하다.' },
  { id: 'ilsa', team: 1, name: '일사 마르', rank: '대령', skill: 0.62, aggression: 0.45, discipline: 0.85, specialty: 'gunnery', voice: 'cold', color: '#ff9a7a',
    bio: '미사일 전대장. 일제 사격 타이밍을 잰다.' },
  { id: 'rask', team: 1, name: '라스크', rank: '중령', skill: 0.5, aggression: 0.95, discipline: 0.5, specialty: 'maneuver', voice: 'savage', color: '#ffa040',
    bio: '습격대장. 사냥감을 발견하면 물불을 가리지 않는다.' },
  { id: 'hesk', team: 1, name: '헤스크 노바크', rank: '소령', skill: 0.45, aggression: 0.4, discipline: 0.8, specialty: 'defense', voice: 'formal', color: '#ff8080',
    bio: '호위전대장. 규정대로 움직이는 평범한 장교.' },
  { id: 'orsk', team: 1, name: '오르스크', rank: '준장', skill: 0.7, aggression: 0.25, discipline: 0.95, specialty: 'defense', voice: 'cold', color: '#ff6060',
    bio: '아르고스 요새선 방어 지휘관. 진지를 절대 비우지 않는다.' },
  { id: 'zeta', team: 1, name: '제타 칼리스', rank: '대령', skill: 0.68, aggression: 0.85, discipline: 0.6, specialty: 'maneuver', voice: 'savage', color: '#ff4070',
    bio: '"늑대 무리"의 우두머리. 초계함 떼로 적을 물어뜯는다.' },
];

export const ACTING_CAPTAIN: CommanderDef = {
  id: 'acting', team: 0, name: '선임 함장', rank: '', skill: 0.4, aggression: 0.5, discipline: 0.75, specialty: 'none', voice: 'formal', color: '#8a9aa8',
  bio: '지휘관이 배정되지 않은 부대. 선임 함장이 임시로 지휘한다.',
};

export function getCommander(id: string | undefined | null): CommanderDef | null {
  if (!id) return null;
  return COMMANDERS.find(c => c.id === id) ?? null;
}
