# SIDERARIUM — 장기 성장 시스템 통합 개편 계획서

> 상태: **방향·단계 승인됨 (2026-11-06, 수정 지시 7개 반영본)**. 단계별로 구현하며, 진행 상황·미완료 항목은
> `docs/GROWTH_PROGRESS.md`에서 관리한다 (세션이 끊기면 그 문서부터 재개).
> 수정 이력: 1차 제출(78bcb47) → 승인 시 지시 반영(체납 페널티, 자산 보존 원장, 연구 13분야 원칙,
> Codex 범위·그래픽 자산 규격, 가이드 조기 구축, 밸런스·품질 기준, 운영 보호 절차).

---

## 1. 기존 시스템 분석 결과

### 1.1 콘텐츠 규모 (분석 시점 코드 기준)

| 영역 | 위치 | 현재 규모 | 구조적 특징 |
|---|---|---|---|
| 함급(전투 스펙) | `src/sim/data/ships.ts` `SHIP_CLASSES` | 12종 (전투 8, 산업 3, 플랫폼 1) | hp / armor(전·측·후) / 속도 / 선회 / cost + `loadouts[]` |
| 로드아웃 | 같은 파일 `loadouts` | 함급당 1~3개, 총 25개 | `mounts[{weapon,pos,facing,arc}]` + speed/armor/hp 배수. **하드포인트가 로드아웃 안에 암묵적으로만 존재** |
| 무기 | `src/sim/data/weapons.ts` `WEAPONS` | 9종 | kind = shell / missile / torpedo / pd. **티어·세대 개념 없음** |
| 장비 | `src/world/industry.ts` `EQUIPMENT` | 18종 (무기 9, 모듈 9) | 무기는 size 1~3, 모듈은 `fx`(FitFx 배수) |
| 선체(생산) | 같은 파일 `HULLS` | 11종 | classId 키, yard 1~4, parts, credits, `slots` |
| 아이템 | `ITEMS` | 22종 | raw / refined / part / shippart |
| 시설 | `FACILITIES` | 38종 | kind/cat/power/lines/storage/requires/tech/max/lab/yard |
| 레시피 | `RECIPES` | 41종 | fac/time/in/out/tech |
| 기술 | `TECHS` | 41종, 9개 분야 | 단일 티어, `fx` 배수, 9개만 `bp` 가격(청사진 판매) |
| 경제 수치 | `src/world/data.ts` `ECON` | classId 키 | cruise/cargo/mine/price/alloy/rep/military |

### 1.2 핵심 관찰

1. **함선 정체성 = classId 하나.** `SHIP_CLASSES`, `HULLS`, `ECON`이 모두 classId 키 → 같은 함급의 다른 선체, 변형, 산업선 S/M/L/XL을 표현할 자리가 없다.
2. **피팅 = 모듈 id 배열(`WShip.fit`)** + `HULLS.slots`/`fitUnits`. 하드포인트 타입·크기·마운트, 내부 장비 슬롯, 전력 예산 없음. 무장은 로드아웃 선택으로만 바뀐다.
3. **전투 반영 경로는 하나:** `shipFxOf(s) = fitFx(fit, tech, armory)` → 전술전투 `createShip(..., fx)` / 순항 `cruiseOf`.
4. **운영비가 전혀 없음** → 함대를 무한히 늘려도 비용이 없다.
5. **시장:** `price = base × clamp(1.45 − 0.55·stock/target, 0.45, 1.7)`. **판매 수요 상한이 없고 가격 하한 0.45** → 무한 판매.
6. **연구/청사진 결합:** `bp:<tech>` 아이템을 `learnBlueprint`로 소비하면 연구 완료 처리.
7. **연구소/조선소:** `FacilityDef.lab`(분야), `FacilityDef.yard`(1~4) — 전문화 확장에 재활용.
8. **렌더링:** `shipMesh.ts design()`이 classId switch 절차적 메시, 신규 함급은 `MESH_ALIAS`로 기존 실루엣 스케일 재사용.
9. **UI:** `hud.ts` 정거장 모달 + `industryUi.ts`. `src/ui/morph.ts`가 실시간 갱신 중 입력·선택·스크롤을 보존.
10. **버전·마이그레이션 인프라:** `WORLD_VERSION=4`, `INDUSTRY_VERSION=2`, 버전 상승 시 `backup-pre-v<old>` 백업 + 센서스 + 왕복 검증, 세대 펜스(`gen`)·`WORLD_RESET`·계정 테이블.
11. **운영 월드 현황(2026-11-06 조회):** 함선 150척, 조합은 `battleship/std, corvette/gun·torp, cruiser/gun·missile·multi, destroyer/aa·strike, hauler/std, miner/std`, 모듈 장착 0, 건조 대기 0. 세이브 크기 약 340 KB.

