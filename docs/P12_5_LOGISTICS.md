# P12.5 — 물류 시스템 통합 및 자동화

> 상태: 구현·검증 기록은 §7–§8. 옵트인(새 개발 월드 전용). 운영 월드·기존 P11/P12 저장에는 적용하지 않는다.

## 1. 조사 결과 (작업 전 코드 기준, 기준 커밋 `0576b85`)

### 1.1 운송 경로는 실제로 셋이다

| 경로 | 위치 | 실행 방식 | 함선 선택 | 비고 |
|---|---|---|---|---|
| `Op.haul` (직접 운송) | `sim.ts` `validateOp case 'haul'`, `behaveHaul`, `haulPick` | 편대 명령. A에서 적재 → B 하역을 **무한 반복** | 명령 받은 편대 전체 | `*auto`(물류센터 필요), `*all`, 단일 품목. 성장 월드 UI에서는 이미 노선 화면으로 우회 |
| `LogisticsRoute` (관리형 노선) | `logistics.ts` (`putRoute`, `stepRouteShip`, `maintainRoutes`) | 편대에 `haul{route}` 명령을 묶음. 함선별 `manifests`(적재 명세)·`cursors` | 노선에 지정된 편대 | transfer/sell/supply/construction, repeat, 공급 재고 기준 |
| `LogisticsJob` (공용 배차) | `autonomousLogistics.ts` (`createPoolJob`, `dispatchPool`, `stepPoolShip`, `maintainPool`) | 작업 1건 = 1척. 예약(reserved) → 적재(carried) → 하역(delivered) | `logisticsPool` 플래그로 **수동 참여 등록**한 유휴 함선 중 가장 가까운 함선 | 정거장 권한·정박 규격·점프 경로(봉쇄 관문 제외)·위험 상한·창고 공간·건설 현장 필요량 처리 |

### 1.2 수요와 목표는 이미 공용 배차를 쓴다

- `procurement.ts` `planProcurement` (10초 주기): 건설 모듈·조선·생산 주문의 부족분을 계산한다.
  - 부족 = 필요 − 사용 − 확보(건설 예약) − 현지 자유 재고 − 다른 운송 도착 예정
  - 자사 자유 재고(보호 재고 제외, 다른 요청이 선점한 몫 제외)를 경로 점수(점프 수·위험) 순으로 고르고 `createPoolJob(…, procurement=planId)`를 호출한다.
  - 자동 구매(`autoBuy:false` 기본, 예산·단가 상한·최소 잔액·위험) 또는 회사 운영 결재 예산(`procurementAuthority`)이 있을 때만 시장에서 산다.
- `operations.ts`: 비축 목표(`runStockpile`), 반복 무역(`runTrade`)은 `poolCreate` 명령으로 `LogisticsJob`을 만들고 진행 상태를 추적한다. 업무 등록부(`works`)는 기존 노선·작업을 "업무"로 채택만 하며 별도 실행기는 없다.
- 채굴 연계: `Op.mine`의 채굴선/수송선이 자체적으로 적재·하역한다(`behaveMine`). 공용 배차와 겹치지 않는다(유휴 명령이 아니므로).

### 1.3 문제점

1. 함선 자격 판정이 네 군데에 중복돼 있다 — `autonomousLogistics.free`, `maintainPool`, `procurement.poolShips`, `operations.poolShips`(+ UI 두 곳). 모두 `logisticsPool` 수동 등록을 전제로 한다. 수송선을 사도 "참여" 버튼을 누르기 전에는 아무 일도 하지 않는다.
2. 수동 명령은 `interruptPoolShips`로 `logisticsPool=false`를 만든다. 즉 한 번 직접 명령을 내리면 그 함선은 **영구히** 배차에서 빠진다. 조달 화물이 실려 있으면 작업이 정지되고 플레이어가 화물을 확인하고 재개해야 한다.
3. 직접 운송(`haul`)과 관리형 노선(`LogisticsRoute`)은 공용 배차와 같은 재고를 놓고 별도 엔진으로 경쟁한다. 상호 인식(`incomingRoutes` ↔ `incomingPool`)은 있으나 실행이 셋이다.
4. 해적이 아닌 적대 PMC에는 민간 편대 위협 회피(`threatCheck`)가 반응하지 않는다(해적만 감지).
5. UI는 노선 생성 폼, 작업 요청 폼(출발지·목적지·품목·수량·반복), 편대별 참여 버튼으로 구성된다. 물류가 플레이어의 주된 일이 된다.

