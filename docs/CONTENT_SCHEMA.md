# SIDERARIUM 콘텐츠 스키마 (P2 + P3/P4/P6 + P5)

> 기준 코드: `src/content/schema.ts`. 이 문서와 코드가 다르면 코드가 맞고 문서를 고친다.
> P2: 장비 규격(EquipSpec), 내부 베이, 전력·질량, 하드포인트별 무기 사계(`arcBy`), 장비 id 프리셋, 함선 피팅 저장 형식 추가.
> P3/P4/P6 (contentV 3): 선체 운용·건조·유지비·판매 데이터(`ops`·`build`·`upkeep`·`sale`·`stats`), 변형 운용 보정, 설계도(`BlueprintDef`).
> 실제 작업 절차는 `docs/CODEX_CONTENT_GUIDE.md`. P7에서 최종본.

## 1. 구조

```
ContentPack (src/content/packs/<id>/index.ts)
  hulls[]     HullDef      실제 선체 (외형·하드포인트·내부 슬롯)
  variants[]  VariantDef   선체의 구조적 변형 (장비 미포함)
  presets[]   PresetDef    이름 붙은 무장 배치안
  equipment[] EquipSpec    장비의 피팅 규격 (크기·질량·전력·마운트)
  legacy[]    LegacyLoadoutMap  기존 (classId, loadoutId) → 새 콘텐츠 (core 팩 전용)
  assets[]    AssetDef     그래픽 자산 등록
  blueprints[] BlueprintDef 설계도 = 건조 권리와 획득 경로 (growth 팩, §4.7)
```

- 팩은 `src/content/packs/index.ts`의 `PACKS` 배열 순서로 병합된다. 같은 종류 안에서 id가 겹치면 검증 오류.
- 검사: `npm run content:check` (오류가 하나라도 있으면 실패). `npm test`에도 포함되어 있다.
- 좌표: 함선 로컬, x = 좌현(+)/우현(−), y = 위, z = 전방. 각도는 도(°): facing 0 = 전방, 90 = 좌현, −90 = 우현, 180 = 후방. arc = 반각.

## 2. 공통 규칙

| 항목 | 규칙 |
|---|---|
| id | 소문자·숫자·`_`, 영문자로 시작, 2~48자. **공개 후 이름 변경·재사용 금지** (세이브에 저장됨) |
| 하드포인트·슬롯 id | 같은 선체 안에서 유일, 2~24자. 변형이 추가하는 하드포인트는 선체에 없는 새 id |
| Size | `S` < `M` < `L` < `XL` |
| BlueprintGrade | `common` · `advanced` · `faction` · `rare` · `unique` (규칙은 P6) |
| 텍스트 | `name`, `desc` 필수, 한국어 |

## 3. HullDef

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | string | 예: `destroyer_mk1` |
| `classId` | string | 역할·AI·전투 기본값을 주는 `SHIP_CLASSES` id |
| `name` / `desc` | string | 선체 이름(예: `아이기스급`) / 설명 |
| `maker?` | string | 제조사 |
| `tier` | 1~4 | 기술 단계 |
| `size` | Size | 산업선은 S~XL로 크기 구분, 전투선은 조선소 등급 기준 |
| `hardpoints` | HardpointDef[] | §3.1 |
| `internals` | InternalSlotDef[] | 내부 베이 `{ id, kind, size }`, kind = `engine`·`reactor`·`sensor`·`fcs`·`ew`·`armor`·`special`(범용) |
| `moduleSlots` | 0~12 | 기존 모듈 슬롯 수 (참고용, mk1 선체의 기존 호환 기준) |
| `power` | 0~1000 | 기본 전력 공급량. 반응로 모듈이 공급을 더한다 |
| `mass` | 0~3000 | 장비 적재 질량 한도 (무장 + 모듈) |
| `mesh` | `{ base, scale, model? }` | `base` = 절차적 실루엣: 함급 id 또는 `src/content/meshBases.ts`의 전용 실루엣(`dd_vls` 등 13종), `scale` 0.2~5, `model` = 등록된 `ship-model` 에셋 id |
| `blueprint` | BlueprintGrade | |
| `stats?` | `{ hpMul?, armorMul?, speedMul? }` | 함급 기본 전투 수치에 곱함 (0.5~1.6). 변형 `mods`와 곱해진다 |
| `ops?` | HullOps | 운용 수치. 없으면 함급 ECON 그대로 (mk1) — §3.2 |
| `build?` | HullBuild | 건조 조건. mk1이 아닌 선체는 **필수** — §3.3 |
| `upkeep?` | HullUpkeep | 운영비. 없으면 함급 기본값 — §3.4 |
| `sale?` | HullSale | 공영 조선소 판매. 없으면 mk1은 정거장 조선소 목록 기준, 그 외는 판매 안 함 — §3.5 |