---

## 2. 시스템 간 의존성

```
                ┌──────────── Content Registry (src/content: 스키마 + 팩 + 검증기 + 에셋 등록) ────────────┐
                │ hulls · variants · hardpoints · presets · equipment · weapons(tier) · research ·        │
                │ blueprints · graphic assets                                                               │
                └──────┬──────────────┬───────────────┬────────────────┬──────────────────────────────────┘
                       │              │               │                │
                 Fitting V2 ──► Combat/Cruise    Production ◄──── Blueprint Ledger
                 (검증·전력·용량)  (shipFxOf 단일 경로)  (시설·레시피)       (회사별 소유)
                       │                              │                ▲
                       ▼                              ▼                │
                 Inventory(정거장 창고) ◄───────── Market(지역 수급) ◄── Research(13분야·연구소)
                       │                              ▲
                       ▼                              │
                 Upkeep(운용/정박/예비, 보급·정비·출항) ── Credits / 장기 경제 시뮬레이션
                       │
                       ▼
                 UI (피팅 화면, 비교/필터/정렬, 수입·지출 예측, 체납 예고, 코덱스)
```

- 공통 데이터 모델(P1)이 모든 단계의 선행 조건.
- 피팅 V2는 레지스트리 + 인벤토리에 의존, 전투는 피팅 결과(`ShipFx`·마운트)에만 의존.
- 운영비는 선체/변형 데이터(승무원·정비 계수)에 의존, 시장 개편과 함께 돌려야 균형 검증이 의미 있다.
- 무기 티어·연구·시설 → 레지스트리 + 생산, 청사진은 연구와 생산 사이의 게이트.
- 콘텐츠 가이드·검증기는 **P1에서 골격, P2에서 Codex 가이드 초안, 이후 단계마다 확장, P7에서 최종 완성.**

---

## 3. 최종 목표 아키텍처

### 3.1 모듈 배치

```
src/content/                     ← 모든 정적 콘텐츠의 단일 출처 (P1 구축)
  schema.ts                      타입 정의 (HullDef, VariantDef, HardpointDef, PresetDef, AssetDef …)
  registry.ts                    팩 병합, id 조회, 변형 레이아웃, 프리셋 → 전투 마운트, 기존 매핑
  validate.ts                    참조 무결성·호환성·범위·기존 데이터 충실도·에셋 등록 검사
  assetFs.ts                     (node 전용) public/assets/content 파일 검사
  packs/index.ts                 로드할 팩 목록
  packs/core/                    기존 콘텐츠(12 선체, 13 변형, 25 프리셋) + 에셋 등록
  packs/<신규팩>/                 대표 콘텐츠·그래픽 자산 등록 (Codex 작업 영역)
public/assets/content/           그래픽 자산 파일 (models/ portraits/ icons/)
src/world/migrate.ts             콘텐츠 마이그레이션 + 자산 센서스 + 지급 원장 (P1 구축)
src/world/fitting.ts             피팅 V2 (P2)
src/world/upkeep.ts              운영비·운용 상태·보급 (P4)
src/world/market.ts              지역 수급·수요 상한 (P4)
src/world/blueprints.ts          청사진 원장 (P6)
scripts/content-check.ts         npm run content:check
scripts/rehearse-file.mjs · rehearse-pg.mjs   마이그레이션 리허설
scripts/econsim.mjs              장기 경제 시뮬레이션 (P4~)
docs/CONTENT_SCHEMA.md (P1 초안) · CODEX_CONTENT_GUIDE.md (P2 초안) · CONTENT_BALANCE.md (P4 초안) → P7 최종
```