### 1.4 문서와 코드 차이

- `docs/LOGISTICS_AUTOMATION_P2.md`와 `COMPANY_OPERATIONS.md`는 공용 배차를 "명시적 참여" 모델로 기술하며 코드와 일치한다. P12.5 변경 후에도 레거시 월드에서는 그대로 유효하다.
- P12 문서에는 물류 관련 서술이 없다. P12 `return`은 `setOp`를 거치므로 공용 배차 중단 경로(`interruptPoolShips`)를 이미 탄다.

## 2. 유지 / 제거 / 호환

| 대상 | P12.5 월드 (`logisticsV=1`) | 레거시 월드 |
|---|---|---|
| `LogisticsJob` + `dispatchPool`/`stepPoolShip`/`maintainPool` | **유일한 실행 엔진** | 변경 없음 |
| `procurement.ts` | 수요 계산기 (변경: 함선 판정만 공용 함수 사용) | 변경 없음 |
| `operations.ts` 목표 | 상위 목표 (변경: 함선 판정만 공용 함수 사용) | 변경 없음 |
| `logisticsPool` 플래그 | 군함을 명시적으로 허용할 때만 의미 (`opt-in`). 일반 수송선은 등록 불필요 | 기존 의미 그대로 |
| `logisticsExcluded` (신규) | 특정 함선 자동 물류 제외 | 사용 안 함 |
| `Op.haul` 신규 명령 | **거부** — "자동 물류가 처리" 안내 | 변경 없음 |
| 진행 중 `Op.haul` (변환 시) | 화물을 실은 함선은 원래 목적지로 가는 운송 작업으로 변환, 편대는 대기 → 자동 배차 대상 | — |
| `LogisticsRoute` 신규 생성 | **거부** | 변경 없음 |
| 기존 노선 (변환 시) | 아래 §5 표에 따라 변환. 반복 판매·반복 재고 이동은 **호환 모드**(기존 경로로 계속 실행, 일시정지·취소만 가능) | — |
| 채굴 연계 (`Op.mine`) | 그대로 | 그대로 |

## 3. 통합 구조

```
건설 모듈 · 조선 · 생산 주문 · 비축 목표 · 무역 목표   (operations.ts — 목표)
        │
        ▼
procurement.planProcurement  (10초)  — 부족 계산, 출발지 선택, 구매 정책
operations.runStockpile/runTrade     — 목표별 운송 요청
        │  createPoolJob (LogisticsJob, 예약 전)
        ▼
autonomousLogistics.dispatchPool (5초 / 명령 직후) — 가용 수송선 선택, 출발지 재고 예약
        │
        ▼
stepPoolShip (매 전략 틱)  — 출발지 비행·게이트 점프·정박·적재 → 목적지 정박·하역
maintainPool (1초)          — 함선 손실·명령 변경·저장 복원 정합, 보류 작업 재결합
```

새 모듈 `src/world/haulers.ts` 하나가 자격 판정을 소유한다.

- `poolMember(st, s)` — 자동 물류 **구성원** 여부 (회사가 플레이어, 제외 플래그 없음, 화물칸 > 0, 군함은 명시 허용 시만, 채굴선·공작선 제외). 레거시 월드에서는 `!!s.logisticsPool` 그대로.
- `haulerAvailability(h, s)` — 지금 배차 가능한지와 불가 사유(수동 명령 중, 전투 중, 회피 중, 손상, 예비역·매물, 하역 작업 중, 화물칸 가득, 자동 물류 꺼짐 …). UI와 배차가 같은 함수를 쓴다.

## 4. 배차·명령 우선 규칙 (P12.5 월드)