### 3.2 HullOps (운용)

| 필드 | 설명 |
|---|---|
| `cruise` | 순항 속도 |
| `cargo` | 화물 용량 |
| `mine` | 채굴 속도 (단위/초) |
| `build` | 건설 속도 배율 (공작선 = 1) |
| `berth` | 필요한 정박 등급 S/M/L/XL. 공영 정거장 등급: 헬리오스·거래소·바스티온 XL, 아스트라·노바·바르카 L, 드레이크·신더·러스트 M. 자사 정거장: 코어 M, 하역시설 1 = L, 2(또는 1 + 대형 조선소) = XL. 등급이 모자란 곳에는 하역·판매·건조 불가 |
| `minField` | 채굴: 최대 매장량이 이보다 작은 광맥에서는 채굴 효율 ×0.5 (대형 채굴선이 작은 광맥을 독점하지 못하게) |

변형 `mods`의 `cargoMul`·`mineMul`·`cruiseMul`·`buildMul`·`upkeepMul`(0.5~1.5)이 곱해진다.

### 3.3 HullBuild (건조)

| 필드 | 설명 |
|---|---|
| `yard` | 조선소 크기 1~4 (소·중·대·초대형) |
| `time` | 건조 시간(초, 조선소 슬롯 하나 점유) |
| `credits` | 공임 (등록 시 지불) |
| `parts` | 부품 `{ ITEMS/EQUIPMENT id: 수량 }`. 프리셋 무장·선택 모듈이 더해진다. 변형의 `parts`도 더해짐 |
| `tech?` | 필요한 연구 (전부) |
| `facilities?` | 건조 정거장에 있어야 하는 시설(FACILITIES kind) |

건조 = 선체 설계도 + (특수 변형이면) 변형 설계도 + 연구 + 조선소 + 시설 + 정박 등급 + 부품 + 시간. **완성된 함선을 사고팔거나
운용하는 데는 설계도·연구가 필요 없다.**

### 3.4 HullUpkeep (운영비, P4)

| 필드 | 설명 |
|---|---|
| `credits` | 시간당 운영비 |
| `supplies?` | 시간당 소모품 `{ 아이템: 수량 }`. 자사 창고 → 본거지 시장(실재고·실가격) 순으로 조달, 재고가 없으면 2배 가격 긴급 조달 |
| `wear?` | 우주에서 이동·채굴하는 시간당 마모(0~1). 마모는 순항·채굴·건설을 최대 −25%까지 늦추고, 수리 시설이 있는 곳에 정박하면 자동 정비된다(비용 = 마모 × 가격 × 12%, 자사 시설 절반) |

규모 간접비(8척 초과 시 척당 +3%, 최대 +60%), L/XL 선체의 공영 정거장 정박료(시간당 250/700), 예비역(운영비 15%, 출항 불가,
재취역 10분·2시간분 비용)은 코드 규칙이다(`src/world/upkeep.ts`).

### 3.5 HullSale (공영 조선소 재고, P6)

