# SIDERARIUM — 장기 성장 시스템 통합 개편 계획서 (1차 제출본)

> 상태: **승인 대기**. 이 문서는 구현 전 설계안이며, 승인된 범위만 단계별로 구현한다.
> 진행 상황·미완료 항목은 `docs/GROWTH_PROGRESS.md`에서 관리한다 (세션이 끊겨도 그 문서부터 재개).

---

## 1. 기존 시스템 분석 결과

### 1.1 콘텐츠 규모 (현재 코드 기준)

| 영역 | 위치 | 현재 규모 | 구조적 특징 |
|---|---|---|---|
| 함급(전투 스펙) | `src/sim/data/ships.ts` `SHIP_CLASSES` | 12종 (전투 8, 산업 3, 플랫폼 1) | hp / armor(전·측·후) / 속도 / 선회 / cost + `loadouts[]` |
| 로드아웃 | 같은 파일 `loadouts` | 함급당 2~3개 | `mounts[{weapon,pos,facing,arc}]` + speed/armor/hp 배수. **하드포인트가 로드아웃 안에 암묵적으로만 존재** |
| 무기 | `src/sim/data/weapons.ts` `WEAPONS` | 9종 | kind = shell / missile / torpedo / pd. **티어·세대 개념 없음** |
| 장비 | `src/world/industry.ts` `EQUIPMENT` | 18종 (무기 9, 모듈 9) | 무기는 size 1~3, 모듈은 `fx`(FitFx 배수) |
| 선체(생산) | 같은 파일 `HULLS` | 11종 | classId 키, yard 1~4, parts, credits, `slots` |
| 아이템 | `ITEMS` | 22종 | raw / refined / part / shippart |
| 시설 | `FACILITIES` | 38종 | kind/cat/power/lines/storage/requires/tech/max/lab/yard |
| 레시피 | `RECIPES` | 41종 | fac/time/in/out/tech |
| 기술 | `TECHS` | 41종, 9개 분야 | 단일 티어, `fx` 배수, 9개만 `bp` 가격(청사진 판매) |
| 경제 수치 | `src/world/data.ts` `ECON` | classId 키 | cruise/cargo/mine/price/alloy/rep/military |

### 1.2 핵심 관찰

1. **함선 정체성 = classId 하나.** `SHIP_CLASSES`, `HULLS`, `ECON`이 모두 classId로 키가 묶여 있어 “같은 함급의 다른 선체”나 “변형(variant)”, “산업선 크기(S/M/L/XL)”를 표현할 자리가 없다.
2. **피팅 = 모듈 id 문자열 배열(`WShip.fit`)** + `HULLS.slots`/`fitUnits` 용량 제한. 하드포인트 타입·크기·마운트 방식, 내부 장비 슬롯(엔진/리액터/센서…), 전력 예산 모두 없음. 무장은 로드아웃 선택으로만 바뀌고 **장비 재고와 연결되지 않음**.
3. **전투 반영 경로는 하나로 잘 모여 있음:** `shipFxOf(s) = fitFx(fit, tech, armory)` → 전술전투 `createShip(..., fx)` / 순항 `cruiseOf`. 신규 피팅은 이 지점만 바꾸면 전투·이동에 일괄 반영 가능.
4. **운영비가 전혀 없음.** `src/world` 전체에 upkeep/wage/maintenance 관련 코드 없음 → 함대를 무한히 늘려도 비용이 없어 장기 인플레이션의 근본 원인.
5. **시장:** 정거장별 `Market{res:{stock,target,base}}`, `price = base × clamp(1.45 − 0.55·stock/target, 0.45, 1.7)`, 매수가 ×1.18, `sellAt`은 50단위 청크·세금. NPC는 `npcMarketStep`의 PROFILES(make/use/sell). **판매 수요 상한이 없고 가격 하한 0.45** → 무한 판매로 무한 수익 가능.
6. **연구/청사진 결합:** 기술 연구가 곧 생산 해금이고, `bp:<tech>` 아이템은 `learnBlueprint`에서 소비되어 연구 완료로 처리됨 → “연구했지만 청사진은 없음” 같은 분리가 불가.
7. **연구소/조선소:** `FacilityDef.lab`(분야), `FacilityDef.yard`(1~4) 로 이미 전문화의 씨앗이 있음. 확장에 재활용 가능.
8. **렌더링:** `src/render/shipMesh.ts` `design()`이 classId switch로 절차적 메시 생성, 신규 함급은 `MESH_ALIAS`로 기존 실루엣 스케일 재사용. 전략맵은 `src/client/strategic/meshes.ts`.
9. **UI:** `hud.ts`(1404줄)의 정거장 모달 탭 + `industryUi.ts`(생산/시장/조선/연구). `src/ui/morph.ts`가 이미 있어 **실시간 갱신 시 입력·선택·스크롤 보존**이 가능(요구사항 1-1의 “실시간 갱신으로 UI 초기화 금지”의 기반).
10. **버전·마이그레이션 인프라 존재:** `WORLD_VERSION=4`, `INDUSTRY_VERSION=2`, 서버 기동 시 버전 상승이면 `backup-pre-v<old>` 백업 후 마이그레이션, 세대 펜스(`gen`)·`WORLD_RESET`·계정 테이블은 별개로 유지.
11. **문서:** `README.md` 외에 설계 문서 없음 → 이번에 `docs/` 신설.