기존 `SHIP_CLASSES`·`WEAPONS`·`industry.ts` 테이블은 그대로 두고, 레지스트리가 그 위에 선체/변형/프리셋을
얹는다. 전투 엔진은 P2에서 레지스트리 마운트를 받도록 바뀌며, 그 전까지 기존 경로를 쓴다.

### 3.2 함선 정체성 모델

```
Class(역할·AI·전투 기본값: 구축함, 순양함, 채굴선 …)
  └─ Hull(실제 선체: 고유 외형·하드포인트 배치·내부 슬롯·크기)
       └─ Variant(구조적 차이만: 하드포인트/슬롯 추가·제거, 구조 보정 — 장비 미포함)
            └─ Fitting(실제 장착 장비 = 인벤토리에서 이동한 실물). Preset = 이름 붙은 장착안.
```

- 산업선(miner/hauler/constructor)은 Hull의 size S/M/L/XL. 크기가 조선소 등급·용량·운영비를 결정.
- **새 선체는 기존 모델의 확대·축소나 부분 변형 수준이면 안 된다.** 각 선체는 서로 구별되는 실루엣(전용
  메시 함수 또는 등록된 모델)과 서로 다른 역할(하드포인트 배치·사계·내부 슬롯 구성의 차이로 드러나는 전술적
  쓰임)을 가져야 하며, 검증기와 리뷰 체크리스트로 확인한다(§7).

### 3.3 경제 루프와 운영비 체납 (수정 지시 1 반영)

```
수입: 채굴/운송/계약/전투 보상 → 시장 판매(지역 수요 상한·포화·회복)
지출: 운영비(급여·정비·연료·탄약·정박료) + 생산·연구 자원 + 청사진
허용: 합리적 재투자로 사업 규모가 커지며 수입이 늘어나는 것 (선형 이하일 필요 없음)
금지: 무제한 시장 수요, 자원·장비 복제, 비용 없는 무한 확장 같은 허점
```

**체납 처리 원칙** — 운영비 부족은 전투 성능이나 연구·생산 속도를 깎지 않고, **보급·정비·신규 출항·가동률**에 작용한다.

| 단계 | 조건(수치는 P4 시뮬레이션으로 결정) | 효과 |
|---|---|---|
| 예고 | 예상 지출이 잔고·예상 수입으로 N시간 내 감당 불가 | HUD 경고 + 다음 정산 시각·부족액·원인별 지출 표시, 예비역 전환 추천 목록 |
| 1. 보급 지연 | 정산 시 잔고 부족 | 탄약·연료 재보급과 정박 정비(수리)가 자금이 들어올 때까지 대기 — 대기 사유를 함선·정거장 UI에 정확히 표시 |
| 2. 출항 제한 | 체납 지속 | 정박 중인 함선의 **새 출항·신규 작전 배정**이 보류(사유 표시). 이미 작전 중인 함선·전투 중인 함선·위험 지역의 함선은 계속 활동하고 강제 귀환·정박시키지 않음 |
| 3. 가동률 저하 | 장기 체납 | 플레이어가 지정하지 않으면 **유휴 함선부터** 예비역 후보로 제안. 플레이어가 승인한 함선만 예비역 전환(운영비 대폭 감소). 자동 전환은 정박 중·비전투·안전 지역 함선에 한하며 옵션으로 끌 수 있음 |
| 회복 | 잔고가 정산액 이상 | 즉시 정상 단계로 복귀, 대기 중이던 보급·정비 재개, 예비역 함선은 재취역 명령으로 복귀(재취역 비용·시간은 P4에서 결정) |

- 자산 삭제, 함선 소실, 회복 불가능한 페널티, 부채 이자 누적에 의한 파산 같은 처리는 **두지 않는다.**
- 작업이 자금 부족으로 멈추면 그 작업 위치(조선 대기열, 수리 대기, 출항 버튼 등)에 "무엇이, 얼마가, 왜" 부족한지 표시.