1. **자동 사용**: 플레이어 회사 소유, 화물칸 보유, 비군함, 편대 명령이 `idle`(대기), 건조·매물·예비역·전투·회피 상태가 아니고 선체 내구 40% 이상인 함선은 등록 없이 배차된다.
2. **제외**: `poolShips {on:false}` 명령이 함선에 `logisticsExcluded`를 건다. `{on:true}`는 해제한다. 진행 중 작업은 아래 3과 같이 화물을 보존한 채 보류된다.
3. **직접 명령 우선**: `setOp`(이동·정박·호위·P12 작전·복귀 등), `moveShip`, `setParent`, 매물·예비역 등 기존 명령 우선 목록이 그대로 적용된다. 차이는 다음과 같다.
   - 화물을 싣지 않은 작업 → 예약 반환 후 재대기 (기존과 같음)
   - 화물을 실은 작업 → **보류(held)**: 작업은 `paused`, `held = {ship, …}`, `carried`는 운송 중 물량으로 계속 집계(중복 운송 방지). 남은 미적재 물량은 조달 작업이면 계획기가 다시 요청하고, 직접 요청 작업이면 새 작업으로 분할한다.
   - 함선이 다시 대기 상태가 되면(P12 복귀 완료, 플레이어가 대기 명령) `maintainPool`이 같은 함선에 작업을 **재결합**해 원래 목적지로 계속 운송한다.
   - `logisticsPool`을 끄지 않는다 → 수동 사용 해제 시 다시 자동 대상.
   - 대기(`idle`) 명령 자체는 중단으로 보지 않는다.
4. **추적되지 않는 화물** (취소된 작업 잔여, 변환된 `haul` 화물 등)을 실은 가용 함선은 **보관 작업(stow)** 을 받는다: 화물을 원래 목적지(기록이 있으면) 또는 가장 가까운 자사 정거장 창고에 하역한다. 화물은 생성·소멸되지 않는다.
5. **전체 끄기**: 회사 설정 `autoLogistics:false` → 신규 배차만 멈춘다. 이미 예약·적재된 작업은 끝까지 수행한다.

## 5. 기존 저장 변환 (`enableAutoLogistics`, 멱등)

새 월드 생성 시 자동으로 켜지며 대상이 없다. 기존 저장에는 **자동 적용하지 않는다**. 사본에 대해 검사 스크립트(`scripts/logistics/p125-convert-check.ts`)로만 실행한다.

| 기존 상태 | 변환 |
|---|---|
| `logisticsPool=true` 함선 | 그대로 (P12.5에서 비군함은 무의미, 군함은 명시 허용 유지) |
| 공용 배차 작업 (모든 상태) | 그대로 — 같은 엔진 |
| 노선: 건설 공급 / 생산 공급 | 적재 명세가 남은 함선은 해당 목적지로 가는 작업으로 변환(화물 그대로 추적), 노선 삭제, 편대 `idle` → 수요 기반 조달이 이어받음 (회사 조달 정책이 없으면 기본 정책 생성, 자동 구매 꺼짐) |
| 노선: 재고 이동 (단발) | 적재 명세 → 작업 변환, 남은 1회분은 `transfer` 작업 1건으로 등록, 노선 삭제 |
| 노선: 재고 이동 (반복) / 판매 (단발·반복) | **호환 모드** — 플레이어가 설정한 반복 루프이므로 새 루프로 만들지 않고 기존 경로로 계속 실행. UI에서 일시정지·취소만 가능 |
| `Op.haul` (노선 아님) | 실린 화물은 `op.to`로 가는 작업으로 변환, 편대 `idle` |
| 위치·이동 상태·정거장 재고·예약·회계 기록 | 변경 없음 |

멱등성: `st.logisticsV === 1`이면 아무것도 하지 않는다. 변환 전후 회사별 자산 총량(정거장 재고 + 함선 화물 + 예약 + 건설 예약)과 크레딧·장부가 같아야 한다(검사 스크립트가 확인).

## 6. 결정 보류·한계 (사용자 확인 필요)

