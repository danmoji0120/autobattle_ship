# P16.2 함재기·항모 콘텐츠와 피팅 체계

상태: **구현·검증 완료 (기준 `2115e3c`)**. 설계는 `docs/P16_0_FIGHTERS_CARRIERS.md`, 전투 엔진 시제품은 `docs/P16_1_CRAFT_ENGINE.md`를 따른다.

범위는 다음과 같다.
- H 하드포인트와 `flight` 베이
- 항모 선체 1종, 함재기 무장 3종, 항공 모듈 3종
- 생산·설계도 데이터
- 장착 규칙
- 무장 `kind` 분기 점검

다음은 이번 범위에서 **제외**했다.
- 항모 전용 AI
- 최종 밸런스
- 렌더링(항모 모델·함재기 표시)
- 항공 모듈 효과의 전투 연결
- 장교 효과 분리
- 기본 `BATTLE_RULES` 변경
- 운영 배포·마이그레이션

## 1. 추가한 콘텐츠 (`src/content/packs/growth/carrier.ts`, ARSENAL 팩 뒤에 덧붙임)

| 구분 | id | 요지 |
|---|---|---|
| 함재기 무장 | `eq_wing_fighter` 전투기 비행대 | 8기(예비 4), 반경 1800, 기관포. 연구 `combined_arms` |
| | `eq_wing_torpedo` 뇌격기 비행대 | 6기(예비 3), 출격마다 `air_torpedo` 1발. 연구 `torpedo_casting` |
| | `eq_wing_interceptor` 요격기 비행대 | 8기(예비 4), 반경 1200, 비행체·유도탄 우선. 연구 `pd_network` |
| 항공 모듈 (`flight`, M) | `air_hangar_ext` 격납고 확장 | `complement +2`. machine_shop, `modular_assembly` |
| | `air_control` 항공 관제 | `control +1`. electronics_fab, `long_sensors` |
| | `air_maint` 정비 설비 | `turnaround ×0.75`, `spares ×1.25`. machine_shop, `damage_control` |
| 선체 | `carrier_dawn` 여명급 (함급 `carrier`) | 3티어 L, 동력 52, 질량 170 |
| 변형·프리셋 | `carrier_dawn_std`, `dawn_air_group` | 전투기 2 + 뇌격기 1 + 요격기 1, 부포 2, 방공 6 |
| 설계도 | `bp_carrier_dawn` (rare) | 헬리오스·바스티온 상업 판매 16만, 평판 35, 계약 6. 요구 연구 `capital_hulls`, `combined_arms` |

**함재기 무장 공통**
- 계열 `craft`, 크기 L, 마운트 `deck`만, 소모품 chemicals 0.8
- 생산: `weapons_factory` 레시피
- 수치는 P16.1 시제품 측정값과 같다.
- 전투 행의 `range`·`reload`·`speed`는 작전 반경·재출격 시간·속도를 그대로 쓴다.
- `salvo`는 0이다. 함재기 무장은 함선에서 직접 발사하지 않는다.

**여명급 선체**
- 하드포인트: H 4(L, `hangar`/`deck`), 부포 M 2, 방공 S 6
- 내부 베이: `flight` M 3, 센서 S 1, 범용 M 1, 전투 컴퓨터 1(레지스트리가 자동 추가)
- 건조: 조선소 규모 3, 크레딧 14000, 연구 2종, 시설 `electronics_fab`, 부품
- 유지비: 2600
- 전투 함급 `SHIP_CLASSES.carrier`: 체력 8200, 장갑 46/36/22, 최고속 34
  - 기본 무장 `air_group`은 하드포인트 순서를 그대로 따른다(테스트로 일치 확인).

**새 연구는 추가하지 않았다.** 기존 연구를 재사용해 월드 생성과 연구 트리를 바꾸지 않았다. 부수 효과가 하나 있다: `combined_arms`, `modular_assembly`, `damage_control` 연구로 플레이어가 역설계할 때(`research.salvageItem`) 찾을 수 있는 품목에 새 장비가 포함된다.

## 2. 장착 규칙 — 함급 이름이 아니라 하드포인트 타입·무장 kind로 판정

`src/content/rules.ts`에 규칙을 두었다. 서버 피팅 명령, 피팅 화면 미리보기, 검증기가 같은 규칙을 공유한다.