| 필드 | 설명 |
|---|---|
| `stations` | 판매 공영 정거장 id. 정거장 정박 등급 ≥ 선체 `berth` (검증기 확인) |
| `price?` | 기준가(생략 권장). 생략하면 **생산원가 기반 자동 산정**(`world/valuation.ts hullPrice`): (부품 가치 + 공임 + 조선소 가동비 + 표준 무장) × 함급 배율(소형 0.42 · 중형 0.85 · 대형 1.25 · 초대형 2) × 설계 등급(일반 1 · 고급 1.12 · 세력 1.25 · 희귀 1.45 · 유일 2). 실제가 = 기준가 × (1.25 − 0.25 × 재고/최대재고) |
| `rep?` | 필요 연합 평판 |
| `stock` | 최대 재고 |
| `restock` | 한 척 보충 시간(초, 성계 보급 상태로 늦어짐). 보충할 때 그 정거장 시장의 벌크 자재를 생산원가 비율로 소모(합금 30% · 전자부품 6%, 중형 이상은 구조재 10% · 장갑판 6%; 시장에 없는 품목은 합금으로), 없으면 멈춤 |

공영 조선소는 **common 변형만** 판다. 특수 변형은 설계도를 얻어 직접 건조한다.

### 3.1 HardpointDef

| 필드 | 설명 |
|---|---|
| `id` | 예: `hp01`, `spine` |
| `pos` | `[x, y, z]`. 선체 중심에서 (선체 길이/2 × scale × 1.25 + 4) 이내 |
| `facing` | −180~180 |
| `arc` | 0 초과 180 이하 |
| `size` | 장착 가능한 최대 무기 크기 |
| `type` | `ballistic` · `energy` · `missile` · `universal` · `pd` |
| `mount` | `turret`(사계 안에서 선회) · `fixed`(함 자체를 돌려 조준, arc ≤ 45 권장) · `vls`(수직 발사) · `spinal`(용골 축, arc ≤ 15 권장) |
| `arcBy?` | `{ [장비 id]: 사계 }` — 특정 장비가 이 하드포인트에서 더 좁게 선회할 때 (0 < 값 ≤ arc). 예: 대형 레일포는 포탑 사계 70° |

**장착 규칙 (서버가 강제, `src/content/rules.ts`):** 장비 크기 ≤ 하드포인트 크기. PD 무기는 크기만 맞으면 어느 하드포인트에나, PD 하드포인트는 PD 무기만.
universal은 모든 무기. 그 외에는 계열이 같아야 한다(실탄 = 함포·레일, 에너지 = 레이저·입자, 미사일 = 미사일·어뢰).
장비에 `mounts`가 있으면 하드포인트의 mount가 그 목록에 있어야 한다. 실제 사계 = min(arc, arcBy[장비]).

**내부 베이 규칙:** 모듈 종류 = 베이 kind (또는 베이가 `special`), 모듈 크기 ≤ 베이 크기.

**전력·질량:** Σ(장비 power ≥ 0) ≤ 선체 power + Σ(반응로 공급), Σ(장비 mass) ≤ 선체 mass. 하나라도 어기면 피팅 적용 불가.

## 4. VariantDef

| 필드 | 설명 |
|---|---|
| `id`, `hull`, `name`, `desc`, `blueprint` | |
| `hardpoints?` | `{ add?: HardpointDef[], remove?: string[] }` |
| `internals?` | `{ add?: InternalSlotDef[], remove?: string[] }` |
| `mods?` | `{ hpMul?, armorMul?, speedMul?, cargoMul?, mineMul?, cruiseMul?, buildMul?, upkeepMul? }`, 각 0.5~1.5 |
| `parts?` | 이 변형을 건조할 때 선체 부품에 더해지는 부품 |
| `needs?` | `{ facilities?: string[]; tech?: string[] }` — 이 변형을 건조할 때 선체 조건에 **추가로** 필요한 정거장 시설·연구 (검증기가 존재 확인) |
| `model?` | 등록된 `variant-model` 에셋 id |

변형은 **구조만** 바꾼다. 무장 배치는 프리셋으로 표현한다. 모든 선체는 변형이 최소 1개(기본형) 있어야 한다.

## 4.7 BlueprintDef (설계도, P6)

설계도는 **건조 권리**다. 연구(기술 지식)와 별개이고, 회사가 보유한다(`Company.blueprints`). 설계도 아이템을 거래하는 것이
아니라 권리를 얻는다. 잔해에서 나오는 **설계 조각**(`bpf:<설계도 id>` 아이템)만 창고에 쌓이고, `fragments`개를 모으면 복원한다.