### 3.4 연구 13분야 원칙 (수정 지시 3 반영)

분야: 선체, 추진, 동력, 실탄, 에너지, 미사일, 방어, 전자, 산업, 자원, 물류, 정거장, 전술.

- **한 효과·한 해금 대상은 한 기술에만 속한다.** 같은 배수(예: 생산 속도)를 여러 분야에 흩어 놓지 않는다.
  검증기가 해금 대상 중복과 같은 fx 키의 분야 간 중복을 오류/경고로 잡는다.
- 분야는 담당 범위로 구분: 예) 동력 = 리액터·전력 예산, 추진 = 엔진·순항·워프, 물류 = 화물·수송·보급비,
  정거장 = 시설·건설·정박료, 전술 = 지휘·교리·전장 회수.
- 분야를 채우기 위한 의미 없는 기술(단순 +5% 반복 등)은 만들지 않는다. 각 기술은 새 장비/시설/레시피/선체/
  메커니즘 해금 또는 플레이 방식을 바꾸는 효과 중 하나 이상을 가진다.

### 3.5 UI 원칙 (요구 1-1)
- 실시간 패널은 `morph()` 경로로 갱신, `data-keep`로 사용자 입력 보존.
- 피팅·무기·선체 목록은 공통 리스트 컴포넌트(검색·필터·정렬·2열 비교)로 통일.
- 단계마다 1080p/1440p 스크린샷 검증과 조작 흐름 점검을 완료 조건에 포함(§7).
- 컨테이너에 GPU가 없어 WebGL 성능 수치는 소프트웨어 렌더링 기준임을 보고서에 명시.

---

## 4. 단계별 개발 계획

각 단계 = 독립 커밋 + 테스트 + 세이브 호환 확인 + UI/UX 점검 + `GROWTH_PROGRESS.md` 갱신.

| 단계 | 내용 | 주요 산출물 | 세이브 영향 |
|---|---|---|---|
| **P0 분석** | 본 문서 | GROWTH_PLAN / GROWTH_PROGRESS | 없음 |
| **P1 공통 데이터 모델·마이그레이션** | `src/content` 스키마·레지스트리·**기본 검증기**, 기존 12 함급 → Hull 12 + Variant 13 + Preset 25 (하드포인트 110개 추출), **그래픽 자산 디렉터리·등록 규격**, 마이그레이션 프레임워크·자산 센서스·지급 원장, 운영 서버 dry-run 모드, 리허설 스크립트, `CONTENT_SCHEMA.md` 초안 | 위 전부 | `WShip/ShipBuild.hull·variant`, `contentV`, `grants` 추가 (비파괴). 운영 적용은 승인 후 |
| **P2 피팅 V2** | 하드포인트 장착(크기/타입/마운트), 내부 슬롯(엔진·리액터·센서·FCS·EW·장갑·특수), 질량·전력 검증, 프리셋, 서버 검증 명령, 인벤토리 실이동, 전투 엔진이 레지스트리 마운트 사용, 피팅 UI. **`CODEX_CONTENT_GUIDE.md` 초안** | `fitting.ts`, 피팅 화면, 가이드 초안 | 로드아웃 무장 → 실제 장착 장비 (기존 자산으로 기록, §6) |
| **P3 선체·변형·산업선 크기** | 함급당 2~3개의 **외형·역할이 다른** 선체, 변형, 산업선 S/M/L/XL, 조선소 등급 연동, 선체 전용 메시/모델 연결 | 콘텐츠 팩, 메시 | 기존 함선은 mk1 선체 유지 |
| **P4 운영비·시장 개편** | 운영비, 운용/정박/예비 상태, §3.3 체납 처리, 예상 수입·지출 UI, 지역 수급·수요 상한·회복, econsim 8h/24h/다일, `CONTENT_BALANCE.md` 초안 | `upkeep.ts`, `market.ts`, econsim | **운영 월드 반영 전 별도 승인** |
| **P5 무기·연구·시설** | 무기 계열·티어(레이저 세대, 코일→레일, 미사일/어뢰, 플라즈마, 입자, PD), 크기×티어 분리, 생산 레시피, 연구 13분야(§3.4), 전문 연구소·생산시설, 연구 자원 소모 | 콘텐츠 팩 확장 | 기존 기술 진행도 → 새 트리 매핑(완료는 완료 유지) |
| **P6 청사진** | 소유 원장, 등급(일반/고급/세력/희귀/고유), 연구와 분리, 변형 청사진, 복제 금지 | `blueprints.ts` | 기존 `bp:` 아이템·학습 기술 → 원장 항목 |
| **P7 가이드·검증기 최종 완성** | P1~P6에서 단계별로 확장한 스키마 문서·Codex 가이드·밸런스 문서·검증기를 전체 시스템 기준으로 정리·보완, CI 고정 | docs 3종 최종본, validator 최종 | 없음 |
| **P8 대표 콘텐츠 팩** | 검증기를 통과하는 성장 콘텐츠 일괄 (Codex 그래픽 자산 포함) | `packs/growth` | 없음(추가만) |
| **P9 장기 시뮬레이션·밸런스** | 다일 시뮬레이션, 성장 곡선, 허점 탐지 | 밸런스 리포트 | 수치 조정만 |