**H 하드포인트 (`hpAccepts`)**
- `weaponType`: `kind === 'craft'`이면 `hp` 값과 무관하게 `'hangar'`로 판정한다.
- `hp.type === 'hangar'`인데 무장이 함재기가 아니면 → "격납(H) 하드포인트에는 함재기 무장만"
- 함재기 무장인데 하드포인트가 `hangar`가 아니면 → "함재기 무장은 격납(H) 하드포인트에만 장착"
  - 범용·미사일 하드포인트도 함재기를 받지 않는다.
- 두 검사는 크기 검사보다 **먼저** 한다. 그래야 실제 사유가 표시된다. 허용·거부 결과 자체는 순서와 무관하다.
- 비-H 하드포인트 × 비-함재기 무장의 모든 조합(>1000건)에서 기존 함수와 결과가 같은지 테스트로 확인했다.

**`flight` 베이 (`bayAccepts`)**
- `slot 'flight'` 모듈은 `flight` 베이에만 들어간다. 범용(`special`) 베이도 받지 않는다.
- `flight` 베이는 항공 모듈만 받는다.
- 산업·전투 컴퓨터 베이의 기존 규칙과 같은 방식이다.

**검증기 (`validate.ts`, `validateArsenal.ts`)**
- `hangar` 타입 ⇔ `deck` 마운트
- 항공 모듈: `air` 값 범위 검사, `fx`는 비어 있어야 하며 id 접두어 `air_`
- 함재기 무장 검사:
  - 마운트는 `['deck']`, 크기 L, `salvo 0`
  - range/reload/speed가 craft 수치와 같아야 한다.
  - `ordnance`는 미사일 또는 어뢰여야 한다.
- 함재기 전력 지수 `craftScore` 예산: L 100. ×1.25를 넘으면 경고, ×1.6을 넘으면 오류.
  - 현재 값은 73~95이다.
- 함재기는 일반 무장 점수(armScore)와 티어 우열 검사에서 빠진다.

## 3. 공개 게이트: `HullDef.preview` (설계 결정 — 보고 사항)

함재기는 규칙 3 이상에서만 출격한다. 기본 규칙은 아직 2이므로, 그대로 팔면 **H 슬롯이 아무것도 하지 않는 항모**를 사게 된다. 그래서 여명급은 데이터를 모두 갖춘 상태로 두되, 월드에서 얻을 수 없게 막았다.

| 경로 | 처리 |
|---|---|
| 구매·건조 (`sim.ts hullChoice`) | "아직 공개되지 않은 선체 — 구매·건조할 수 없음"으로 거부. `sale`이 없으므로 시장 재고도 없다 |
| 설계도 판매 (`offersAt`) | 제공 목록에서 제외. `buyBlueprint` 거부 |
| 설계도 지급 (`grantBlueprint`) | 거부. 단 `src === 'migration'`은 허용 |
| 무작위 보상 | 검증기가 미공개 선체 설계도의 출처를 정거장 기반으로만 허용한다. 계약·탐사·인양 보상 추첨에 들어가지 않으므로 월드 RNG 소비도 바뀌지 않는다 |
| UI 선체 목록 (`growthUi`, `operationsUi`) | `hullReleased()`로 제외 |
| 실험실 (`labModel`) | `availableHulls`·`defaultShip`에서 제외 |
| 전투 함급 | `SHIP_CLASSES.carrier`를 BB-EX처럼 열거되지 않는 속성으로 등록. 스커미시 목록·구형 검증 루프에 나타나지 않는다 |

함재기 무장과 항공 모듈은 일반 장비처럼 레시피로 생산할 수 있다. 다만 장착할 H 슬롯·`flight` 베이를 가진 공개 선체가 없다.

**사용자 결정이 필요한 사항 (보류)**
1. **공개 시점.** `preview`를 지우면 공개된다. 제안은 "기본 규칙을 3으로 올리는 단계(P16.4 또는 P16.5)에서 함께 해제"이다.
2. **공개 전 노출 여부.** 대안 A: 실험실·스커미시에만 먼저 노출해 규칙 3 전투를 시험할 수 있게 한다(P16.4 예정). 대안 B: 지금처럼 완전히 숨긴다(현재 구현).
3. **수치.** 설계도 가격·평판, 건조비·유지비는 잠정값이다. 최종 밸런스는 범위 밖이다.

## 4. 무장 `kind` 분기 전수 점검

함재기 마운트(`kind 'craft'`, `salvo 0`)는 함포가 아니다. 다음 원칙으로 점검했다.
- 포격 사거리·일반 DPS·미사일 수 계산에는 넣지 않는다.
- 비행체 풀(P16.1)만 이 마운트를 읽는다.

