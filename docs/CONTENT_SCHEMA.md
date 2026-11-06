# SIDERARIUM 콘텐츠 스키마 (P1 초안)

> 기준 코드: `src/content/schema.ts`. 이 문서와 코드가 다르면 코드가 맞고 문서를 고친다.
> P2에서 장비·내부 슬롯 규격이 추가되고 Codex 제작 가이드(`CODEX_CONTENT_GUIDE.md`) 초안이 나온다. P7에서 최종본.

## 1. 구조

```
ContentPack (src/content/packs/<id>/index.ts)
  hulls[]     HullDef      실제 선체 (외형·하드포인트·내부 슬롯)
  variants[]  VariantDef   선체의 구조적 변형 (장비 미포함)
  presets[]   PresetDef    이름 붙은 무장 배치안
  legacy[]    LegacyLoadoutMap  기존 (classId, loadoutId) → 새 콘텐츠 (core 팩 전용)
  assets[]    AssetDef     그래픽 자산 등록
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
| `internals` | InternalSlotDef[] | `{ id, kind, size }`, kind = `engine`·`reactor`·`sensor`·`fcs`·`ew`·`armor`·`special` (P2부터 사용) |
| `moduleSlots` | 0~12 | 기존 모듈 슬롯 수 (P2에서 internals로 대체) |
| `mesh` | `{ base, scale, model? }` | `base` = 절차적 실루엣 계열(함급 id), `scale` 0.2~5, `model` = 등록된 `ship-model` 에셋 id |
| `blueprint` | BlueprintGrade | |

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

**장착 규칙:** 무기 크기 ≤ 하드포인트 크기. PD 무기는 크기만 맞으면 어느 하드포인트에나, PD 하드포인트는 PD 무기만.
universal은 모든 무기. 그 외에는 계열이 같아야 한다(실탄 = 함포·레일, 에너지 = 레이저·입자, 미사일 = 미사일·어뢰).

## 4. VariantDef

| 필드 | 설명 |
|---|---|
| `id`, `hull`, `name`, `desc`, `blueprint` | |
| `hardpoints?` | `{ add?: HardpointDef[], remove?: string[] }` |
| `internals?` | `{ add?: InternalSlotDef[], remove?: string[] }` |
| `mods?` | `{ hpMul?, armorMul?, speedMul? }`, 각 0.5~1.5 |
| `model?` | 등록된 `variant-model` 에셋 id |

변형은 **구조만** 바꾼다. 무장 배치는 프리셋으로 표현한다. 모든 선체는 변형이 최소 1개(기본형) 있어야 한다.

## 5. PresetDef

| 필드 | 설명 |
|---|---|
| `id`, `hull`, `variant`, `name`, `desc` | `variant`는 `hull`의 변형이어야 함 |
| `weapons` | `{ [하드포인트 id]: 무기 id }`. 무기 id는 `src/sim/data/weapons.ts` (P2부터 장비 id) |
| `costDelta?` | NPC 구매가 차이 |

`{ weapon, arc }` 형태는 기존 데이터를 완전히 똑같이 재현하려고 core 팩에만 쓴 사계 축소 표기다. 새 콘텐츠에서 쓰면 경고가 나온다.

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
| `WorldState` | `contentV`, `grants[]` | 마이그레이션 버전, 지급 원장 |