---

## 5. 주요 데이터 규격

P1에서 확정·구현된 부분은 `src/content/schema.ts`와 `docs/CONTENT_SCHEMA.md`가 기준이다. 요약:

```ts
type Size = 'S' | 'M' | 'L' | 'XL';
type HardpointType = 'ballistic' | 'energy' | 'missile' | 'universal' | 'pd';
type MountStyle = 'turret' | 'fixed' | 'vls' | 'spinal';
interface HardpointDef { id; pos: [x,y,z]; facing; arc; size; type; mount }      // id는 세이브 키 — 재번호 금지
type InternalKind = 'engine' | 'reactor' | 'sensor' | 'fcs' | 'ew' | 'armor' | 'special';
interface HullDef { id; classId; name; tier; size; hardpoints; internals; moduleSlots; mesh{base,scale,model?}; blueprint; desc }
interface VariantDef { id; hull; name; desc; hardpoints?{add,remove}; internals?{add,remove}; mods?{hpMul,armorMul,speedMul}; blueprint; model? }
interface PresetDef { id; hull; variant; name; desc; weapons: { [hardpointId]: weaponId | {weapon, arc} }; costDelta? }
interface AssetDef { id; kind; file; for; author?; license?; notes? }
```

장착 규칙(P1 검증기에 구현): 무기 크기 ≤ 하드포인트 크기, 방공(PD) 무기는 같은 크기 이하의 모든 하드포인트에
장착 가능, PD 하드포인트는 PD 무기만, universal은 모든 무기, 그 외는 계열 일치.

P2 이후 확정 예정(초안):

```ts
interface ShipFitting { hp: Record<hardpointId, equipmentId>; bay: Record<bayId, equipmentId>; preset?; sig? }   // P2 확정 (src/world/fitting.ts)
interface ItemInstance { id; item; origin: 'owned' | 'legacy-mounted' | 'grant'; since: number }   // §6
interface UpkeepState { mode: 'active' | 'docked' | 'reserve'; due: number; stage: 0|1|2|3; reason?: string }
interface MarketLine { stock; target; base; demand; demandCap; recover }
type BlueprintGrade = 'common' | 'advanced' | 'faction' | 'rare' | 'unique';
interface BlueprintEntry { id; grade; source: 'research'|'purchase'|'loot'|'faction'|'legacy'; at }
interface ResearchDef { id; field: ResearchField; tier; time; pre; cost{credits, items}; lab; grants{blueprints?, fx?, unlock?} }
```

---

## 6. 기존 저장 데이터 보존 방안 (수정 지시 2·7 반영)