---

## 2. 시스템 간 의존성

```
                ┌──────────────── Content Registry (정적 데이터 + 검증기) ────────────────┐
                │ items · equipment · weapons(tier) · hulls · variants · hardpoints ·     │
                │ facilities · recipes · research · blueprints                              │
                └───────┬───────────────┬───────────────┬───────────────┬──────────────────┘
                        │               │               │               │
                   Fitting V2 ──► Combat/Cruise   Production ◄──── Blueprint Ledger
                   (검증·전력·용량)  (shipFxOf 단일 경로)  (시설·레시피)      (회사별 소유)
                        │                               │               ▲
                        ▼                               ▼               │
                  Inventory(정거장 창고) ◄────────── Market(지역 수급) ◄── Research(13분야·연구소)
                        │                               ▲
                        ▼                               │
                  Upkeep(상태: 운용/정박/예비) ──── Credits/경제 시뮬레이션
                        │
                        ▼
                     UI (피팅 화면, 비교/필터, 수입·지출 예측, 코덱스)
```

의존 순서 핵심:
- **공통 데이터 모델**이 모든 것의 선행 조건 (선체/변형/하드포인트/장비 id 체계).
- **피팅 V2**는 데이터 모델 + 인벤토리에 의존, 전투는 피팅 결과(`ShipFx`)에만 의존.
- **유지비**는 선체/변형 데이터(승무원·정비 계수)에 의존하고, **시장 개편**과 함께 돌려야 경제 균형 검증이 의미 있음.
- **무기 티어·연구·시설**은 레지스트리 + 생산에 의존, **청사진**은 연구와 생산 사이에 끼어드는 게이트.
- **코덱스 검증기**는 모든 콘텐츠 정의가 확정된 뒤 고정, 단 스키마 검증 골격은 2단계부터 먼저 만든다.

---

## 3. 최종 목표 아키텍처

### 3.1 모듈 배치

```
src/content/                 ← 신규: 모든 정적 콘텐츠의 단일 출처
  schema.ts                  타입 정의 (HullDef, VariantDef, HardpointDef, EquipDef, WeaponDef, ResearchDef, BlueprintDef …)
  registry.ts                id → 정의 조회, 파생 인덱스(클래스별 선체, 티어별 무기 …), freeze
  validate.ts                참조 무결성·밸런스 범위·순환 검사 (CLI: npm run content:check)
  packs/core/*.ts            기존 콘텐츠를 신규 스키마로 옮긴 기본 팩
  packs/growth/*.ts          대표 콘텐츠 팩 (신규 선체·무기 티어·연구)
src/world/fitting.ts         피팅 V2: 검증, 전력/용량 계산, 인벤토리 이동, 프리셋, ShipFx 산출
src/world/upkeep.ts          운영비 계산·차감·체납 단계(성능 저하)
src/world/market.ts          지역 수급, 수요 상한, 가격 회복 (기존 price/sellAt 대체)
src/world/blueprints.ts      회사별 청사진 원장 (소유/등급/복제 금지)
src/world/research.ts        (확장) 13분야, 연구 자원 비용, 전문 연구소
src/world/migrate.ts         세이브 버전별 마이그레이션 (순수 함수 + 테스트)
scripts/econsim.mjs          8h/24h/다일 경제 장기 시뮬레이션 (헤드리스)
docs/CONTENT_SCHEMA.md · CONTENT_BALANCE.md · CODEX_CONTENT_GUIDE.md
```