| 필드 | 설명 |
|---|---|
| `id` | `bp_<대상 id>` 권장 |
| `name`, `desc` | |
| `grade` | BlueprintGrade |
| `target` | `{ kind: 'hull' \| 'variant' \| 'item', id }` — 선체 하나에 선체 설계도 1개(필수), 비 common 변형마다 변형 설계도 |
| `sources` | 획득 경로 배열 (아래) |
| `requires?` | 이 설계도로 건조할 때 추가로 필요한 연구 |
| `runs?` | 제한 횟수 라이선스 (없으면 영구). 다시 사면 횟수 추가 |

| source `kind` | 필드 | 의미 |
|---|---|---|
| `shop` | `stations`, `price` | 일반 판매 |
| `commercial` | `stations`, `price`, `rep`, `contracts?` | 고가 상업 라이선스, 연합 평판 필요. `contracts`: 완료한 계약 수(회사 실적) 이상이어야 판매 |
| `faction` | `faction`, `stations`, `price`, `influence`, `rep?` | 세력 영향력이 `influence` 이상인 성계에서만 판매 |
| `contract` | `minTier`, `chance` | 해당 등급 이상 소굴 토벌 계약 보상(확률) |
| `salvage` | `fragments`, `chance` | 같은 함급 해적 잔해 회수 시 조각(확률), `fragments`개로 복원 |
| `explore` | `tier` (1~3), `chance` | 탐사 지점(유적) 인양 시 통째로 발견(확률, 지점 등급이 높을수록 ↑). 판매되지 않는다 |
| `unique` | `limit`, `minTier` | 월드 전체에서 `limit`개 회사까지만 (선착순 계약 보상) |

설계도 구매 대금의 50%는 그 정거장 구매 예산으로 들어간다. 시작 설계도(`STARTER_BLUEPRINTS`): 기본 초계함·채굴선·수송선·공작선·구축함.

### 4.8 산업 기반 (건조 시설 단계, rev 2)

조선소 크기마다 기본 시설이 누적으로 필요하다 (`hullops.ts TIER_BASE`): 소형 없음 · 중형 함체 가공공장·기계 공장 ·
대형 + 장갑 공장·전자 공장·발전소·격납고 · 초대형 + 엔진·반응로·무기 공장·지원시설. 선체 `build.facilities`와 변형 `needs`가 그 위에 더해진다.

## 4.5 EquipSpec (장비 규격)

장비 자체(이름·가격·연구·전투 효과)는 `src/world/industry.ts`의 `EQUIPMENT`, 피팅 규격은 팩의 `equipment[]`.
모든 `EQUIPMENT`는 규격이 있어야 한다(없으면 검증 오류).

| 필드 | 설명 |
|---|---|
| `id` | `EQUIPMENT` id (예: `eq_laser`, `mod_reactor`) |
| `slot` | `hardpoint`(무장) 또는 내부 베이 kind (`engine`·`reactor`·`sensor`·`fcs`·`ew`·`armor`) |
| `size` | S·M·L·XL |
| `mass` | 0~200 |
| `power` | −200~200. 음수 = 공급(반응로만 허용, 그 외는 경고) |
| `mounts?` | 무장만: 장착 가능한 mount 목록 (없으면 전부) |

## 5. PresetDef

| 필드 | 설명 |
|---|---|
| `id`, `hull`, `variant`, `name`, `desc` | `variant`는 `hull`의 변형이어야 함 |
| `weapons` | `{ [하드포인트 id]: 장비 id }` (예: `"hp01": "eq_heavy_cannon"`). 장착 규칙·전력·질량을 모두 만족해야 함 |
| `costDelta?` | NPC 구매가 차이 |

P1의 `{ weapon, arc }` 표기는 P2에서 없어졌다. 사계 축소는 하드포인트의 `arcBy`로 표현한다.

프리셋은 모듈을 정하지 않는다. 선체 프리셋을 적용하면 무장만 바뀌고 장착 모듈은 유지된다(회사 프리셋은 모듈 포함).

## 6. 그래픽 자산 (AssetDef)

파일은 `public/assets/content/` 아래에 두고, 반드시 팩의 `assets.ts`에 등록한다. 등록되지 않은 파일이나 등록됐지만
없는 파일은 검증 오류다. 페이지에서는 `./assets/content/<file>`로 제공된다(`assetUrl()`).

