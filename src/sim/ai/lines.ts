import type { Voice } from '../data/commanders';
import type { Rng } from '../rng';

type LineSet = Partial<Record<Voice, string[]>> & { default: string[] };

// {t}=target, {g}=group, {s}=ship, {n}=number
export const LINES: Record<string, LineSet> = {
  ack_engage: {
    default: ['알겠습니다. 자유 교전으로 전환합니다.', '자유 교전, 표적은 제 판단으로 고르겠습니다.'],
    bold: ['좋아, 마음대로 놀아도 된다는 거지!', '자유 교전? 기다리던 말이다!'],
    nervous: ['자, 자유 교전... 알겠습니다!'],
    savage: ['드디어! 전부 쓸어버린다!'],
    calm: ['자유 교전. 상황을 보며 움직이겠습니다.'],
    cold: ['자유 교전. 전부 제거한다.'],
  },
  ack_attack: {
    default: ['{t}, 표적 확인. 공격합니다.', '{t}에 화력 집중합니다.'],
    bold: ['{t}? 금방 끝내주지.', '{t} 사냥 개시!'],
    nervous: ['{t}... 표적 확인했습니다! 갑니다!'],
    savage: ['{t}! 박살 내주마!'],
    calm: ['{t}. 차분히 무너뜨리겠습니다.'],
    cold: ['{t}. 처리한다.'],
  },
  ack_flank: {
    default: ['{t} 측면으로 우회합니다.', '측면 기동 개시. {t}의 옆구리를 칩니다.'],
    bold: ['옆구리를 찌르는 건 내 전문이지.', '측면? 이미 가는 중이다!'],
    nervous: ['우, 우회 기동... 경로 계산 중입니다!'],
    savage: ['뒤로 돌아가서 목을 따주지!'],
    calm: ['넓게 돌아 들어가겠습니다. 신호를 기다리죠.'],
    cold: ['우회한다.'],
  },
  ack_escort: {
    default: ['{t} 호위 위치로 이동합니다.', '{t} 곁에 붙겠습니다.'],
    bold: ['보모 역할이라... 알겠다.'],
    nervous: ['{t} 호위, 알겠습니다! 가까이 붙겠습니다.'],
    savage: ['지키는 건 지루하지만... 다가오는 놈은 다 찢어주지.'],
    calm: ['{t} 방공 엄호 들어갑니다. 아무것도 통과 못 합니다.'],
    cold: ['{t} 호위.'],
  },
  ack_move: {
    default: ['지정 좌표로 이동합니다.'],
    bold: ['거기로? 좋아.'],
    nervous: ['이동합니다! 좌표 확인!'],
    calm: ['이동합니다.'],
    cold: ['이동.'],
  },
  ack_hold: {
    default: ['현 위치 사수합니다.', '진지를 지킵니다.'],
    bold: ['가만히 있으라니, 몸이 근질거리는데.'],
    savage: ['기다리라고? ...좋아, 잠깐만이다.'],
    nervous: ['여기서 버티겠습니다!'],
    cold: ['위치 사수.'],
  },
  ack_reserve: {
    default: ['예비대로 대기합니다. 신호를 주십시오.'],
    bold: ['대기라... 결정적인 순간에 불러줘.'],
    cold: ['대기.'],
  },
  ack_retreat: {
    default: ['후퇴합니다! 전 함 전속 이탈!', '명령 수신, 철수합니다.'],
    bold: ['쳇, 다음엔 끝을 보자고.'],
    savage: ['후퇴라고?! ...젠장, 알았다!'],
    nervous: ['후퇴! 후퇴합니다!'],
    calm: ['질서 있게 이탈합니다.'],
    cold: ['철수.'],
  },
  ack_release: {
    default: ['지휘권 인수. 제 판단으로 움직이겠습니다.'],
    bold: ['이제야 내 방식대로 하는군.'],
    nervous: ['제, 제가 판단하라고요? 알겠습니다!'],
    calm: ['위임 확인. 맡겨 주십시오.'],
    cold: ['지휘권 인수.'],
  },
  reluctant: {
    default: ['...명령이라면 따르겠습니다.'],
    bold: ['내 생각은 다르지만, 알겠다.'],
    savage: ['마음에 안 들어. 그래도 한다.'],
  },
  engage_start: {
    default: ['적 함대 사거리 진입. 교전 개시!', '사격 개시!'],
    bold: ['파티 시작이다!', '놈들이 사정권에 들어왔다. 가자!'],
    nervous: ['저, 적이 사거리 안에 들어왔습니다! 사격 개시!'],
    savage: ['찢어발겨라!!'],
    calm: ['교전 개시. 침착하게.'],
    cold: ['사격 개시.'],
  },
  kill: {
    default: ['{t} 격침 확인!', '{t} 격파!'],
    bold: ['{t} 격침! 다음 놈!', '하나 해치웠다! {t}!'],
    nervous: ['{t}, 격, 격침했습니다! 해냈어요!'],
    savage: ['{t}! 산산조각이다! 하하하!'],
    calm: ['{t} 격침. 다음 표적으로.'],
    cold: ['{t} 제거.'],
  },
  kill_big: {
    default: ['적 {t} 격침! 적의 대형함이 무너졌다!'],
    bold: ['거함 {t}이(가) 침몰한다! 봤냐!'],
    nervous: ['저, 적 대형함 {t}... 격침입니다!!'],
    savage: ['{t}의 숨통을 끊었다!!'],
    calm: ['{t} 격침. 전황이 기울고 있습니다.'],
    cold: ['{t} 격침. 계속하라.'],
  },
  lost: {
    default: ['{s} 격침당했다!', '{s}와(과) 연락 두절!'],
    bold: ['{s}가 당했어! 젠장!'],
    nervous: ['{s}가... {s}가 폭발했습니다!'],
    savage: ['{s}!! 갚아주마!'],
    calm: ['{s} 상실. 진형 재정비.'],
    cold: ['{s} 손실.'],
  },
  heavy_damage: {
    default: ['피해가 심각하다! 전력 절반 이하!'],
    bold: ['꽤 아프군... 아직 끝나지 않았다.'],
    nervous: ['피해가 너무 큽니다! 지원 요청!'],
    savage: ['피 좀 흘린다고 멈출 줄 알고!'],
    calm: ['손실이 큽니다. 신중히 운용하겠습니다.'],
    cold: ['손실 과다.'],
  },
  retreat_auto: {
    default: ['한계다! 후퇴 기준 도달, 이탈한다!'],
    bold: ['여기까지다, 빠진다!'],
    nervous: ['더는 무리입니다! 후퇴합니다!'],
    calm: ['후퇴 기준 도달. 생존 함 이탈합니다.'],
    cold: ['후퇴한다.'],
  },
  flank_ready: {
    default: ['우회 위치 도달. 공격 신호 대기 중.'],
    bold: ['자리 잡았다. 신호만 줘.'],
    nervous: ['대기 위치입니다... 아직인가요?'],
    calm: ['배치 완료. 모루가 고정되면 들어갑니다.'],
    cold: ['위치 확보. 대기.'],
  },
  hammer: {
    default: ['지금이다! 측면 돌입!'],
    bold: ['모루가 놈들을 붙잡았다. 망치, 내려친다!', '놈들 옆구리가 텅 비었다, 들어간다!'],
    nervous: ['돌, 돌입합니다!'],
    savage: ['뒤통수를 갈긴다!!'],
    calm: ['적 전열 고정 확인. 망치 투입.'],
    cold: ['측면 타격 개시.'],
  },
  signal_hammer: {
    default: ['{g}, 적이 묶였다. 지금 쳐라!'],
    calm: ['모루가 고정됐다. {g}, 지금이다.'],
    cold: ['{g}, 공격.'],
  },
  finish: {
    default: ['{t} 대파 확인. 마무리한다!'],
    bold: ['{t} 다 죽어간다, 끝내자!'],
    calm: ['{t}에 결정타를. 화력 전환.'],
    cold: ['{t}부터 정리한다.'],
    savage: ['비틀거리는 {t}! 숨통을 끊어라!'],
  },
  missile_alert: {
    default: ['미사일 다수 접근! 방공 사격!'],
    calm: ['대규모 미사일 접근. 방공망 집중. 하나도 통과시키지 마.'],
    nervous: ['미, 미사일이 엄청 옵니다!'],
    cold: ['미사일 접근. 요격.'],
  },
  torpedo_alert: {
    default: ['어뢰 접근! 요격하라!'],
    calm: ['어뢰 접근 중. 요격 우선.'],
    nervous: ['어뢰다! 어뢰가 옵니다!!'],
    cold: ['어뢰. 요격.'],
  },
  kite: {
    default: ['포화가 너무 강하다. 거리를 벌린다.'],
    calm: ['불리한 거리입니다. 후퇴 기동하며 사격하겠습니다.'],
    formal: ['교전 거리 재조정. 후진하며 응사합니다.'],
    cold: ['거리 확보.'],
  },
  charge: {
    default: ['전진! 거리를 좁혀라!'],
    bold: ['정면으로 들이받는다!'],
    savage: ['돌격! 돌격!! 놈들 코앞까지!'],
    nervous: ['저, 전진합니다! ...너무 가까운가?'],
  },
  confused: {
    default: ['명령 확인 중... 일단 가장 가까운 적을 상대한다.'],
    nervous: ['어, 어느 쪽 측면이요? 일단 가까운 놈부터!', '죄송합니다, 경로를 잃었습니다! 정면으로 갑니다!'],
  },
  enemy_flank: {
    default: ['적 고속정이 우리 측면으로 돌아온다! 주의!'],
    calm: ['적 습격대의 우회 기동 포착. 대비하십시오.'],
    nervous: ['옆에서! 옆에서 적이 옵니다!'],
    cold: ['측면 위협 포착.'],
  },
  assign_anvil: {
    default: ['{g}, {t}을(를) 정면에서 붙잡아라.'],
    calm: ['{g}, {t}을(를) 정면에서 고정하세요. 모루 역할입니다.'],
    cold: ['{g}, {t} 정면 압박.'],
  },
  assign_hammer: {
    default: ['{g}, {t} 측면으로 우회하라.'],
    calm: ['{g}, 넓게 돌아 {t}의 측면을 노리세요. 신호를 기다리세요.'],
    cold: ['{g}, {t} 측면 우회.'],
  },
  target_switch: {
    default: ['전 부대, 주 표적을 {t}(으)로 변경한다.'],
    calm: ['표적 변경. {t}이(가) 더 위협적입니다.'],
    cold: ['주 표적 {t}.'],
  },
  rout_enemy: {
    default: ['적이 퇴각한다! 추격하라!'],
    calm: ['적 함대 붕괴. 승기를 잡았습니다.'],
    bold: ['놈들이 꽁무니를 뺀다!'],
    cold: ['적 붕괴. 추격.'],
  },
  rout_self: {
    default: ['전 함대 퇴각! 전장을 이탈하라!'],
    calm: ['더 이상의 손실은 무의미합니다. 전 함대, 철수.'],
    cold: ['전 함대 철수.'],
  },
  winchester: {
    default: ['미사일 탄약 소진! 포격전으로 전환한다.'],
    calm: ['발사관 전탄 소진. 부포로 교전 거리를 좁힙니다.'],
    nervous: ['미사일이... 다 떨어졌습니다! 접근합니다!'],
    cold: ['미사일 소진. 포격전.'],
    formal: ['{s}, 미사일 전탄 소진. 근접 포격으로 전환합니다.'],
  },
  crit_engine: { default: ['{s}: 기관부 피격! 속도 저하!'] },
  crit_fire: { default: ['{s}: 함내 화재 발생! 진화 중!'] },
  crit_weapon: { default: ['{s}: 포탑 피격, 사격 불능!'] },
  crit_bridge: { default: ['{s}: 함교 피격! 지휘 혼란!'] },
  magazine: { default: ['{t}의 탄약고가 유폭했다!!'] },
  escort_save: {
    default: ['요격 {n}발째! 방공망 건재!'],
    calm: ['누적 요격 {n}발. 주력함 무사합니다.'],
  },
  victory: {
    default: ['전장 확보. 우리의 승리다.'],
    calm: ['작전 종료. 모두 잘 싸웠습니다.'],
    cold: ['전투 종료.'],
  },
};

export function line(key: string, voice: Voice, rng: Rng, params: Record<string, string | number> = {}): string {
  const set = LINES[key];
  if (!set) return key;
  const arr = set[voice] ?? set.default;
  let s = rng.pick(arr);
  for (const k of Object.keys(params)) s = s.split(`{${k}}`).join(String(params[k]));
  return s;
}