기존 `src/sim/data/ships.ts`·`weapons.ts`·`world/industry.ts`의 테이블은 **레지스트리에서 생성되는 호환 뷰**로 남겨 기존 import를 한 번에 깨지 않는다(점진 이전).

### 3.2 함선 정체성 모델

```
Class(역할: 구축함, 순양함, 채굴선 …)
  └─ Hull(제조사/세대가 다른 실제 선체, 고유 메시·하드포인트 배치)
       └─ Variant(구조적 차이만: 하드포인트 교체, 내부 슬롯 증감, 장갑 배분 — 장비를 포함하지 않음)
            └─ Fitting(실제 장착한 장비 인스턴스 = 인벤토리에서 이동)
```

- 산업선(miner/hauler/constructor)은 **Hull의 size = S/M/L/XL** 로 표현. 크기가 조선소 등급·용량·운영비를 결정.
- 전투 엔진에는 `(hullId, variantId, fitting) → ShipSpec` 으로 해석된 결과만 전달 → `world.ts createShip`은 classId 대신 해석된 스펙을 받는 오버로드 추가.

### 3.3 경제 루프

```
수입: 채굴/운송/계약/전투 보상 → 시장 판매(지역 수요 상한·포화)
지출: 운영비(급여·정비·연료·탄약·정박료) + 생산·연구 자원 + 청사진 구매
안정장치: 수요 포화 시 가격 급락 + 시간 회복, 운영비가 함대 규모에 선형 이상으로 증가,
          예비(mothball) 상태로 비용 절감 가능, 체납 시 삭제 없이 단계적 성능 저하
```

### 3.4 UI 원칙 (요구 1-1)
- 모든 실시간 패널은 `morph()` 경로로 갱신, `data-keep`로 사용자 입력 보존.
- 피팅·무기·선체 목록은 공통 **리스트 컴포넌트**(검색·필터·정렬·비교 2열) 하나로 통일.
- 1080p/1440p 두 해상도 스크린샷 검증을 각 UI 단계 완료 조건에 포함.
- 성능: 피팅 미리보기 3D는 기존 `buildShip` 재사용, 리스트 1000행 이하 가상 스크롤 불필요 수준 유지. 컨테이너에 GPU가 없어 **WebGL 성능 수치는 소프트웨어 렌더링 기준**임을 보고서에 명시.

---

## 4. 단계별 개발 계획

각 단계 = 독립 커밋(들) + 테스트 + 세이브 호환 확인 + `GROWTH_PROGRESS.md` 갱신. 운영 반영은 단계 단위.