| kind | 디렉터리 | 확장자 | 용량 한도 | `for` 대상 |
|---|---|---|---|---|
| `ship-model` | `models/` | `.glb` | 2 MB | 선체 id (`HullDef.mesh.model`에서 참조) |
| `variant-model` | `models/` | `.glb` | 2 MB | 변형 id (`VariantDef.model`에서 참조) |
| `portrait` | `portraits/` | `.webp` `.png` | 300 KB | 지휘관 id 또는 `pool:<태그>` (생성 지휘관 풀) |
| `equipment-icon` | `icons/` | `.svg` `.webp` `.png` | 64 KB | `EQUIPMENT` id |
| `item-icon` | `icons/` | `.svg` `.webp` `.png` | 64 KB | `ITEMS` id |
| `facility-icon` | `icons/` | `.svg` `.webp` `.png` | 64 KB | `FACILITIES` kind |

| 필드 | 규칙 |
|---|---|
| `id` | `<접두사>.<이름>`, 예: `model.destroyer_mk2`, `portrait.pool_veteran_03`, `icon.eq_laser` |
| `file` | 소문자 상대 경로, `..`·절대 경로 금지, 한 파일은 한 번만 등록 |
| `author?`, `license?` | 라이선스 미기재 시 경고 |

모델 규격: +z가 함수(전방), 원점 = 선체 중심, 1단위 = 게임 1단위(선체 길이 = `SHIP_CLASSES[classId].length × mesh.scale`),
하드포인트 좌표와 포탑 위치가 일치해야 한다. 초상화 512×512, 아이콘 128×128 권장(SVG 우선).

## 7. 기존 데이터 매핑 (core 팩)

기존 12개 함급 → `<classId>_mk1` 선체 12개, 기본 변형 `<hull>_std` + 구조 보정 로드아웃(전함 요새형) → 변형
`battleship_mk1_fortress`, 25개 로드아웃 → 프리셋 `<classId>_<loadoutId>`. 하드포인트 110개는 로드아웃 마운트의
위치·방향별 합집합에서 추출(`scripts/content-freeze-core.ts`, 1회 생성 후 수동 관리). 검증기는 모든 기존 로드아웃이
같은 무기·위치·방향·사계로 재현되는지 확인한다(전투 결과 불변).

## 8. 세이브에 저장되는 콘텐츠 참조

| 위치 | 필드 | 비고 |
|---|---|---|
| `WShip` | `hull`, `variant` | `contentV ≥ 1`부터. 로드아웃 변경 시 자동 동기화 |
| `ShipBuild` | `hull`, `variant` | 건조 대기열 |
| `WShip` | `fitting` | `contentV ≥ 2`, 플레이어 함선만. `{ hp: {하드포인트→장비}, bay: {베이→모듈}, preset?, sig }` — 무장·모듈의 **원본**. `loadoutId`는 표시용 라벨, `fit`은 베이 모듈 사본 |
| `Company` | `fitPresets[]` | 회사 피팅 프리셋 (최대 20) `{ id, name, hull, variant, hp, bay }` |
| `WorldState` | `contentV`, `grants[]`, `conversions[]` | 마이그레이션 버전, 지급 원장, 형태 변환 원장(기존 아이템이 모양만 바뀐 기록, 지급 아님) |
| `Company` | `blueprints` | `contentV ≥ 3`. `{ 설계도 id: { src, t, runs? } }` |
| `Company` | `upkeep` | `contentV ≥ 3`. 체납·단계·누적 비용·최근 정산 |
| `WShip` | `wear`, `reserve`, `listed` | 마모(0~1), 예비역, 거래소 매물 id |
| `Station` | `funds`, `fundsMax`, `shipStock`, `shipListings` | 공영 정거장 구매 예산, 선체별 재고 `{ n, t, why? }`, 플레이어 함선 매물 |
| `ShipBuild` | `preset` | growth 선체 건조의 무장 프리셋 |
| `WorldState` | `uniques` | 유일 설계도 보유자 |
| `Company` | `tech[]` | P5 연구 id 포함 (성장 월드) |
| `Station.storage` / 생산 대기열 | 재화·무장·모듈 id, 레시피 id | P5 `munitions`·`optics`·`eq_*`·`mod_*` |
| `WShip.fitting` | P5 무장·모듈 id, 광학 포탑형 변형 id | 전투 시 실드·계열 효과는 저장하지 않고 피팅·연구에서 매번 계산 |

