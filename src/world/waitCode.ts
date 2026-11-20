// P17.4b (AUD-09): structured wait codes for works.
//
// A waiting work used to carry only a free-text reason, so the player could read why it waited but the UI could not
// tell what kind of block it was, how long it had lasted, or where to go to clear it. Every waiting work now also
// carries a code (derived from the same reason the engine already writes, in one place) and the time the current
// block began; the client turns the code into recovery actions that open the screen where the block is cleared.
// The code is advisory: it never changes how a work runs.

export type WaitCode = 'approval' | 'credits' | 'hauler' | 'route' | 'storage' | 'dock' | 'prereq' | 'market' | 'materials' | 'production' | 'fleet' | 'other';

export const WAIT_NAME: Record<WaitCode, string> = {
  approval: '결재 필요', credits: '자금·예산', hauler: '수송선', route: '경로·위험', storage: '보관 공간', dock: '정박',
  prereq: '선행 조건', market: '시장 가격·재고', materials: '자재 부족', production: '생산·착공', fleet: '함대 편성', other: '기타',
};

/** ordered: the first matching rule wins (an approval wait that mentions credits is an approval wait) */
const RULES: [WaitCode, RegExp][] = [
  ['approval', /결재/],
  ['credits', /자금|잔고|예산|cr 필요|지출 한도/],
  ['hauler', /수송선|배차|배속된 함선|운반선/],
  ['route', /경로|위험|봉쇄|관문|항로/],
  ['storage', /보관 공간|구획|창고|용량|적재 공간/],
  ['dock', /정박/],
  ['prereq', /선행|연구실|연구소/],
  ['market', /시장|호가|매수가|매도|단가|매입|판매/],
  ['materials', /자재|재료|재고|조달|부족/],
  ['production', /생산|착공|건조/],
  ['fleet', /함선|편대|채굴선/],
];

export function waitCode(reason: string): WaitCode {
  for (const [code, re] of RULES) if (re.test(reason)) return code;
  return 'other';
}

/** a recovery action: the client maps `go` onto an existing screen */
export interface WaitAction { label: string; go: 'finance' | 'logistics' | 'stock' | 'market' | 'store' | 'research' | 'industry' | 'build' | 'sale' }

export function waitActions(code: WaitCode, ref: { station?: string; item?: string }): WaitAction[] {
  const st = !!ref.station;
  switch (code) {
    case 'approval': return [{ label: '결재 열기', go: 'finance' }];
    case 'credits': return [{ label: '예산·자동 지출 정책', go: 'finance' }];
    case 'hauler': return [{ label: '물류 관리 — 수송선 참여', go: 'logistics' }];
    case 'route': return [{ label: '위험 허용치 정책', go: 'finance' }, { label: '물류 관리', go: 'logistics' }];
    case 'storage': return st ? [{ label: '정거장 보관함·구획', go: 'store' }] : [{ label: '재고 현황', go: 'stock' }];
    case 'dock': return st ? [{ label: '정거장 열기', go: 'store' }] : [];
    case 'prereq': return [{ label: '연구 현황', go: 'research' }];
    case 'market': return [...(st ? [{ label: '정거장 시장', go: 'market' as const }] : []), ...(ref.item ? [{ label: '판매처 찾기', go: 'sale' as const }] : [])];
    case 'materials': return [{ label: '재고·조달 현황', go: 'stock' }, ...(st ? [{ label: '정거장 시장', go: 'market' as const }] : [])];
    case 'production': return [{ label: '산업 현황', go: 'industry' }];
    case 'fleet': return [{ label: '건설·조선', go: 'build' }];
    default: return [];
  }
}