| 단계 | 내용 | 주요 산출물 | 세이브 영향 |
|---|---|---|---|
| **P0 분석** | 본 문서 | `docs/GROWTH_PLAN.md`, `GROWTH_PROGRESS.md` | 없음 |
| **P1 공통 데이터 모델·마이그레이션** | `src/content` 스키마/레지스트리/검증 골격, 기존 12 함급 → Hull 12 + 기본 Variant, 기존 로드아웃 마운트 → 하드포인트 표로 추출, 기존 테이블은 호환 뷰. `migrate.ts` 프레임워크 | 레지스트리, 검증기 v0, 마이그레이션 테스트 | `WShip`에 `hull`/`variant` 필드 추가(기존 classId로 결정적 매핑), 비파괴 |
| **P2 피팅 V2** | 하드포인트(id/pos/facing/arc/size/type/mount), 내부 슬롯(엔진·리액터·센서·FCS·EW·장갑·특수), 크기·용량·전력 검증, 프리셋, 서버 검증 명령 `fit`, 인벤토리 실이동, 피팅 UI | `fitting.ts`, 피팅 화면 | 기존 `loadoutId`+`fit[]` → 장착 장비 인스턴스로 변환 (장비는 **무상 지급 처리**해 손실 없음) |
| **P3 선체·변형·산업선 크기** | 함급당 2~3 선체, 변형, 산업선 S/M/L/XL, 조선소 등급 연동, 메시 파라미터화(선체별 비율/돌출부) | 콘텐츠 팩, 메시 | 기존 함선은 “표준 선체”로 유지 |
| **P4 운영비·시장 개편** | upkeep(급여/정비/연료/탄약/정박료), 운용/정박/예비 상태, 체납 단계적 저하, 지역 수급·수요 상한·회복, 수입·지출 예측 UI, **econsim 8h/24h/다일** | `upkeep.ts`, `market.ts`, `scripts/econsim.mjs` | 운영 월드에 비용 도입 = 플레이어 체감 변화 → **운영 반영 전 별도 승인** |
| **P5 무기·연구·시설** | 무기 티어(레이저 세대, 코일→레일, 미사일/어뢰, 플라즈마, 입자, PD), 크기×티어 분리, 생산 레시피, 연구 13분야, 전문 연구소·생산시설, 연구 자원 소모 | 콘텐츠 팩 확장 | 기존 기술 진행도 → 새 연구 트리로 매핑(완료된 것은 완료 유지) |
| **P6 청사진** | 소유 원장, 등급(일반/고급/세력/희귀/고유), 연구와 분리, 변형 청사진, 복제 금지 | `blueprints.ts` | 기존 `bp:` 아이템·학습 기술 → 원장 항목으로 이전 |
| **P7 코덱스 가이드·검증기** | 3종 문서 + `npm run content:check` CI화(테스트에 포함) | docs 3종, validator v1 | 없음 |
| **P8 대표 콘텐츠 팩** | 검증기를 통과하는 성장 콘텐츠 일괄 | `packs/growth` | 없음(추가만) |
| **P9 장기 시뮬레이션·밸런스** | 다일 시뮬레이션, 성장 곡선(초반/중반/후반 목표 시간), 무한 자금 검출 | 밸런스 리포트 | 수치 조정만 |

---

## 5. 주요 데이터 규격 (초안)

```ts
type Size = 'S' | 'M' | 'L' | 'XL';
type HpType = 'ballistic' | 'energy' | 'missile' | 'universal' | 'pd';
type Mount = 'fixed' | 'turret' | 'vls' | 'spinal';

interface HardpointDef {
  id: string;                 // 'hp_fwd_1' — 선체 안에서 유일, 세이브에 저장되는 키
  pos: [number, number, number];
  facing: number;             // rad
  arc: number;                // rad, 터렛 사계
  size: Size;
  type: HpType;
  mount: Mount;
}

type InternalKind = 'engine' | 'reactor' | 'sensor' | 'fcs' | 'ew' | 'armor' | 'special';
interface InternalSlotDef { id: string; kind: InternalKind; size: Size; }

interface HullDef {
  id: string;                 // 'dd_lancer'
  classId: string;            // 기존 SHIP_CLASSES id (역할·AI·기본 메시 계열)
  name: string; maker?: string; tier: 1|2|3|4;
  size: Size;                 // 산업선은 S~XL 필수, 전투선은 조선소 등급 산정용
  base: { hp: number; armor: [number,number,number]; maxSpeed: number; accel: number; turnRate: number; lateral: number };
  hardpoints: HardpointDef[];
  internals: InternalSlotDef[];
  capacity: { mass: number; power: number; crew: number; cargo: number };
  build: { yard: 1|2|3|4; time: number; credits: number; parts: Record<string, number> };
  upkeep: { crew: number; maint: number; fuel: number };   // 기준값/시간
  mesh: { base: string; scale: number; params?: Record<string, number> };
  blueprint: BlueprintGrade;
}

interface VariantDef {
  id: string; hull: string; name: string;
  // 구조적 차이만 허용: 하드포인트/내부슬롯 추가·제거·크기 변경, 장갑·질량·전력 소폭 조정
  hardpoints?: { add?: HardpointDef[]; remove?: string[]; resize?: Record<string, Size> };
  internals?:  { add?: InternalSlotDef[]; remove?: string[] };
  mods?: { hpMul?: number; armorMul?: [number,number,number]; massMul?: number; powerMul?: number; speedMul?: number };
  blueprint: BlueprintGrade;
}

interface EquipDef {               // 무기·내부장비 공통
  id: string; name: string; slot: 'hardpoint' | InternalKind;
  size: Size; hpTypes?: HpType[]; mounts?: Mount[];
  tier: 1|2|3|4|5; family?: string;          // 'laser', 'coil', 'rail', 'plasma' …
  mass: number; power: number;               // power<0 = 공급(리액터)
  weapon?: string;                            // 전투 엔진 WEAPONS id
  fx?: FitFx;                                 // 기존 배수 체계 재사용
  build: { recipe: string }; blueprint: BlueprintGrade;
}

interface ShipFitting {            // 세이브에 저장
  hull: string; variant: string;
  hp: Record<string /*hardpointId*/, string /*itemInstanceId|equipId*/>;
  internal: Record<string /*slotId*/, string>;
  preset?: string;
}

interface UpkeepState { mode: 'active' | 'docked' | 'reserve'; arrears: number; stage: 0|1|2|3; }

interface MarketLine { stock: number; target: number; base: number; demand: number; demandCap: number; recover: number; }

type BlueprintGrade = 'common' | 'advanced' | 'faction' | 'rare' | 'unique';
interface BlueprintEntry { id: string; grade: BlueprintGrade; source: 'research'|'purchase'|'loot'|'faction'|'legacy'; at: number; }
// Company.blueprints: Record<blueprintId, BlueprintEntry>  — 키가 곧 소유, 중복 불가

interface ResearchDef {
  id: string; field: ResearchField;            // 13분야
  tier: number; time: number; pre: string[];
  cost: { credits: number; items: Record<string, number> };
  lab: string;                                 // 필요한 전문 연구소 kind
  grants: { blueprints?: string[]; fx?: Partial<FitFx>; unlock?: string[] };
}
type ResearchField =
  'hull' | 'propulsion' | 'power' | 'kinetic' | 'energy' | 'missile' | 'defense' |
  'electronics' | 'industry' | 'resources' | 'logistics' | 'station' | 'tactics';
```