### 6.1 원칙
1. **비파괴·결정적 매핑:** `classId → hull`, `loadoutId → variant (+preset)`. 매핑 불가 항목은 그대로 두고 보고(`unmapped`). 삭제 없음.
2. **별도 버전:** `st.contentV` (P1 = 1, P2 = 2 피팅). `WORLD_VERSION`·`INDUSTRY_VERSION`·`WORLD_RESET`·세대 펜스·계정 테이블은 건드리지 않는다.
3. **기존 소유분과 신규 지급분의 구분:**
   - 기존 소유 장비 = 창고의 장비 아이템 + 함선에 장착된 모듈 + **로드아웃에 장착된 무기**(현재는 함선의 일부로만 존재하지만, P1부터 센서스에서 장비로 센다).
   - P2에서 장착 무기를 실물 아이템으로 바꿀 때 그 아이템은 기존 자산의 형태 변환으로 기록하고, 수량은 센서스의 기존 장착 수와 정확히 같아야 한다.
     **P2 구현 결정:** 장비는 창고에서 수량 스택(`Cargo`)으로 보관되므로 개별 인스턴스(`ItemInstance.origin`) 대신
     회사·아이템별 **변환 원장 `st.conversions`** (`{v, company, item, n, ships, why}`)로 기록한다. 지급(`grants`)이 아니므로
     센서스 식에 더해지지 않는다. 개별 인스턴스가 필요해지면(P6 청사진 등) 그때 도입한다.
   - 새 시스템이 요구하지만 기존에 어떤 형태로도 없던 장비·청사진은 `origin: 'grant'`로 만들고 **`st.grants` 원장에 한 건씩 기록**한다 (`{v, at, company, ref, item, n, why}`).
4. **보존 검증식:** 회사·아이템별로 `마이그레이션 후 수량 = 이전 수량 + 원장에 기록된 지급 수량`. 플레이어 수·함선·정거장·시설 수는 동일, 크레딧 ±1 이내. 하나라도 어긋나면 서버는 저장하지 않고 종료한다(`compareCensus`).
5. **멱등성:** 같은 마이그레이션을 다시 실행해도 아무것도 바뀌지 않는다. 이전 코드로 롤백한 동안 생긴 함선은 다시 올렸을 때 자동 보정된다.

### 6.2 운영 적용 절차 (모든 세이브 영향 단계 공통)
1. **운영 데이터 사본 검증 (dry-run):** 새 코드는 기본값으로 운영 세이브의 **메모리 사본**에 마이그레이션을 실행해 결과(대상 함선 수, 매핑 실패, 지급 건수, 센서스 일치, 직렬화 왕복)를 로그로만 남기고, 실제 월드에는 적용하지 않는다. 이 로그를 Render에서 확인해 보고한다.
2. **로컬 리허설:** 이전 코드 빌드로 만든 실사용 형태 세이브에서 `scripts/rehearse-file.mjs`(파일)·`scripts/rehearse-pg.mjs`(로컬 Postgres)로 dry-run → 적용 → 이전 코드로 롤백 → 재적용 → 백업 복원을 검증.
3. **승인 후 적용:** Render 환경 변수 `CONTENT_MIGRATE=apply` 설정 → 재배포. 서버가 `backup-pre-v<ver>.c<old>` 백업 행을 쓰고 다시 읽어 검증한 뒤 마이그레이션, 센서스·왕복 검증 통과 시에만 저장 시작. 같은 키에 이전 백업이 있으면 `-2`, `-3` 접미사로 새로 쓴다(덮어쓰지 않음).
4. **사후 확인:** Supabase에서 `contentV`, 함선별 hull 채움 수, 백업 행 존재 확인.