**설계도 id·선체 id·변형 id는 세이브에 저장된다.** 이름 변경·삭제 금지.

**하드포인트·베이 id는 세이브에 저장된다.** 공개된 선체의 id를 바꾸거나 지우면 기존 함선 피팅이 깨진다. 대신 새 변형/선체를 추가한다.

## 9. mk1 선체 호환 보장

`ops`·`build`·`upkeep`·`sale`·`stats`가 없는 mk1 선체는 기존 함급 수치(ECON·HULLS)를 그대로 쓴다. contentV 3 미만 월드는
설계도·운영비·예산·재고 규칙이 모두 꺼져 있어 기존과 똑같이 동작한다.


기존 12개 선체(`*_mk1`)는 내부 베이가 모두 `special` M, 개수 = `moduleSlots`. `power`/`mass`는 "기존 프리셋 + 기존에 허용되던 모든 모듈 조합(Σ크기 ≤ 슬롯)" 중 최댓값과 **정확히** 같다.
그래서 기존 함선은 전부 그대로 들어가고, 베이만으로 예전보다 많이 싣지는 못한다(예: 2슬롯 코르벳에 증가 장갑 2개 → 질량 초과).
검증기가 모든 조합을 전수 검사한다. mk1 선체의 power/mass/베이를 줄이면 검증 오류가 난다.


## 10. P5 무장·연구·시설 데이터 (contentV ≥ 3)

`ContentPack` 에 `minContentV: 3` 과 함께 다음 배열을 둔다. 필드 표·수치 기준·오류 진단은
`docs/CODEX_CONTENT_GUIDE.md` §13~§25 에 있다.

| 배열 | 형식 | 설치 위치 (registry.installContent) |
|---|---|---|
| `items` | ItemContent | `ITEMS` |
| `arms` | ArmContent | `EQUIPMENT` (kind weapon) + `WEAPONS` (id = `eq_` 뗀 것) + `RECIPES` (id = 무장 id) + `reg.equipment` 규격 |
| `modules` | ModuleContent | `EQUIPMENT` (kind module, `cfx`) + `RECIPES` + `reg.equipment` |
| `techs` | TechContent | `TECHS` (`area`, `needLab`, `cfx`) |
| `facilities` | FacilityContent | `FACILITIES` |
| `recipes` | RecipeContent | `RECIPES` |
| `variants` / `presets` | VariantDef / PresetDef | 기존과 같음 — 성장 전용으로 표시 |

- 모든 설치 항목에는 `growth: true` 가 붙고, `reg.growthOnly` 에 들어간다. `contentAvail(id, contentV)` 로 판정한다.
- 기존 표의 **뒤에** 덧붙인다 (`??=`). 기존 id 의 행은 덮어쓰지 않는다.
- 기본 무장에는 메타데이터만 붙는다 (`family`, `tier`, `vsShield`). `role` 은 붙이지 않아 c0 표적 선택이 그대로다.
- 기본 연구에는 `area` 만 붙는다 (`CORE_TECH_AREA`).

전투 반영:

- **실드**
  - `ShipFx.shield` 는 선체 HP 대비 비율이다. 실드 모듈 합에 연구 `shieldMul` 을 곱한다.
  - `ShipFx.shieldRegen` 은 초당 회복 비율이다. 피격 후 4초가 지나면 회복한다.
  - 피격 시 실드가 `damage × vsShield` 를 먼저 흡수한다. 남은 비율만큼 선체 피해가 들어간다.
- **계열 효과**: `ShipFx.fam[family] = { dmg, reload, range }`. 해당 분야 연구의 `cfx` 에서 나온다.
- **역할**: 신규 무장은 `role` 로 표적 선호가 정해진다 (`weaponRole`).
- **보급**: `supply` 는 함선 운영비의 보급에 더해진다. 물류 연구의 `supplyMul`·`upkeepMul` 이 곱해진다.