전력·용량 규칙(초안): `Σpower(장착) ≤ Σ리액터 공급`, `Σmass ≤ capacity.mass`, 하드포인트 장비는 `size ≤ hp.size` 그리고 `type ∈ hpTypes`, `mount` 일치. 전력 초과는 **장착 불가(서버 거부)**, 체납·손상으로 인한 공급 저하는 우선순위 낮은 장비부터 비활성.

운영비 단계(초안): 체납 0 → 정상 / 1 → 연구·생산 속도 −25% / 2 → 함선 속도·재장전 −15%, 신규 건조 불가 / 3 → 운용 함선 자동 정박(예비 전환). **함선·장비·자원 삭제 없음.**

---

## 6. 기존 저장 데이터 보존 방안

1. **버전 상승 + 기존 백업 경로 재사용:** 각 세이브 영향 단계에서 `WORLD_VERSION`(또는 신설 `CONTENT_VERSION`)을 올리면 서버가 기존 로직대로 `backup-pre-v<old>`를 먼저 저장한 뒤 마이그레이션. `WORLD_RESET`·세대 펜스·계정 테이블(`siderarium_accounts/sessions`)·`SaveFile.accounts`는 건드리지 않는다.
2. **결정적·비파괴 매핑:** `classId → 기본 hull`, `loadoutId → 기본 variant + 하드포인트별 장착 장비`, `fit[] → 내부 슬롯`. 매핑 불가 항목은 삭제하지 않고 정거장 창고로 반환.
3. **보상 원칙:** 새 시스템이 요구하는 장비·청사진이 기존 함선에 필요하면 `source:'legacy'`로 무상 지급 → 기존 함선 전투력 저하 없음.
4. **센서스 검증:** 마이그레이션 전후로 회사 수, 함선 수, 크레딧 총합, 아이템 총량(장착분 포함), 계정→회사 연결 수를 비교하는 순수 함수 테스트 + 서버 기동 로그.
5. **운영 반영 절차:** ① 운영 세이브 사본을 Supabase에서 읽어 로컬에서 마이그레이션 리허설 → ② 센서스 일치 확인 → ③ 사용자 승인 → ④ 푸시(자동 배포) → ⑤ Render 로그·DB로 버전/센서스 확인. **운영 데이터 변경·파괴적 변경은 매번 별도 승인 요청.**
6. **롤백:** `backup-pre-v<old>` 행을 `main`으로 복원 + 이전 커밋 재배포 (절차를 PROGRESS 문서에 명시).