### 6.3 되돌리기 절차 (리허설 완료)
- **코드 롤백:** Render에서 이전 배포로 롤백(또는 이전 커밋 재배포). 콘텐츠 마이그레이션은 필드 추가만 하므로 이전 코드가 마이그레이션된 세이브를 그대로 읽고 저장한다(리허설 3단계 확인). 다시 새 코드로 올리면 그 사이 생긴 함선이 자동 보정된다.
- **P2(c2) 이후 코드 롤백 주의:** P1 이하 코드는 `fitting`을 모르고 `loadoutId`(라벨)·`fit`만 본다. 사용자 피팅(프리셋과 다른
  무장)을 가진 함선은 롤백 중에는 라벨 로드아웃으로 싸우고, 이전 코드에서 그 함선을 개조하면 장비 계산이 실제 장착과 어긋날 수 있다.
  다시 올리면 `fitting.sig` 불일치로 그 함선만 기존 로드아웃 기준으로 재구성된다(테스트로 확인). 따라서 c2 적용 **후** P1 이전으로
  코드를 되돌려야 하면 **데이터 롤백(c2 적용 직전 백업)도 함께** 한다. c2 적용 전(현재 운영)에는 코드 롤백만으로 안전하다.
- **데이터 롤백:**
  `UPDATE siderarium_world SET data = (SELECT data FROM siderarium_world WHERE id = '<백업 키>'), gen = gen + 1, updated = now() WHERE id = 'main';`
  `gen` 증가로 실행 중인 인스턴스는 다음 저장 시 펜스되어 더 이상 쓰지 않는다(리허설 확인). 이어서 서버를 재시작하면 복원된 월드를 읽는다. 데이터 롤백 후 코드를 그대로 두면 dry-run 모드로 동작하므로 재적용 전까지 다시 마이그레이션되지 않는다(`CONTENT_MIGRATE` 해제 필요).

---

## 7. 단계별 테스트 및 완료 기준 (수정 지시 6 반영)

| 단계 | 테스트 | 완료 기준 |
|---|---|---|
| 공통 | `npm test`, `tsc`, `build:server`, `npm run content:check`, `scripts/mptest.mjs`, 싱글플레이 브라우저 스모크 | 전부 통과. **UI/UX·시각 품질·조작 편의 점검**(해당 단계에 화면 변경이 있으면 1080p/1440p 스크린샷과 조작 흐름 기록) |
| P2 | 장착 규칙·서버 거부 13종, 장착/해제 총량 불변·실패 원자성, 25 프리셋 전투 다이제스트 동일, 렌더 포탑 = 하드포인트, v2 마이그레이션 보존·변환 원장·반환·sig 재구성, mptest 실행 수 가드 | 리허설(파일) 통과, 피팅 화면 1080p·1440p |
| P1 | 레지스트리 무결성, 기존 25 로드아웃 → 프리셋 마운트 완전 일치, 검증기가 깨진 데이터 12종 검출, 에셋 등록 규칙, 마이그레이션 멱등·센서스·왕복, dry-run 무변경, 롤백·재적용 보정 | 리허설(파일·Postgres) 통과, 운영 dry-run 로그 확인 |
| P2 | 장착 규칙(크기/타입/마운트/전력/질량), 서버 거부, 장착·해제 시 총량 불변, 타사 함선 거부, 프리셋 적용, 전투 결과 동일(시드 고정) | 피팅 화면에서 비교·필터·정렬·되돌리기 가능, 실시간 갱신 중 입력 유지 |
| P3 | 선체·변형 검증, 산업선 크기별 조선소 제한, 모든 선체 메시 생성 스모크 | **선체 구별성 체크리스트**: 실루엣(상면·측면 스크린샷 비교), 하드포인트 배치·사계 차이, 역할 설명이 같은 함급 내 다른 선체와 겹치지 않음 |
| P4 | 운영비 계산, 체납 단계 진입/회복, 전투·위험 지역 함선 강제 정박 없음, 자산 삭제 없음, 예고·사유 표시, 시장 수요 상한·회복 | **econsim 8h/24h/72h**: 재투자로 성장은 허용하되 ① 단일 시장 무한 판매로 수익 유지 불가 ② 생산 루프의 자원·장비 순증(복제) 없음 ③ 운영비 없는 확장 경로 없음 ④ 유휴 함대 비용이 의미 있음. 리포트 첨부, 운영 반영 별도 승인 |
| P5 | 무기 계열별 역할 시나리오 전투(대형함·고속함·미사일 포화·근접전)에서 계열마다 우위 상황이 존재, 연구 트리 순환·효과/해금 중복 없음 | **상위 무장이 모든 수치에서 우월하지 않음**(계열별 장단점·전술적 선택 확인), 검증기 통과 |
| P6 | 중복 소유 불가, 연구≠소유, 거래/드랍 경로, 복제 불가 | 원장 마이그레이션 센서스 일치 |
| P7~P8 | `content:check`를 테스트에 포함, 의도적으로 깨뜨린 팩 실패 확인, 에셋 크기·등록 검사 | 대표 팩 전부 통과 |
| P9 | 다일 시뮬레이션, 성장 곡선 목표치 비교, 허점 탐지 | 밸런스 리포트 승인 |