- 호환 모드 노선(반복 판매·반복 재고 이동)을 회사 무역 목표로 **자동 변환**하는 것은 가격 조건(최대 매입가·최소 매도가)을 새로 정해야 하므로 보류했다. 현재는 기존 경로로 실행한다.
- 군함을 수송에 쓰는 명시 허용은 서버 명령(`poolShips` + 군함)으로만 가능하며 UI에는 노출하지 않았다.
- 하나의 편대에 여러 수송선이 있으면 각 함선이 서로 다른 작업을 수행할 수 있다. 위협 회피(`threatCheck`)는 편대 단위이므로 한 함선이 위협을 받으면 편대 전체가 대피한다(기존 규칙).
- 운송 한 건은 한 품목이다(기존 공용 배차 모델). 소량 부품(예: 센서 6개)도 수송선 한 척이 따로 운반하므로 화물칸이 덜 찬 채 운항할 수 있다. 여러 품목 합적은 운송 모델 변경이므로 이번 범위에서 하지 않았다.
- 수송선 100척을 한 출발지에 몰면 정박 슬롯이 병목이 되어 처리량이 50척보다 낮아진다. 구 공용 배차도 같은 결과이며(§8 성능) 정거장 정박 규칙 문제라 P12.5에서 바꾸지 않았다.

## 7. 구현 위치

| 파일 | 내용 |
|---|---|
| `src/world/haulers.ts` (신규) | 수송선 자격(`poolMember`)·가용성(`haulerAvailability`, 사유 코드 `excluded·busy·building·listed·reserve·recover·group·manual·flee·battle·cargo_work·damaged·off·full`)을 한 곳에서 판정. 배차·조달·운영·UI가 모두 이 함수만 쓴다 |
| `src/world/autonomousLogistics.ts` | 유일한 운송 실행 엔진. V 월드에서 `free()`가 자동 자격 판정을 쓰고, 직접 명령을 받은 적재 함선은 `hold`(운송 보류, 화물 보존·나머지 분리), 명령이 끝나면 `maintainHeld`가 재연결. 추적되지 않은 화물은 `stowCargo`가 가장 가까운 자사 창고로 하역. `interruptPoolShips`는 V 월드에서 참여 표시를 지우지 않는다 |
| `src/world/procurement.ts` · `operations.ts` | 수요·부족 계산과 회사 목표는 그대로, 함선 후보만 `poolMember`로 교체 |
| `src/world/sim.ts` | `WorldSim.create(seed, { logistics: 'p125' })`, `autoLogistics` 명령, V 월드 `haul` 거부, `setOp idle`은 운송을 끊지 않음, 해적 외 적대 PMC도 수송선 위협 감지(V 월드만), 완료 운송 60초마다 정리(최근 100건) |
| `src/world/logistics.ts` | V 월드에서 새 노선 생성 거부, 기존 반복 노선은 `compat` 표시로 계속 실행 |
| `src/world/logisticsMigrate.ts` (신규) | `enableAutoLogistics` — 멱등 변환(§5) |
| `src/server/core.ts` · `node.ts` · `sync.ts` | `AUTO_LOGISTICS_P125=1`(새 월드 전용), 새 함선 필드는 소유 회사에만 노출 |
| `src/client/strategic/autoLogisticsUi.ts` (신규) · `hud.ts` · `style.css` | 물류 현황 화면: 요약·문제·현재 운송(상세)·부족 자재·수송선(제외/포함, 편대 대기)·호환 노선·고급 설정(접힘). 수동 운송 버튼과 노선 생성 UI는 V 월드에서 숨김 |
| `tests/p125-logistics.test.ts` | 그룹 A–E 23개 |
| `scripts/logistics/*` | 실서버 §19(`p125-server`), 브라우저(`p125-browser.cjs`+`p125-sp-save`), 변환 검사(`p125-convert-check`), 장기(`p125-longrun`), 성능(`p125-perf`) |

켜는 방법(개발 월드 전용): `AUTO_LOGISTICS_P125=1 npm run server` 또는 `WorldSim.create(seed, { logistics: 'p125' })`. 운영 월드와 기존 저장에는 적용되지 않는다. 기존 저장 변환은 `enableAutoLogistics`를 **사본**에 적용하는 검사만 했고 운영 데이터 전환은 하지 않았다.

## 8. 검증 결과

(검증 후 기록)