---

## 7. 단계별 테스트 및 완료 기준

| 단계 | 테스트 | 완료 기준 |
|---|---|---|
| 공통 | `npm test`(vitest), `tsc`, `build:server`, `scripts/mptest.mjs`(계정·멀티 56 체크) | 전부 통과, 기존 테스트 수정 없이 통과(의도된 변경 제외) |
| P1 | 레지스트리 무결성, 마이그레이션 왕복(구 세이브 fixture → 신 세이브), 센서스 동일, 호환 뷰가 기존 값과 일치 | 기존 함선 전투 결과(시드 고정 전투 리플레이) 수치 동일 |
| P2 | 장착 규칙 단위테스트(크기/타입/마운트/전력/질량), 서버 거부 케이스, 인벤토리 보존(장착·해제 시 총량 불변), 타사 함선 피팅 거부, 프리셋 적용 | 브라우저 스크립트로 피팅 → 출격 → 전투 반영 확인, 1080p/1440p 스크린샷 |
| P3 | 선체·변형 검증, 산업선 크기별 조선소 제한, 메시 생성 스모크(모든 선체 buildShip 예외 없음) | 함급당 ≥2 선체, 산업 3종×4크기 |
| P4 | 운영비 계산, 체납 단계 진입/회복, 삭제 없음 확인, 시장 수요 상한·회복, **econsim 8h/24h/72h**: 최적 전략 봇의 크레딧이 시간에 대해 선형 이하, 무한 판매 루프 없음 | 시뮬레이션 리포트를 docs에 첨부, 운영 반영 승인 |
| P5 | 무기 크기×티어 행렬 DPS/사거리 단조성, 연구 트리 순환 없음, 연구 자원 소모 | 검증기 통과, 티어당 상승폭이 BALANCE 범위 내 |
| P6 | 청사진 중복 획득 불가, 연구≠소유 분리, 거래/드랍 경로, 복제 불가 | 원장 마이그레이션 센서스 일치 |
| P7~P8 | `content:check`를 테스트 스위트에 포함, 의도적으로 깨뜨린 팩이 실패하는지 | 대표 팩 전부 통과 |
| P9 | 다일 시뮬레이션, 성장 곡선 목표치 비교 | 밸런스 리포트 승인 |

---

## 8. Opus와 Codex의 작업 경계

| 담당 | 범위 |
|---|---|
| **Opus (구조·시스템)** | 스키마·레지스트리·검증기, 마이그레이션, 서버 권한 검증, 피팅/운영비/시장/청사진/연구 로직, 전투 엔진 연결, 경제 시뮬레이터, UI 프레임(공통 리스트·피팅 화면 골격), 운영 배포·검증, 각 단계 PROGRESS 갱신 |
| **Codex (콘텐츠 작성)** | `docs/CODEX_CONTENT_GUIDE.md` 규칙에 따라 `src/content/packs/*` 의 데이터 파일만 추가·수정 (선체·변형·무기·장비·연구·레시피 수치와 텍스트). 반드시 `npm run content:check` 통과 |
| **경계 규칙** | Codex는 `src/content/packs/**`, `docs/CONTENT_*`(제안) 외 파일을 수정하지 않는다. 새 필드·새 메커니즘이 필요하면 스키마 변경 요청으로 Opus에 넘긴다. 메시 신규 형상은 `mesh.params` 범위 내 조정만, 새 형상 코드는 Opus |

---

## 9. 승인이 필요한 결정 사항

1. 단계 순서(P1→P9) 및 P4(운영비·시장)를 운영 월드에 반영하는 시점.
2. 운영비 체납 단계 페널티 수준(위 초안).
3. 마이그레이션 시 기존 함선 장비 **무상 지급** 원칙.
4. 연구 13분야 목록(§5 `ResearchField`).
5. Codex 작업 범위를 `src/content/packs/**`로 한정.