---

## 8. Claude와 Codex의 작업 경계 (수정 지시 4 반영)

| 담당 | 범위 |
|---|---|
| **Claude (핵심 엔진·시스템)** | `src/content/schema.ts`·`registry.ts`·`validate.ts`, `src/world/**`, `src/sim/**`, `src/server/**`, `src/client/**`·`src/ui/**`·`src/render/**`의 코드, 마이그레이션, 서버 권한 검증, 전투 엔진 연결, 렌더러의 모델 로딩 코드, 경제 시뮬레이터, 배포·운영 검증, 문서 구조 |
| **Codex (콘텐츠·그래픽)** | 아래 경로의 추가·수정 |
| | `src/content/packs/<팩>/**` — 선체·변형·프리셋·(P2~)장비·연구·레시피 데이터와 텍스트 |
| | `src/content/packs/<팩>/assets.ts` — 그래픽 자산 등록 |
| | `public/assets/content/models/` — 함선 모델·파생형 외형 (`.glb`) |
| | `public/assets/content/portraits/` — 함장 초상화 |
| | `public/assets/content/icons/` — 장비·아이템·시설 아이콘 |
| | `src/content/packs/index.ts` — 새 팩 한 줄 등록만 |
| | `docs/CODEX_CONTENT_GUIDE.md`의 예시·체크리스트 보완 제안 |
| **경계 규칙** | Codex 변경은 `npm run content:check`와 `npm test` 통과가 필수. 새 필드·새 메커니즘·새 에셋 종류가 필요하면 스키마 변경 요청으로 Claude에 넘긴다. 기존 하드포인트 id·콘텐츠 id는 이름 변경·재사용 금지(세이브 키). 에셋은 등록된 파일만 허용(미등록 파일은 검증기 오류) |

에셋 등록 규격(`docs/CONTENT_SCHEMA.md` §6): 종류별 디렉터리·확장자·용량 한도, `for`로 대상 콘텐츠 id 지정,
모델은 +z 전방·선체 중심 원점·1단위 = 게임 1단위, 라이선스 기재.

---

## 9. 승인 기록

| 항목 | 결정 (2026-11-06) |
|---|---|
| 전체 방향·P1~P9 | 승인 |
| 체납 페널티 | 연구·생산·전투 성능 감소 철회 → 보급·정비·출항·가동률 중심, 예고·사유 표시, 전투/위험 지역 강제 정박 금지, 자산 삭제·회복 불가 페널티 금지. 수치는 시뮬레이션으로 결정 (§3.3) |
| 무상 지급 원칙 | 승인. 기존 소유분과 지급분을 구분하고 지급분은 원장에 기록 (§6.1) |
| 연구 13분야 | 승인. 효과·해금 중복 금지, 의미 없는 기술 금지 (§3.4) |
| Codex 범위 | 데이터 + 그래픽 자산까지. 핵심 엔진은 Claude (§8) |
| 가이드 | P1 스키마·기본 검증기, P2 Codex 가이드 초안, P7 최종 완성 |
| 밸런스 | 성장 허용·허점 금지, 무장은 계열별 장단점, 선체는 구별되는 외형·역할, 단계별 UI/UX 점검 (§7) |
| 운영 보호 | P4 운영 반영 별도 승인, 모든 마이그레이션은 운영 사본 검증 + 백업 복원 + 코드 롤백 절차 확인 (§6.2·6.3) |