판단 보조 함수: `weapons.ts`의 `isCraft(w)`, `isShipGun(w)`(pd·craft 제외), `craftSummary(w)`.

| 위치 | 결과 | 처리 |
|---|---|---|
| `client/strategic/fittingUi.ts` | **수정** | 합계 DPS·최대 사거리·미사일 수에서 함재기 제외. 항목 줄은 `craftSummary` |
| `devlab/labFitting.ts` | **수정** | 위와 같음 |
| `devlab/labSetup.ts`, `ui/setup.ts` | **수정** | 화력 = `isShipGun ? dmg·salvo/reload : 0` |
| `world/combatRating.ts` | **수정** | 기준 무장 집합은 `isShipGun`. `raw()`에서 함재기 제외(항공 전력 평가는 P16.3) |
| `client/strategic/industryUi.ts` | **수정** | 목록 줄에 `craftSummary` |
| `sim/world.ts` | 확인, 정상 | `updateWeapons`가 craft 마운트를 건너뛴다. 비행체 풀은 규칙 3 이상 + craft 마운트가 있을 때만 생성 |
| `sim/ai/commander.ts` | 확인, 정상 | `preferredRange`는 `rules >= 3`일 때만 craft를 읽는다 |
| `sim/ai/computer.ts` | 확인, 정상 | 사거리대(`bandsOf`)·`rate().off`가 함재기 유무와 무관하다(T5 테스트) |
| `sim/bbex/system.ts` | 확인, 정상 | BB-EX 전용 무장만 다룬다 |
| `render/battleView.ts` | 확인, 정상 | `salvo 0`이라 함재기 마운트에서 발사 연출이 생기지 않는다. 함재기 표시는 범위 밖(P16.4) |
| `content/registry.ts`, `validateArsenal.ts` | 확인, 반영 | craft는 `hp 'hangar'`, 효과음 `auto`. 전용 검사로 분리 |

## 5. 전투 엔진 결과 보존

- 이번 변경은 전투 엔진 코드(`sim/world.ts`, `craft.ts`, AI)를 고치지 않았다.
- 새 함급은 열거되지 않는다.
- 기존 함선의 무장 표(`WEAPONS`)에 추가된 것은 새 id(`air_torpedo` 등)뿐이다.

## 6. 미연결·후속 과제

### 6.1 항공 모듈 효과 (P16.3)

- `AirSpec`(`complement`, `control`, `spares`, `turnaround`)은 콘텐츠와 `EQUIPMENT.air`에 저장만 되어 있다.
- 전투(`ShipFx.air`, 비행체 풀)에는 아직 연결하지 않았다. 연결하면 규칙 3 전투 결과가 바뀌므로, 장교 효과 분리와 함께 P16.3에서 다룬다.
- 현재 장착해도 전투 효과는 없다. 피팅 화면 설명은 의도된 효과를 표시한다.

### 6.2 장교 효과 분리 문제 (P16.3 과제)

현재 함재기 피해는 다음 경로를 거친다.
- 피해는 함재기의 `cs.gun`·`ordnance` 값으로 계산되어 `applyHit`으로 들어간다.
- 그래서 피해·관통·치명 같은 **모함 함장의 장교 효과**가 함재기 공격에도 그대로 붙는다.
- 반대로 `world.ts`의 무장 보정(`wmod`의 `rof`·`gunRange`, 효과 `rangeMul`·`reloadMul`)은 craft 마운트를 건너뛰므로 함재기에 적용되지 않는다.

즉 일부 장교 효과는 의도치 않게 적용되고, 일부는 빠진다. P16.3에서 정할 일:
1. 항공 장교 효과(숙련도·트리)를 별도로 둘지
2. `applyHit`에 출처(함포/함재기)를 넘겨 함포용 효과를 함재기에서 뺄지
3. 항공 모듈 효과(§6.1)를 함께 연결할지

### 6.3 그 외 후속 과제
- 항모 전용 AI: 거리 유지·회피
- 항공 전력의 전투력 평가(`combatRating`)
- 렌더링
- 공개(§3)

## 7. 검증

모두 순차 실행했다(`--no-file-parallelism`, CPU 경합 없음).

| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit -p .` | 통과 |
| `npx vite-node scripts/content-check.ts` | 0 error(s), 0 warning(s) (팩 core·growth·arsenal·example·modeltest·bbex, 선체 35·변형 51·프리셋 65) |
| `tests/p16-content.test.ts` (신규 12건) | 12/12 통과 |
| 엔진 다이제스트 `scripts/combat/perf.ts` (1800틱, 5개 구성) | 변경 후 = `2115e3c`, 규칙 미지정·규칙 3 모두 5/5 일치 |
| 관련 회귀 23개 파일, 266건 | 260 통과, 6 실패. 내역은 아래 |
| `npm run build` | 통과 |

**규칙 미지정 다이제스트** (기준 커밋과 같음)
- af8527f2, d34949d4, a6a7e015, 960de679, 7b36665a

**규칙 3 다이제스트** (기준 커밋과 같고, P11 기록값과도 같음)
- 4bad50e8, a3c922c7, 91ebbf23, 5d71fa67, d7ee1c17

**회귀 실행 대상**
- p16-content, p16-craft, content, fitting, p15-computers, p15-capital, p5, example-pack
- growth, growth2, industrial-hardpoints, bbex-exclusive, bbex-combat, research, shipyard, p8-ships
- model-pipeline, sim, p11-combat-engine, dev1-combat, dev11-combat, b1-officers, b3-territory

**`tests/p16-content.test.ts` 검증 내용**
- T7 콘텐츠: 검증 0/0, 기본 규칙 2 유지, 함재기·항공 모듈·선체 속성, 함급 비열거, 함급 무장 = 프리셋 하드포인트 순서
- T6 장착 규칙
  - 기존 규칙과의 동치 확인 >1000건
  - H는 함재기 전용, 함재기는 H 전용
  - `flight` 베이 전용 (모든 변형)
  - 여명급 전체 피팅이 합법
- T5: 함재기를 달아도 `bandsOf`·`rate().off`·함포 DPS·사거리가 같다.
- 규칙 3 전투 (항모 1 vs 순양함 2): 함재기 20기 이상 출격, 피해 > 0. 규칙 0/1/2/미지정에서는 비행체 풀이 없고 출격도 없다.
- 월드 경로 (표준 월드, 전 세력 평판 100)
  - 구매·건조: 여명급 `buyShip`·`buildShip` 거부, 조선소 재고·시장 행 없음
  - 설계도: 제공 목록 제외, `buyBlueprint` 거부, `grantBlueprint` false, 계약 보상 없음
  - 피팅 명령 (항모를 주입한 함선)
    - 잘못된 H·`flight` 장착은 거부되고 상태가 바뀌지 않는다.
    - 합법 교체 시 장비 수량이 보존된다.
    - `fittingSpec` 함재기 마운트 4, 규칙 3 전투에서 10기 이상 출격
  - 순양함의 범용 하드포인트는 피팅 명령에서 함재기를 거부한다.

**회귀 실패 6건의 구분.** `2115e3c` 워크트리에서 같은 파일을 실행해 구분했다.

- `dev11-combat` 2건: **기존 실패.** `db0b3e1` 이전부터 있던 "콘텐츠 식별자가 현재 빌드와 다릅니다" 문제다.
  - 기술 부채로 기록한다(§8).
- `shipyard` 3건: **기존 실패.** 기준 커밋에서도 같은 3건이 실패한다.
  - 원인: 설계도 요구가 생긴 뒤 갱신되지 않은 테스트("설계도 필요: 구축함 (아이기스급) 설계도"). 이번 범위 밖이라 수정하지 않았다.
- `dev1-combat` 1건 ("exposes all usable hulls…"): **이번 변경의 의도된 결과.**
  - 실험실 선체 목록에서 미공개 선체를 뺐는데, 테스트는 `!h.dev`만 기대하고 있었다.
  - 기대값을 `!h.dev && !h.preview`로 고쳤고, 재실행 결과 7/7 통과했다.

이번 작업이 새로 만든 실패는 없다.

**미검증 항목**
- 브라우저 피팅 화면 확인: 공개 선체에 H 슬롯이 없어 플레이어 화면에서 볼 수 없다. 렌더링은 범위 밖이다.
- 실서버·PG 마이그레이션: 지시에 따라 하지 않았다.
- 전체 테스트(`npm test` 전 파일): 위험도 기준에 따라 관련 파일만 실행했다.

## 8. 기술 부채

| 항목 | 상태 |
|---|---|
| `tests/dev11-combat.test.ts` 2건 (DEV-1 설정 이전 시 콘텐츠 지문 불일치) | `db0b3e1` 이전부터 실패. 콘텐츠가 바뀔 때마다 고정 지문이 어긋나는 구조로 보인다. 별도 작업 필요 |
| `tests/shipyard.test.ts` 3건 (설계도 요구 도입 뒤 미갱신) | `2115e3c`에서도 실패. 별도 작업 필요 |
