# BB-EX — ANGEL DESCENT (계정 전용 실험함)

> 브랜치 `feature/bb-ex-angel-descent`. 운영(`deploy/production`)에는 병합·배포하지 않았다.
> 코드와 이 문서가 다르면 코드가 맞다.

## 1. 구성

| 층 | 파일 | 내용 |
|---|---|---|
| 전투 데이터 | `src/sim/bbex/data.ts` | 함급(`bbex`, 열거 불가 등록), 전용 무장 7종, 45개 장착점 배치, 조정 상수 `BBEX` |
| 전투 시스템 | `src/sim/bbex/system.ts`, `state.ts` | 퍼널 12기, DCP-Ω 프랙탈 미러, PARADOX, BLACKOUT, GRAVITY WELL, PHANTOM SHIFT, REGENESIS, 인과율 간섭, GAME OVER |
| 엔진 훅 | `src/sim/world.ts` | BB-EX가 없는 전투에서는 실행되지 않음(기존 전투 다이제스트 동일) |
| 콘텐츠 | `src/content/packs/bbex/` | 선체·변형·프리셋 + `exclusive` 무장 6 · 내부 모듈 8 (설계도·레시피·연구·판매·건조 없음) |
| 소유권 | `src/world/exclusive.ts`, `src/server/core.ts` | 계정 UUID 귀속 원장, 멱등 지급, 변조 복구, 격침 시 복구 대기 |
| 렌더링 | `src/render/bbex/` | 선체·포탑(`hull.ts`), 셰이더(`materials.ts`), 이펙트(`fx.ts`) |
| 검증 | `scripts/bbex-trials.ts`, `scripts/bbex-browser.mjs`, `tests/bbex-*.test.ts` | 실전 시험, 실제 브라우저 촬영, 자동 테스트 |

무장: DCP-Ω 1 · ABYSS-LANCE 4 · VIOLET EDGE 8 · LILAC STINGER 8 · SERAPH-EX 8 · PURPLE RAIN 16 = 45 장착점, FNL-EX 퍼널 12기.

## 2. 소유권 (운영자 설정 필요)

- 서버 환경변수 **`SIDERARIUM_BB_OWNER_ACCOUNT`** = 소유 계정의 UUID(`accounts.id`). 미설정이거나 UUID 형식이 아니면 **아무에게도 지급하지 않는다**.
- 그 계정의 PMC가 있으면 서버 시작·PMC 생성·접속 시 지급한다. 여러 번 호출해도 지휘관 BB 1명, BB-EX 1척(고정 id `x_bb`, `x_bbex`)뿐이다.
- 원장(`WorldState.exclusive`)은 클라이언트에 전송하지 않는다. 한 번 귀속된 계정은 설정을 바꿔도 이전되지 않는다(`bound-elsewhere`).
- 서버가 거부하는 것: 건조·구매·매물 등록·인수·해임·고용·피팅 변경·전용 장비의 생산/거래/타 함선 장착. 저장 데이터에 복제본·타 소유·낱개 전용 장비가 있으면 불러올 때와 매초 제거한다.
- 격침: 삭제·잔해·설계 조각 없음. 모항에서 30분 복구 대기(`recover`), BB는 10분 전투 불능. 같은 함선이 돌아온다.

## 3. 실전 검증 (`npx vite-node scripts/bbex-trials.ts`, 시드 1·2·3, 결과 `artifacts/bbex/trials.json`)

상대는 기존 함급·기존 로드아웃·기존 지휘관 AI 그대로다. 33전 33승.

| 시험 | 교전 시간(초) | 비고 |
|---|---|---|
| 전함 50척 | 102~104 | 목표 2~3분 대비 빠름 |
| 전함 100척 | 126~160 | 목표 약 5분 이내 |
| 혼성 결전함대 200척 | 134~140 | 선체 최저 100% |
| 미사일 포화 130척 | 93~96 | |
| 고속 소형함 160척 | 67~77 | |
| 강화 방공망 120척 | 94~102 | 퍼널 손실 27기(재구성) |
| 퍼널 4기·재구성 불가 vs 200척 | 200~202 | |
| DCP-Ω 비활성 vs 200척 | 279~328 | PARADOX 과부하 최대 4회, 선체 최저 85% |
| PARADOX 과부하 시작 vs 200척 | 176~183 | 결전 프로토콜 차단 |
| 결전 프로토콜 즉시 vs 200척 | 126~127 | |
| BB 미탑승 vs 200척 | 166~171 | |

시뮬레이션 비용: 200척 전투 평균 2.4~3.0 ms/틱(30Hz), 최대 34 ms.

## 4. 화면 검증

`npm run dev` 후 개발 빌드에서만 열리는 진입점: `?bbex=descent`(ANGEL DESCENT), `?bbex=<시험 id>`.
`node scripts/bbex-browser.mjs "<query>" <out> '<steps>'`로 헤드리스 Chromium(SwiftShader)에서 촬영한다. 결과는 `artifacts/bbex/descent-*.png`.

## 5. 조정

모든 수치는 `src/sim/bbex/data.ts`의 `BBEX`와 무장 정의에 있다. 값을 바꾸면 `scripts/bbex-trials.ts`로 다시 측정한다.
