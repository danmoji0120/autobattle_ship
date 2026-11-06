# Codex 콘텐츠 제작 가이드 (P2 초안 + P3/P4/P6 보강 + P5/P7 무장·연구·시설 + P8 함선 모델)

> 대상: 함선·변형·프리셋·그래픽 자산을 추가하는 Codex(및 사람) 작업자.
> 필드 정의는 `docs/CONTENT_SCHEMA.md`, 규칙 구현은 `src/content/rules.ts`·`src/content/validate.ts`.
> P5 무장·연구·시설·레시피·품목은 §13~§25 (P7). 처음이면 §13의 예제 팩부터 복사한다.
> 함선 외부 모델(GLB)은 §26~§33 (P8). 참고 팩: `src/content/packs/modeltest/`.
> 이 문서와 코드가 다르면 코드가 맞다.

---

## 0. 역할 분담 — 무엇을 Codex가 하고, 무엇을 요청하는가

| 작업 | 담당 | 비고 |
|---|---|---|
| 기존 선체의 **변형** 추가 (하드포인트 추가·제거, 구조 보정) | Codex | 지금 바로 게임에 반영됨 (피팅 화면의 "구조 변형") |
| **프리셋** 추가 (무장 배치안) | Codex | 피팅 화면의 프리셋 버튼으로 바로 사용 |
| 그래픽 자산 등록 (모델·초상화·아이콘) | Codex | 선체·변형 모델(GLB)은 데이터 등록만으로 전략·전투 화면에 표시된다 (§26~§33). 초상화·아이콘 표시는 아직 등록·검증만 |
| 새 **선체**(hull) 추가 | Codex (데이터) | P3부터 구매(`sale`)·건조(`build`)·운용(`ops`)·운영비(`upkeep`)까지 데이터만으로 동작 (§10) |
| **설계도**(BlueprintDef)와 획득 경로 | Codex (데이터) | 선체마다 선체 설계도 1개 필수, 특수 변형마다 변형 설계도 (§11) |
| 새 **절차적 실루엣**(`mesh.base`) | **엔진(Claude)** | `src/render/shipMesh.ts` + `src/content/meshBases.ts` — 이슈로 요청. 기존 13종 + 함급 실루엣은 자유롭게 사용 |
| 운영비·시장·예산 **규칙**(간접비, 체납 단계, 예산 회복률) | **엔진(Claude)** | 선체별 수치(`upkeep`)만 Codex |
| 기존 장비의 피팅 규격(`equipment.ts`) 조정 | Codex 제안 → 검토 | 밸런스 변경이므로 PR 설명에 근거 필수 |
| 새 **무장**·**내부 모듈**·**연구**·**시설**·**레시피**·**중간재** (P5 데이터) | Codex (데이터) | 팩의 `arms`/`modules`/`techs`/`facilities`/`recipes`/`items` (§13~§25). 엔진 테이블은 직접 고치지 않는다 |
| 새 무장 **계열**(family)·새 전투 효과 키·새 연구 분야 | **엔진(Claude)** | 전투 엔진·검증기 규칙이 함께 바뀌어야 함 — 이슈로 요청 |
| 전투 엔진, 서버 명령, 세이브 마이그레이션 | **엔진(Claude)** | Codex는 손대지 않는다 |
| `*_mk1` 선체의 하드포인트·베이 **삭제·id 변경**, power/mass 축소 | **금지** | 기존 플레이어 함선이 깨진다 (검증기가 막는다) |

## 1. 작업 흐름 (매번 이 순서)

1. `git switch -c content/<짧은-이름>`
2. 팩 폴더를 만든다 (§2). 기존 팩을 고칠 때는 해당 파일만.
3. 데이터를 쓴다 (§3~§6의 예제를 복사해서 시작).
4. 검사: `npm run content:check` → **0 error** 가 될 때까지 고친다. warning은 PR 설명에 이유를 적는다.
5. 전체 확인: `npx tsc --noEmit && npm test`
6. 눈으로 확인 (§8): 피팅 화면에서 변형·프리셋이 보이고, 하드포인트 점이 선체 위에 있는지.
7. PR: 무엇을 왜 추가했는지 + §12 체크리스트 + 스크린샷.

## 2. 팩 만들기

```
src/content/packs/<pack_id>/
  index.ts      ← ContentPack 하나를 export
  assets.ts     ← (자산이 있으면) AssetDef[]
public/assets/content/
  models/ portraits/ icons/   ← 실제 파일
```

`src/content/packs/index.ts`의 `PACKS` 배열 **끝에** 한 줄 추가:

```ts
import { FRONTIER_PACK } from './frontier';
export const PACKS: ContentPack[] = [CORE_PACK, FRONTIER_PACK];
```

- id는 소문자·숫자·`_`, 영문자로 시작. 다른 팩과 겹치면 오류. 접두사로 팩 이름이나 선체 이름을 쓰면 충돌이 없다.
- **공개 후 id 변경·재사용 금지.** 변형·프리셋·하드포인트·베이 id는 플레이어 세이브에 저장된다.

## 3. 변형 추가 (가장 흔한 작업) — 실제로 검증을 통과하는 예제

```ts
// src/content/packs/frontier/index.ts
import type { ContentPack } from '../../schema';

export const FRONTIER_PACK: ContentPack = {
  id: 'frontier', name: '변경 개척 팩',
  variants: [
    { id: 'cruiser_mk1_picket', hull: 'cruiser_mk1', name: '초계형', blueprint: 'common',
      desc: '후방 부포 2문을 걷어내고 상부 방공 포좌를 늘린 초계 개장. 장갑 -5%, 속도 +6%.',
      hardpoints: {
        remove: ['hp12', 'hp13'],
        add: [
          { id: 'pk1', pos: [3, 4.2, -6], facing: 90, arc: 160, size: 'S', type: 'pd', mount: 'turret' },
          { id: 'pk2', pos: [-3, 4.2, -6], facing: -90, arc: 160, size: 'S', type: 'pd', mount: 'turret' },
        ],
      },
      mods: { armorMul: 0.95, speedMul: 1.06 } },
  ],
  presets: [
    { id: 'cruiser_picket_aa', hull: 'cruiser_mk1', variant: 'cruiser_mk1_picket', name: '초계 방공',
      desc: '부포 3 + 방공포 5. 미사일 위협 해역 호위용.',
      weapons: { hp11: 'eq_medium_gun', hp02: 'eq_medium_gun', hp01: 'eq_medium_gun',
                 hp05: 'eq_pd_gun', hp06: 'eq_pd_gun', hp14: 'eq_pd_gun', pk1: 'eq_pd_gun', pk2: 'eq_pd_gun' } },
  ],
};
```

규칙:
- 변형은 **구조만** 바꾼다: 하드포인트·베이 추가/제거, `mods`(hpMul·armorMul·speedMul, 각 0.5~1.5). 무장은 프리셋에서.
- 추가하는 하드포인트·베이 id는 그 선체에 없는 새 id (`pk1`처럼 변형 약어 + 번호 권장).
- `remove`에 쓴 id가 기존 함선에 장착돼 있으면, 플레이어가 그 변형으로 바꿀 때 해당 장비는 보관함으로 돌아간다(손실 없음).
- **트레이드오프 필수:** 모든 수치가 기본형보다 좋은 변형은 금지. 위 예는 방공 +2문 대신 부포 −2문, 장갑 −5%.
- `blueprint`: 지금은 `common`만 플레이어가 선택할 수 있다. `advanced` 이상은 설계도 시스템(P6) 전까지 잠김(서버가 거부, 화면에서 비활성).

### 좌표 잡는 법
- 함선 로컬 좌표: x = 좌현(+)/우현(−), y = 위, z = 함수(+)/함미(−). 단위 = 게임 단위.
- 범위: 선체 중심에서 `길이/2 × scale × 1.25 + 4` 이내 (벗어나면 오류 메시지에 한도가 나온다).
- 기존 하드포인트 좌표(`src/content/packs/core/hulls.ts`)를 기준으로 잡으면 실루엣과 맞는다. 같은 위치·방향에 하드포인트를 두 개 두지 않는다.
- `facing`: 0 = 전방, 90 = 좌현, −90 = 우현, 180 = 후방. `arc` = 좌우 반각(0 < arc ≤ 180).
- `mount`: `turret`(선회) · `fixed`(함 전체로 조준, arc ≤ 45 권장) · `vls`(수직발사) · `spinal`(용골, arc ≤ 15 권장).
- 특정 장비만 더 좁게 선회해야 하면 `arcBy: { eq_rail_cannon: 70 }` (값 ≤ arc).

## 4. 프리셋 추가

- `weapons`: `{ 하드포인트 id: 장비 id }`. 장비 id 목록은 `src/content/packs/core/equipment.ts`.
- 프리셋은 모듈을 정하지 않는다(플레이어가 적용하면 무장만 바뀌고 모듈은 유지).
- 검증기가 확인: 하드포인트 존재 · 크기 · 계열(type) · 마운트 · 전력 · 질량.
- 장착 규칙 요약:

| 하드포인트 type | 받는 장비 |
|---|---|
| `ballistic` | 30mm 기관포, 155mm 부포, 460mm 주포, 레일 캐논 + 방공포 |
| `energy` | 펄스 레이저, 입자 창 + 방공포 |
| `missile` | VLS 미사일, 어뢰 + 방공포 |
| `universal` | 모든 무장 |
| `pd` | 방공포만 |

크기: 장비 크기 ≤ 하드포인트 크기 (S < M < L < XL). 방공포(S)는 크기만 맞으면 어디든.

## 5. 장비 규격 (`equipment.ts`) 읽는 법

| 장비 | 크기 | 질량 | 전력 | 성격 |
|---|---|---|---|---|
| 460mm 주포 | L | 40 | 10 | 무겁고 전력 적음, 고화력·근중거리 |
| 레일 캐논 | L | 32 | 26 | 최장 사거리·관통, 전력 많이 먹음 |
| 입자 창 | L | 30 | 34 | 가볍지만 전력 최대 |
| 155mm 부포 | M | 10 | 4 | 범용 |
| 펄스 레이저 | M | 7 | 10 | 가볍고 전력 소모 큼 |
| VLS 미사일 / 어뢰 | M | 12 / 10 | 2 / 1 | 전력 거의 없음, 마운트 제한 |
| 고출력 반응로 | M 모듈 | 10 | **−20 (공급)** | 전력 여유를 사는 대신 베이 하나·질량 |

- 피팅 한도: Σ전력 ≤ 선체 power + 반응로 공급, Σ질량 ≤ 선체 mass. 선체 수치는 `hulls.ts`.
- 설계 원칙: 무기는 단조 증가가 아니다 — 화력·사거리·관통 / 질량·전력 / 마운트·크기 중 무언가를 내준다.
- 수치를 바꾸는 PR은 "어떤 조합이 새로 가능/불가능해지는지"를 적는다. mk1 선체 호환 검사(§7)가 실패하면 그 변경은 불가.

## 6. 그래픽 자산

1. 파일을 규격 디렉터리에 둔다:

| 종류 | 위치 | 형식 | 한도 | 권장 |
|---|---|---|---|---|
| 선체 모델 | `public/assets/content/models/` | `.glb` | 2 MB | +z 전방, 원점 = 선체 중심, 1단위 = 게임 1단위 |
| 변형 모델 | `models/` | `.glb` | 2 MB | 같은 규격, 변형 하드포인트 위치에 포좌 |
| 초상화 | `portraits/` | `.webp` `.png` | 300 KB | 512×512 |
| 장비·아이템·시설 아이콘 | `icons/` | `.svg` `.webp` `.png` | 64 KB | SVG 우선, 128×128 |

2. 팩의 `assets.ts`에 등록:

```ts
export const FRONTIER_ASSETS: AssetDef[] = [
  { id: 'icon.eq_laser', kind: 'equipment-icon', file: 'icons/eq_laser.svg', for: 'eq_laser', author: 'codex', license: 'CC0' },
  { id: 'model.cruiser_mk1_picket', kind: 'variant-model', file: 'models/cruiser_mk1_picket.glb', for: 'cruiser_mk1_picket', license: 'CC0' },
];
```
   그리고 `index.ts`에 `assets: FRONTIER_ASSETS`, 모델이면 변형의 `model: 'model.cruiser_mk1_picket'`(선체는 `mesh.model`).
3. 등록되지 않은 파일, 등록됐지만 없는 파일, 디렉터리·확장자·용량 위반, 없는 대상(`for`)은 모두 오류. 라이선스 미기재는 경고.
4. **모델의 포좌 위치 = 하드포인트 `pos`.** 게임은 포탑을 하드포인트 좌표에 그린다(서버 전투와 같은 좌표). 모델 쪽 포좌가 어긋나면 포탑이 허공에 뜬다.
5. 선체·변형 모델은 등록하면 게임에 표시된다. 규격·등록·검증·확인 절차는 **§26~§33**을 따른다. 초상화·아이콘은 아직 등록·검증만 된다.

## 7. 검증기가 막는 것 (자주 보는 오류)

| 메시지 | 원인 → 해결 |
|---|---|
| `중복 id` | 다른 팩/같은 팩에 같은 id → 접두사로 구분 |
| `pos ... 가 선체 범위(N) 밖` | 좌표가 선체에서 너무 멂 → 기존 하드포인트 근처로 |
| `하드포인트 id 중복` | 선체+변형 안에서 id 겹침 |
| `크기 초과 — 장비 M, 하드포인트 S` | 장비가 큼 → 작은 장비 또는 하드포인트 size 상향 |
| `실탄 하드포인트에 에너지 무장 불가` | type 불일치 → type을 `universal`로 하거나 장비 교체 |
| `… 마운트에 장착 불가 (가능: …)` | 장비 `mounts`에 없는 마운트 |
| `전력 초과` / `적재 초과` (프리셋) | 무장이 선체 한도를 넘음 |
| `기존 모듈 조합 [...] 이 이 선체에 들어가지 않음` | mk1 선체 호환이 깨짐 → 그 변경은 할 수 없다 |
| `프리셋 무장이 기존 로드아웃과 다름` | core 팩의 기존 프리셋을 고침 → 되돌린다 (기존 함선 전투 결과가 바뀜) |
| `등록되지 않은 파일` / `파일 없음` | §6 등록 누락 |

## 8. 게임에서 확인하기

1. `npm run dev` → 싱글플레이 새 게임.
2. 개발자 콘솔에서 시험용 함선과 장비 준비 (로컬 게임만):
   ```js
   const c = window.siderarium, sim = c.client.t.server.sim, me = c.client.company;
   Object.assign(sim.st.companies[me], { credits: 2e6, rep: 1000 });
   sim.command(me, { c: 'buyShip', station: 'helios', classId: 'cruiser', loadoutId: 'gun' });
   const s = Object.values(sim.st.ships).filter(x => x.owner === me && x.classId === 'cruiser').pop();
   s.task = { k: 'docked', station: 'helios' }; s.state = 'docked';
   c.hud.openFitting(s.id);
   ```
3. 확인: 구조 변형 목록에 새 변형, 프리셋 버튼, 3D 미리보기의 하드포인트 점이 선체 위, 전력·질량 막대, 적용 후 보관함 이동.
4. 스크린샷(1920×1080) 1장을 PR에 첨부.

## 10. 새 선체 추가 (P3) — 데이터만으로 판매·건조·운용

`src/content/packs/growth/hulls.ts`의 `destroyer_vls`(창살급)·`miner_m`(굴착기급)을 복사해서 시작한다. 같은 함급(`classId`) 안에서
**역할이 다른** 선체를 만든다(색만 바꾸거나 크기만 키우지 않는다 — 하드포인트 배치·전력·질량·`stats`·`ops`가 달라야 한다).

```ts
{
  id: 'destroyer_example', classId: 'destroyer', name: '예시급', tier: 2, size: 'M', moduleSlots: 3, power: 40, mass: 70, blueprint: 'advanced',
  mesh: { base: 'dd_vls', scale: 1.0 },                      // 함급 id 또는 meshBases.ts 의 실루엣
  desc: '무엇을 잘하고 무엇을 포기했는지 한 문장씩.',
  stats: { hpMul: 0.9, armorMul: 0.9, speedMul: 1.1 },       // 0.5~1.6
  ops: { cruise: 120, berth: 'M' },                           // 없으면 함급 기본
  build: { yard: 2, time: 6000, credits: 5000, tech: ['guided_missiles'], parts: { structure: 40, armor_plate: 12, engine: 2, reactor: 2, sensor: 2, electronics: 10 } },
  upkeep: { credits: 900, supplies: { chemicals: 3 }, wear: 0.05 },
  sale: { stations: ['helios'], rep: 15, stock: 2, restock: 5400 },   // 공영 판매하지 않으려면 생략. price는 생략 — 생산원가로 자동 산정 (CONTENT_SCHEMA §3.5)
  internals: [...], hardpoints: [...],
}
```
그리고 같은 팩에 변형 `<hull>_std`(필수)와 프리셋 1개 이상, 설계도 `bp_<hull>`(§11)를 넣는다.

**밸런스 규칙 (검증기가 일부를 막고, 나머지는 리뷰에서 본다):**
- 산업선 크기 S/M/L/XL: 큰 선체일수록 척당 처리량은 크지만 **처리량당 가격·운영비는 더 비싸고**, `berth`가 커서 갈 수 있는 정거장이
  줄고, 채굴선은 `minField`로 작은 광맥에서 효율이 절반이다. 큰 선체가 작은 선체를 완전히 대체하면 안 된다.
- 판매 정거장의 정박 등급이 선체 `berth`보다 작으면 검증 오류.
- 전투함 선체는 같은 함급의 mk1과 총 전력(화력×내구)이 비슷한 범위에서 **역할**이 달라야 한다(미사일·방공·중장갑·고속 등).

## 11. 설계도 추가 (P6)

`src/content/packs/growth/blueprints.ts` 참고. 설계도 = 건조 권리(연구와 별개). 완성 함선을 사고파는 데는 필요 없다.
```ts
{ id: 'bp_destroyer_example', name: '예시급 구축함 설계도', desc: '…', grade: 'advanced',
  target: { kind: 'hull', id: 'destroyer_example' },
  sources: [
    { kind: 'commercial', stations: ['helios'], price: 70000, rep: 20, contracts: 3 },   // contracts: 완료 계약 실적 조건
    { kind: 'explore', tier: 2, chance: 0.06 },                                         // 탐사 유적 인양 보상
    { kind: 'salvage', fragments: 6, chance: 0.08 },
  ] }
```
- 등급이 높을수록 경로를 좁고 비싸게: common = `shop`, advanced = `commercial`/`salvage`, faction = `faction`(영향력 조건),
  rare = `contract`/`salvage`/`explore`, unique = `unique`(월드 전체 보유 한도). 상점(`shop`)만으로 고급 설계도를 풀지 말 것 —
  계약 실적·탐사·인양·세력 관계 중 최소 하나를 함께 둔다. 특수 변형은 `needs`로 시설·연구를 추가해 실제 산업 기반 차이를 만든다.
- 비 common 변형은 변형 설계도(`target: { kind: 'variant', id }`)가 있어야 얻을 수 있다(없으면 경고).
- 설계도 id는 세이브에 저장된다. 공개 후 이름 변경·삭제 금지.

## 12. PR 체크리스트

- [ ] `npm run content:check` 0 error (warning이 있으면 이유를 PR에 적음)
- [ ] `npx tsc --noEmit && npm test` 통과
- [ ] 새 id가 기존 id와 겹치지 않고, 기존(공개된) id를 바꾸거나 지우지 않았다
- [ ] `core` 팩의 mk1 선체·기존 프리셋·legacy 매핑을 수정하지 않았다 (수정했다면 엔진 검토 요청)
- [ ] 변형·프리셋마다 트레이드오프가 설명(`desc`)에 드러난다
- [ ] 자산: 등록 + 라이선스 + 용량 + 하드포인트 위치 일치
- [ ] 게임 화면 스크린샷 첨부
- [ ] 새 선체: `_std` 변형 + 프리셋 + 선체 설계도 + `build`가 있고, 산업선이면 크기별 트레이드오프가 `desc`·수치에 드러난다
- [ ] 세이브·서버·전투 엔진 파일(`src/world/*`, `src/sim/*`, `src/server/*`)을 건드리지 않았다


---

# P5/P7 — 무장·연구·시설 콘텐츠 (§13~§25)

> 이 부분은 P5에서 생긴 데이터(무장 계열·티어, 실드, 13개 연구 분야, 전문 시설, 레시피)를
> 팩으로 추가하는 방법이다. 전부 **성장 월드(contentV ≥ 3) 전용**이다. 기존(c0) 월드에는 보이지도
> 쓰이지도 않으며, 이 규칙은 엔진이 지킨다 (§24).

## 13. 예제 팩 — 처음 시작할 때 복사할 것

`src/content/packs/example/index.ts` 는 실제로 게임에 들어가 있는 가장 작은 완결 팩이다.

- 연구 1개 (`twin_emitters`, 에너지 분야, 선행 `optical_lasers`)
- 무장 1개 (`eq_laser_twin`, 레이저 2티어 S, 대소형함, 기존 `energy_fab` 에서 기존 재화로 생산)

이 팩이 거치는 전 과정은 `tests/example-pack.test.ts` 가 매번 검사한다.

1. 검증 통과
2. 게임 테이블 등록
3. c0 월드에서 차단
4. 연구 해금
5. 생산 (실제 재료·시간)
6. 장착 (초계함을 광학 포탑형으로 개장)
7. 전투에서 발사·명중
8. 저장 후 다시 불러와도 유지

새 팩은 이 폴더를 복사한 뒤 다음 순서로 만든다.

1. `cp -r src/content/packs/example src/content/packs/<내팩>` 후 id 를 모두 바꾼다 (§16).
2. `src/content/packs/index.ts` 의 `PACKS` 끝에 한 줄 추가 (**맨 뒤**에 — 앞에 넣으면 안 된다, §16).
3. `npm run content:check` → 0 error.
4. 예제 테스트를 복사해 `tests/<내팩>.test.ts` 로 바꾸고 `npx vitest run tests/<내팩>.test.ts`.
5. 게임에서 확인 (§22).

## 14. 파일 구조

```
src/content/
  schema.ts                ← 모든 데이터 형식 (ArmContent, ModuleContent, TechContent …). 읽기 전용
  registry.ts              ← 팩을 모아 게임 테이블에 설치 (installContent). 엔진 — 수정 금지
  validate.ts              ← 선체·변형·프리셋 검증. 엔진
  validateArsenal.ts       ← P5 검증 (무장·모듈·연구·시설·레시피·품목). 엔진
  packs/
    index.ts               ← PACKS 목록 (팩 추가 = 한 줄)
    core/                  ← 기본 콘텐츠. 수정 금지 (기존 세이브가 의존)
    growth/
      hulls.ts, blueprints.ts      ← P3/P6
      arsenal.ts                   ← P5 본 콘텐츠 (참고용 대형 예시)
      index.ts                     ← GROWTH_PACK, ARSENAL_PACK
    example/index.ts       ← §13 예제
src/world/econConfig.ts    ← 경제 기준선 c4-b1 (가격 배수·조선소 비용). 동결 — P9 전에는 수정 금지
```

팩 하나에는 아래 배열을 원하는 만큼 넣는다. 모두 선택 항목이다.

```ts
export const MY_PACK: ContentPack = {
  id: 'my_pack', name: '…', minContentV: 3,   // P5 데이터가 있으면 반드시 3
  items, arms, modules, techs, facilities, recipes,   // P5
  hulls, variants, presets, blueprints, assets,       // P3/P6 (§3~§11)
};
```

## 15. 스키마 — 필수·선택 필드

정의 원본은 `src/content/schema.ts`.

### ArmContent (무장 = 장비 + 전투 수치 + 생산법을 한 레코드에)

| 필드 | 필수 | 의미 |
|---|---|---|
| `id` | ● | `eq_` 로 시작. 전투 무장 id 는 앞의 `eq_` 를 뗀 것 |
| `name`, `desc` | ● | 화면 표시. desc 에 **장단점**(무엇에 강하고 무엇에 약한지)을 쓴다 |
| `family` | ● | `cannon`, `coil`, `laser`, `plasma`, `particle`, `missile`, `torpedo`, `pd` |
| `tier` | ● | 1~5 (계열 안의 단계) |
| `role` | ● | `anti-small`, `general`, `anti-capital`, `pd` — 전투 AI 표적 선호와 UI 설명 |
| `size` | ● | `S`, `M`, `L` (하드포인트 크기 이하에만 장착) |
| `mass`, `power` | ● | 질량 0~60, 전력 0~80 (선체 공급량에서 빠진다) |
| `mounts` | ○ | `turret`, `fixed`, `vls`, `spinal`. 생략하면 모든 마운트 |
| `tech` | ○ | 생산을 여는 연구. **2티어 이상은 사실상 필수** (없으면 warning) |
| `combat` | ● | 아래 WeaponStats |
| `vis` | ○ | `{ color: '#rrggbb', len, wid, beam? }` 전투 예광·빔 모양 |
| `recipe` | ● | `{ fac: 시설 kind, time: 초, in: {재화: 수량} }` — 산출은 무장 1개 |
| `supply` | ○ | 운용 중 시간당 소모 재화 (실탄·추진제). 에너지 무장은 보통 없음 |

WeaponStats (`combat`)의 필드는 다음과 같다.

- 필수
  - `kind`: 계열이 정한다 — missile→`missile`, torpedo→`torpedo`, pd→`pd`, 나머지→`shell`
  - `damage`, `pen` (관통), `range`, `speed` (탄속), `reload`
  - `salvo`, `salvoGap`, `spread`, `turnSpeed` (포탑 선회, 도/초), `caliber`
- 선택
  - `vsShield`: 실드에 대한 효율. 1 = 그대로, 에너지는 1.2~1.4, 실탄은 0.6~0.8
  - `sound`
  - 미사일·어뢰는 `guidedTurn`, `munitionHp` 필수
  - pd는 `pdChance` 필수

### ModuleContent (내부 모듈)

- 필수
  - `id`: `mod_` 로 시작
  - `slot`: 내부 베이 종류
  - `size`, `mass`
  - `power`: 음수면 전력 **공급** (반응로)
  - `fx`: CombatFx
  - `recipe`
- 선택: `tech`

모듈에는 두 가지 제약이 있다.

- 계열 한정 효과(`fx.family`)를 쓸 수 없다. 그런 효과는 연구로 만든다.
- 실드(`fx.shield`)를 주는 모듈은 반드시 전력을 소모해야 한다.

### TechContent (연구)

| 필드 | 필수 | 의미 |
|---|---|---|
| `id`, `name`, `desc` | ● | |
| `area` | ● | 13개 분야 중 하나 (§17) |
| `field` | ● | 어느 연구소가 연구하는가. 연구소 시설의 `lab` 목록에 있어야 함 |
| `time`, `credits`, `cost` | ● | 시간(초)·자금·재료 — 연구 시작 시 실제로 소모 |
| `pre` | ○ | 선행 연구 id 목록 |
| `needLab` | ○ | 고급 연구: 이 전문 연구소가 정거장에 있어야 함 |
| `unlocks` | ● | 연구 트리에 표시되는 요약 ("무장: … · 레이저 사거리 +8%") |
| `fx` | ○ | 회사 전체 전략 효과 (`buildMul`, `mineMul`, `supplyMul` …) |
| `cfx` | ○ | 전투 효과 (`dmgMul`, `accMul`, `shieldMul` …, 무장 분야는 `family` 지정) |

`fx`·`cfx` 가 없어도 된다. 다만 그때는 그 연구가 무언가를 **해금**해야 한다. 해금 대상은
무장·모듈·시설·레시피의 `tech`, 다른 연구의 `pre`, 변형의 `needs.tech` 중 하나다. 아무것도
하지 않는 연구는 error 다.

### FacilityContent / RecipeContent / ItemContent

- **FacilityContent**
  - 필드는 기존 `FACILITIES` 행과 같다: `kind`, `name`, `cat`, `desc`, `credits`, `mats` (건설 자재), `work`, `power`, `unlocks`
  - 선택 필드
    - `lines`: 생산 라인 수
    - `requires`: 선행 시설
    - `tech`: 건설 연구
    - `lab`: 연구소면 연구 가능한 field 목록
  - 생산·연구·조선·저장 중 아무 역할도 없는 시설은 warning
- **RecipeContent**
  - 필드: `id`, `name`, `fac`, `time`, `in`, `out`, 선택 `tech`
  - 재료 없는 레시피와 같은 재화를 넣어 같은 재화를 만드는 레시피는 error
- **ItemContent** (새 재화)
  - 필드: `id`, `name`, `cat` (`refined`, `part`, `shippart`), `tier`, `price`, `color`, `desc`
  - 만드는 레시피가 없으면 error
  - 어디에도 쓰이지 않으면 warning
  - **새 중간재는 최소화한다.** P5 전체가 `munitions`·`optics` 두 개만 추가했다. 먼저 기존 재화(`alloy`, `electronics`, `weapon_parts`, `precision`, `crystal`, `rare_metal`, `chemicals`, `metal`, `silicon` …)로 만들 수 있는지 본다.

### VariantDef (P5 추가 사항)

- 소형·중형 선체의 에너지 포탑 구조(`corvette_mk1_laser` 등)는 무장 팩(`arsenal.ts`의 `P5_VARIANTS`)에 있다.
- `minContentV: 3` 팩의 변형·프리셋은 자동으로 성장 전용이 된다.
- `needs.tech` 는 성장 월드에서 건조와 **개장(구조 변경)** 둘 다에 적용된다.

## 16. ID와 참조 규칙

- 형식
  - 소문자·숫자·`_` 만 쓴다.
  - 무장은 `eq_…`, 모듈은 `mod_…`.
- id 는 **한 번 배포되면 바꾸지 않는다.** 세이브가 다음을 id 로 저장한다.
  - 연구 목록 `company.tech`
  - 보관함 재화 `storage`
  - 피팅 `fitting.hp`·`fitting.bay`
  - 생산 대기열 `recipe`
- 기존 id 와 겹치면 안 된다. 품목·시설·연구·전투 무장 id 모두 해당하며, 검증기가 충돌을 막는다.
- 모든 참조는 존재해야 한다.
  - `tech`, `pre`, `needLab`
  - `recipe.fac`, `recipe.in`, `supply`
  - 시설의 `requires`
  - 레시피의 `in`·`out`
  - 팩 안의 것이든 기존 테이블의 것이든 상관없다.
- **성장 전용 참조 금지 (c0 팩).** `minContentV` 가 없는 팩이 성장 전용 연구·재화를 참조하면 error 다.
- **팩 순서**
  - `PACKS` 의 **맨 뒤에** 추가한다.
  - 설치는 기존 테이블 뒤에 덧붙이는 방식이라, 기존 조회 결과("첫 번째로 맞는 것")가 바뀌지 않는다.
  - 앞에 끼워 넣으면 기존 월드의 결과가 달라질 수 있다.

## 17. 연구 분야와 효과 — 분야끼리 효과를 겹치지 않는다

13개 분야는 각자 **자기만의 효과 종류**를 가진다. 정의는 `AREA_EFFECTS` (`validateArsenal.ts`)이며,
다른 분야의 효과를 쓰면 error 다.

| 분야 | 전략 효과 `fx` | 전투 효과 `cfx` |
|---|---|---|
| hull 선체 | buildMul | hpMul |
| propulsion 추진 | cruiseMul | speedMul |
| power 동력 | — | shieldRegenMul |
| kinetic 실탄 | — | dmgMul·reloadMul·rangeMul (**family: coil·cannon**) |
| energy 에너지 | — | dmgMul·reloadMul·rangeMul (**family: laser·plasma·particle**) |
| missile 유도 | — | dmgMul·reloadMul·rangeMul (**family: missile·torpedo**) |
| defense 방어 | repairMul | armorMul·shieldMul |
| electronics 전자 | — | accMul·pdMul |
| industry 산업 | prodMul·refineMul | — |
| resource 자원 | mineMul | — |
| logistics 물류 | cargoMul·supplyMul·upkeepMul | — |
| station 정거장 | researchMul·constructMul | — |
| tactics 전술 | skillGain | evasion |

배수 효과의 범위는 0.5~1.5 다. 그 밖의 효과는 다음 상한을 따른다.

- `evasion`: 0.2 이하
- 모듈 `shield`: 0.5 이하
- `shieldRegen`: 0.1 이하

같은 분야 안에서도 같은 효과를 여러 연구가 반복하지 않게 한다. 반복하면 곱해서 커진다. 단계별로
다른 축(사거리 → 연사 → 관통 해금)을 주는 것이 원칙이다.

**연구와 설계도는 별개다.**

- 연구는 생산·건설·개장 **능력**을 연다.
- 설계도(P6, §11)는 특정 선체·변형을 **만들 권리**다.
- 무장·모듈에는 설계도가 없다. 연구 + 시설 + 재료면 만든다.

## 18. 연구·시설·레시피·무장의 연결

```
연구(techs) ──tech──▶ 시설(facilities) ──fac──▶ 레시피/무장 recipe ──in──▶ 재화(items, 기존 재화)
   │  └─pre─▶ 선행 연구                          │
   └─needLab─▶ 전문 연구소 시설 (lab: [field])    └─out─▶ 재화 / 무장·모듈 (보관함 → 피팅)
```

- 연구는 연구소(`lab` 에 그 `field` 가 있는 시설)가 있는 **자사 정거장**에서만 시작된다.
- 시작할 때 `cost` 재료와 `credits` 가 소모된다.
- 무장·모듈은 `recipe.fac` 시설에서 `recipe.in` 재료와 `time` 초를 들여 생산된다.
- 생산하려면 `tech` 연구가 끝나 있어야 한다.
- 만든 장비는 정거장 보관함에 들어가고, 피팅 화면에서 장착한다.
- 공영 정거장에서 사려면 역시 연구가 필요하다.
- 선행 조건은 **의미가 있어야 한다.** 예를 들어 고급 무장은 전문 연구소(`needLab`)를, 실탄 무장은 탄약 공장 재화(`munitions`)를 요구한다.
- 연구 순환(`pre` 가 돌고 도는 것)은 error.

**P5 기본 시설**

| 시설 | 연구 | 만드는 것 |
|---|---|---|
| `ammo_plant` 탄약·미사일 공장 | `missile_fab` | munitions |
| `energy_fab` 에너지 무장 공장 | `optical_lasers` | optics, 레이저·플라즈마·입자·방공 레이저 |
| `weapons_factory` (기존) | — | 코일·레일·미사일·어뢰 |
| `lab_power` 동력·방어 전문 연구소 | `lab_specialization` | 전문 연구 (아래 참고) |
| `lab_ballistics` 실탄·유도 전문 연구소 | `lab_specialization` | 전문 연구 (아래 참고) |
| `lab_energy` 에너지 전문 연구소 | `lab_specialization` | 전문 연구 (아래 참고) |
| `lab_logistics` 물류·정거장 전문 연구소 | `lab_specialization` | 전문 연구 (아래 참고) |

전문 연구소 4종은 `needLab` 으로 지정된 고급 연구를 여는 곳이다.

## 19. 수치 기준 — 기존 콘텐츠와 비교

**전투 지수** `armScore` 는 다음과 같다.

- 식: `(damage × salvo / reload) × √(pen/40) × √(range/1000)`
- 의미: 지속 피해 × 장갑 관통 × 사거리 도달
- 비교 대상은 같은 크기의 **기본(c0) 무장 최고치**다.
  - 현재 기준: S 50, M 150, L 235
  - pd 계열은 비교하지 않는다.
- 판정
  - 기준 × 1.25 초과 → warning. PR 에 근거를 적는다 (높은 전력, 대형 하드포인트, 느린 선회 등).
  - 기준 × 1.6 초과 → **error**.

현재 P5 무장의 지수 (2026-11, 기준선 c4-b1):

| 크기 | 무장 (계열 티어, 역할, 지수, 전력, 선회) |
|---|---|
| S | 적색 레이저 (L1 대소형 22 / 5 / 160) · **쌍열 레이저 예제 (L2 대소형 25 / 8 / 140)** · 코일건 (C1 범용 32 / 3 / 140) |
| M | 청색 (L2 83 / 12 / 95) · 자외선 (L3 124 / 18 / 70) · 속사 코일 (C2 대소형 71 / 6 / 200) · 레일 (C3 대형함 59 / 18 / 30) · 고속·장거리·정밀 미사일 39·40·66 · 어뢰 89 · 플라즈마 60 · 입자 62 |
| L | X선 (L4 152 / 34 / 26) · 감마 (L5 113 / 60 / 10) · 중어뢰 212 · 중플라즈마 164 |

**상위 티어가 모든 면에서 하위 티어를 이기면 error 다.**

- "모든 면"은 다음 일곱 가지다: 지수, 관통, 사거리, 선회, 전력, 질량, 크기.
- 상위 티어는 적어도 하나에서 불리해야 한다. 보통 전력 증가, 선회 저하, 연사 저하, 하드포인트 대형화 중 하나다.
- 그래서 감마선은 X선보다 지수가 낮다. 대신 관통 120으로 전함 장갑을 뚫는다.

역할별 수치 성향은 다음과 같다.

- **anti-small** (대소형함): 선회 ≥ 120, 연사 빠름, 관통 낮음 (≤ 30)
- **anti-capital** (대형함): 관통 높음 (≥ 60), 선회 느림 (≤ 40), 연사 느림
- **general** (범용): 그 사이

계열별 성향은 다음과 같다.

- **에너지**: 실드에 강함 (vsShield ≥ 1.2), 탄약 없음, 전력 큼
- **실탄·플라즈마**: 실드에 약함 (≤ 0.8). 실탄은 `supply` 로 탄약을 소모한다.
- **미사일·어뢰**: 방공에 격추된다 (`munitionHp`). 탄약 소모가 크다.

**생산 난이도**

- `recipe.time` 은 30초~24시간이다.
- 티어가 오를수록 시간과 고급 재화(`optics`, `rare_metal`, `crystal`)를 늘린다.
- 연구 `time`·`credits` 도 티어마다 대략 2배씩 늘린다. `arsenal.ts` 의 레이저 계열이 기준이다 (2400 → 4800 → 9000 → 18000 → 32400 초).

**경제 기준선**

- 함선 가격, 조선소 비용, NPC 재고는 `econConfig.ts` (c4-b1) 에 있다.
- 콘텐츠 작업에서는 바꾸지 않는다. 가격이 문제로 보이면 이슈로 남긴다 (P9).

## 20. 자산 — 무장 그래픽

- 무장 그래픽은 데이터로만 정한다. **모델·텍스처 파일은 필요 없다.**
- 계열(`family`)이 모양을 정한다 (`src/render/shipMesh.ts`, 엔진).
  - 레이저·플라즈마·입자: 돔 포탑 + 집속 포신
  - 코일: 쌍레일
  - 미사일·어뢰: 발사관 상자
  - pd: 소형 돔
- `vis` 는 전투 중 모양을 정한다.
  - 대상: 예광탄·빔의 색 `color` (#rrggbb), 길이 `len` (0~200), 굵기 `wid` (0~4)
  - `beam: true` 면 즉발 광선으로 그린다.
  - 같은 계열 안에서는 티어마다 색을 달리한다. 레이저는 적 → 청 → 보라 → 백 → 녹으로 간다.
  - 수치와 그래픽을 맞춘다. 굵은 빔은 강한 무장에만 쓴다.
- 실드에 맞으면 청색 파문이 그려지고, 관통하면 기존 피격 효과가 나온다. 둘 다 엔진이 그린다.
- 선체 모델·초상화 등 파일 자산은 §6 (glb·png, 경로·크기 규칙)을 따른다.

## 21. 검증 실행

```
npm run -s content:check          # 전체 팩 검증 → "0 error(s)" 가 목표. warning 은 PR 에 사유
npx tsc --noEmit -p .             # 타입
npx vitest run tests/example-pack.test.ts tests/p5.test.ts tests/content.test.ts   # 빠른 확인
npx vitest run                    # 전체 (약 15분)
```

검증기가 하는 일은 다음과 같다.

- **구조**: id, 형식, 범위, 참조
- **수치**: 전투 지수, 티어 압도
- **설계 규칙**
  - 분야별 효과 독점
  - 아무 효과 없는 연구
  - 쓰임 없는 중간재
  - 무에서 생산하는 레시피
  - 실드 모듈 전력
- **c0 보호**: 성장 전용 참조

## 22. 게임에서 확인

1. 로컬 서버: `npm run build && npm start` (클라이언트만 고칠 때는 `npm run dev`). 새 월드는 성장 월드(contentV 4)다.
2. 정거장 탭의 **연구** 화면에서 확인한다.
   - 분야별 열(13개)에 새 연구 카드가 보이는지
   - 선행·전문 연구소 표시가 맞는지
   - 카드를 누르면 "해금:" 목록에 무장이 나오는지
3. 연구가 끝나면 이벤트 로그에 "연구 완료: 쌍열 방출기 — 무장: … (생산 가능: 쌍열 펄스 레이저)" 가 나온다.
4. **생산** 화면에서 확인한다.
   - 해당 시설 아래에 레시피가 보이는지
   - 재료가 표시되는지
   - 진행 막대가 움직이는지
5. **피팅** 화면에서 확인한다.
   - 무장 목록에 계열 배지와 역할이 나오는지
   - 수치 막대(사거리·관통·연사·실드 효율·선회)로 기존 무장과 비교할 수 있는지
   - 소형함은 "구조 변형"에서 **광학 포탑형**을 골라야 에너지 무장을 단다.
6. **전투**에서 확인한다.
   - 예광·빔 색이 `vis` 대로 나오는지
   - 실드가 있는 적에게 파문이 생기는지
7. 접속을 끊었다가 다시 들어와 연구·장비·피팅이 그대로인지 확인한다.

자동 확인으로는 `tests/example-pack.test.ts` 가 저장·재로드를 검사한다. 브라우저 확인 스크립트 예시는 `docs/GROWTH_PROGRESS.md` 의 P5 항목에 있다.

## 23. 고쳐도 되는 파일 / 금지 파일

| 고쳐도 됨 (Codex) | 금지 (엔진·요청) |
|---|---|
| `src/content/packs/<내팩>/**` (새 팩) | `src/content/packs/core/**` — 기존 세이브가 의존 |
| `src/content/packs/index.ts` 의 PACKS 끝에 한 줄 | `src/content/registry.ts`, `validate.ts`, `validateArsenal.ts`, `schema.ts` |
| `tests/<내팩>.test.ts` | `src/world/**`, `src/sim/**`, `server/**` — 규칙·세이브 |
| `docs/` 의 팩 설명 | `src/world/econConfig.ts` — 경제 기준선 동결 (P9 전용) |
| `growth/arsenal.ts` 의 **문구**(desc·unlocks) 수정 | 배포된 id 의 이름 변경·삭제, 기존 무장 수치 하향 (보유 장비가 바뀐다) |
| | `src/render/**` — 새 계열 모양이 필요하면 이슈로 |

기존 무장·연구 수치를 바꾸는 것은 밸런스 변경이다. 이유와 전후 전투 지수를 PR 에 적고 리뷰를 받는다.

## 24. c0(기존 월드) 보호 — 엔진이 보장하는 것

- `minContentV: 3` 팩의 모든 항목(품목·무장·모듈·연구·시설·레시피·변형·프리셋)은 `growthOnly` 로 표시된다.
- c0 월드에서는 다음이 모두 거부되거나 숨겨진다: 연구, 시설 건설, 생산 주문, 장착, 개장, 건조, UI 목록.
- 기본 무장에는 계열 메타데이터(`family`, `tier`, `vsShield`)만 붙는다. 그래서 c0 전투 결과는 그대로다.
  - c0 결정론 해시를 이전 커밋(9a062f9)과 비교해 40분 동일함을 확인했다.
- 팩은 `minContentV` 를 생략하거나 낮추면 안 된다. 그러면 기존 월드에 콘텐츠가 노출된다.

## 25. 오류 진단

| 메시지 (content:check) | 원인 → 해결 |
|---|---|
| `tech "x" 없음` / `선행 연구 "x" 없음` | 오타 또는 의존 팩이 PACKS 에서 뒤에 있음 → id 확인, 팩 순서 확인 |
| `recipe.fac "x" 시설 없음` | 시설 kind 오타 (`energy_fab`, `ammo_plant`, `weapons_factory` …) |
| `laser 계열의 combat.kind 는 "shell"` | 미사일만 `missile`, 어뢰만 `torpedo`, 방공만 `pd` |
| `combat.speed undefined (50–8000)` | 필수 수치 누락 — 예제의 combat 을 통째로 복사해 고친다 |
| `전투 지수 N 가 기존 S 무장 최고치 50 의 1.6배 초과` | 피해·연사 과다 → 줄이거나 더 큰 크기(M/L)로 |
| `laser 2티어가 … 모든 면에서 압도` | 전력·선회·크기 중 하나는 불리하게 |
| `energy 분야는 전투 효과 hpMul 를 쓰지 않음` | 효과를 그 효과의 분야(§17 표)로 옮긴다 |
| `energy 분야는 coil 계열을 다루지 않음` | 실탄 계열 효과는 kinetic 분야 |
| `아무것도 해금하거나 바꾸지 않는 연구` | `fx`/`cfx` 를 주거나 무장·시설의 `tech` 로 연결 |
| `field "x" 를 연구할 수 있는 연구소가 없음` | field 는 power/kinetic/energy/missile/logistics 또는 기존 field |
| `needLab lab_energy 이 field "kinetic" 를 연구하지 않음` | 전문 연구소와 field 를 맞춘다 (§18 표) |
| `이 품목을 만드는 레시피가 없음` | 새 재화에는 생산 레시피가 필요 — 가능하면 기존 재화로 대체 |
| `실드 발생기는 전력을 소모해야 함` | 실드 모듈의 `power` 는 양수 |
| (게임) 무장이 피팅 목록에 없음 | c0 월드이거나 연구 미완료, 또는 하드포인트 종류 불일치 (소형함 실탄 포탑 → 광학 포탑형 변형) |
| (게임) "이 월드에서는 아직 사용할 수 없는 …" | c0 월드 — 정상. 성장 월드에서 확인 |
| (테스트) 결정론 해시 변경 | c0 경로를 건드렸다 — 팩을 PACKS 끝에 두었는지, 기본 무장 수치를 바꾸지 않았는지 확인 |

---

# P8 — 함선 외부 모델 (GLB)

> 외부 모델 파일과 콘텐츠 데이터만 추가하면 함선이 전략 지도·전투·피팅 화면에 모델로 나온다.
> 렌더러·전투 엔진 코드는 고치지 않는다. 참고 구현: `src/content/packs/modeltest/` (dev 선체 2척 + 테스트 모델).

## 26. 모델 규격

| 항목 | 규격 | 검증 |
|---|---|---|
| 형식 | glTF 2.0 바이너리 `.glb` 한 파일. 텍스처는 GLB 안에 포함(embed) | 오류: GLB 아님, 외부 텍스처, 버전 ≠ 2.0 |
| 축 | **+z = 선수**, +y = 위, +x = 좌현(포트). Blender: Forward `+Z`, Up `+Y` 로 내보내기 | 오류: 가장 긴 축이 z 가 아님 / 엔진 마커가 +z 쪽 |
| 단위 | 1 단위 = 게임 1 단위. 길이(z) = `SHIP_CLASSES[classId].length × mesh.scale` (아래 표) | 5% 초과 경고, 25% 초과 오류. 로더가 정확한 길이로 균일 축척 |
| 원점 | 선체 중심 (시뮬레이션이 이동·선회시키는 점). 경계 상자 중심이 원점에서 길이의 10% 이상 벗어나면 경고, 30% 이상 오류 | `recenter: true` 로 로더가 중심을 맞추게 할 수 있다 (하드포인트도 그 기준이 된다는 점 주의) |
| 대칭 | 좌우(x) 대칭이 기본. 비대칭 구조물은 허용하지만 하드포인트 `pos`와 마커는 실제 위치에 둔다 | — |
| 재질 | 최대 8개. 진영색을 받을 재질은 이름을 `sid_hull`·`sid_dark`·`sid_trim`·`sid_accent`·`sid_light` 로 한다. 그 외 재질은 작성한 PBR 그대로 | `sid_accent` 없으면 경고 (진영 색이 안 보임) |
| 텍스처 | 최대 4장. 한 변 S·M 선체 1024, L·XL 2048 px. PNG/JPEG | 오류 |
| 삼각형 | S 6,000 · M 15,000 · L 30,000 · XL 50,000 (본 모델) | 오류. 200 미만은 경고 (최종 자산으로 부족) |
| 파일 크기 | 선체·변형 모델 2 MB, LOD 768 KB | 오류 |
| 압축 확장 | Draco·meshopt·KTX2 **금지** (디코더 미탑재). 허용: `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_emissive_strength` | 오류 |
| 애니메이션·스킨 | 쓰지 않는다 (포탑 회전·엔진 불꽃은 엔진이 그린다) | 경고 |

함급별 목표 길이 (`mesh.scale` = 1 일 때):

| 함급 | 길이 | 함급 | 길이 |
|---|---|---|---|
| corvette | 14 | battlecruiser | 54 |
| frigate | 20 | battleship | 64 |
| destroyer | 24 | dreadnought | 92 |
| light_cruiser | 32 | miner | 30 |
| cruiser | 38 | constructor | 34 |
| hauler | 40 | platform | 40 |

**전투는 모델과 무관하다.** 피격 반경·장갑·하드포인트·속도는 데이터(`SHIP_CLASSES`, HullDef)에서 온다. 모델을 바꿔도 전투 결과는 같다 (`tests/model-pipeline.test.ts` 가 확인).

### 마커 (빈 노드, 계층 어디든)

| 이름 | 위치 | 쓰임 |
|---|---|---|
| `hp_<하드포인트 id>` | 포탑 받침 윗면 중심 (포탑이 올라앉는 점) | 검증기가 HullDef/VariantDef 의 `hardpoints[].pos` 와 비교. 허용 오차 max(0.6, 길이×3%) |
| `engine_<n>` | 노즐 출구 중심. **노드 크기(scale) = 노즐 반지름** | 엔진 불빛·분사 효과 위치. 없으면 절차적 실루엣의 엔진 위치를 쓴다 (경고) |
| `light_<n>` | 항법등 | 점멸등 위치 (선택) |

- 포탑·포신은 모델에 넣지 않는다. 엔진이 하드포인트에 장착 무장의 포탑을 그리고 회전·반동시킨다. 모델에는 **포탑 받침(바벳·스폰슨·받침대)** 만 만든다.
- 받침 윗면 높이 = 하드포인트 `pos[1]`. 받침이 없으면 포탑이 떠 보인다.
- 엔진 노즐은 모델에 만든다. 불빛·분사(진영 색)는 엔진이 마커 위치에 붙인다.
- 피격 불꽃·연기·파괴 시 두 동강(앞뒤 반쪽)은 엔진이 처리한다. 모델은 z = 0 을 기준으로 삼각형 단위로 앞·뒤로 나뉘므로 별도 작업이 없다.

### LOD (선택)

- 별도 GLB(`kind: 'model-lod'`)를 등록하고 본 모델 에셋의 `lod` 에 id 를 적는다.
- 삼각형은 본 모델의 40% 이하, 같은 길이·원점·축. 카메라가 선체 길이 × 14 보다 멀면 LOD 를 그린다.
- 마커는 본 모델의 것을 쓴다 (LOD 에 없어도 된다).

### 충돌 형상과 표시 형상

- 충돌·피격 판정은 데이터의 반지름·길이(구/캡슐)로만 한다. 모델에 충돌 메시를 넣지 않는다.
- 모델을 크게 만들어도 맞기 쉬워지지 않는다. 모델 실루엣은 함급 길이·폭 범위 안에 둔다 (폭은 길이의 15~30%가 기준).

## 27. 품질 기준 (최종 자산)

- 함급·역할이 실루엣으로 구분돼야 한다. 같은 모델의 **색만 바꾸거나 크기만 바꾼 복제는 새 선체로 받지 않는다**.
- 함급 간 크기 차이가 화면에서 분명해야 한다. 목표 길이 표를 지킨다.
- 군함: 포좌·함교·장갑 띠·엔진 블록이 읽혀야 한다. 산업선: 화물창·작업 팔·크레인·탱크 등 용도가 보이는 구조.
- 진영색 재질(`sid_*`)을 선체 면적의 대부분에 쓴다. 고유색(화물 도장·유리 등)은 일부에만.
- 포탑·엔진·실드 파문·피격 효과가 선체에 자연스럽게 붙도록 받침과 노즐을 만든다.
- `models/fixtures/` 의 파일은 **로더 테스트용**이다. 최종 자산의 품질 기준이 아니며 실제 선체에 연결할 수 없다 (검증기 오류).

## 28. 파일 위치·이름·버전

```
public/assets/content/models/<선체 또는 변형 id>.glb          ← 최종 자산
public/assets/content/models/<선체 또는 변형 id>_lod.glb      ← LOD (선택)
public/assets/content/models/fixtures/*.glb                    ← 로더 테스트 전용 (fixture: true, dev 선체만)
```

- 에셋 id: 선체 모델 `model.<hullId>`, 변형 모델 `model.<variantId>`, LOD `lod.<hullId>`.
- **저장 방식: 저장소 안에 최적화된 작은 GLB를 직접 커밋한다.** 각 파일은 `sha256` 으로 버전을 고정한다.
  - 클라이언트는 `?v=<sha 앞 12자>` 를 붙여 받는다. 파일이 바뀌면 브라우저 캐시도 자동으로 갱신된다.
  - 검증기는 파일 내용과 등록된 `sha256` 이 다르면 오류를 낸다 (다른 환경에서 파일이 빠졌거나 바뀐 경우를 잡는다).

| 방식 | 장점 | 단점 | 결정 |
|---|---|---|---|
| 저장소 직접 커밋 (선택) | 모든 환경(클라우드 세션·CI·Render 배포)에서 clone 만으로 존재. 추가 인증·비용 없음. 배포 빌드에 그대로 포함 | 저장소가 커진다 → 파일당 2 MB 한도, 함선 1척 ≈ 0.1~1 MB 목표 | **채택** |
| Git LFS | 저장소 본체가 가벼움 | 클라우드 세션·Render 빌드가 LFS 를 받지 않으면 포인터 파일만 생긴다 (이전에 GLB 가 클라우드에서 빠진 원인과 같은 유형). 대역폭 한도·과금 | 미채택 |
| 외부 객체 저장소 (S3·R2 등) | 저장소 무관, 대용량 | 인증 정보·유료 서비스 필요, 오프라인·로컬 개발에서 파일 없음 | 미채택 (승인 필요 사항) |

- 총량이 커지면(예: 전체 모델 50 MB 초과) 그때 LFS·외부 저장소를 다시 검토한다. 그 경우에도 데이터의 `file`·`sha256` 형식은 그대로 쓸 수 있다.

## 29. 선체·변형에 모델 연결

1. GLB 를 `public/assets/content/models/` 에 둔다.
2. 팩에 에셋을 등록한다. **한 에셋 = 한 줄** 로 쓴다 (`models:hash --write` 가 줄 단위로 고친다):

```ts
export const MY_ASSETS: AssetDef[] = [
  { id: 'model.dd_aegis', kind: 'ship-model', file: 'models/dd_aegis.glb', for: 'dd_aegis', lod: 'lod.dd_aegis', license: 'CC-BY 4.0', author: '작가명', sha256: '' },
  { id: 'lod.dd_aegis', kind: 'model-lod', file: 'models/dd_aegis_lod.glb', for: 'model.dd_aegis', license: 'CC-BY 4.0', author: '작가명', sha256: '' },
];
```

3. 선체에 연결: `mesh: { base: 'destroyer', scale: 1.0, model: 'model.dd_aegis' }`.
   - `base` 는 그대로 둔다. 모델을 받는 중이거나 받지 못했을 때 그리는 **대체 외형**이다.
   - 변형별 모델이면 변형에 `model: 'model.dd_aegis_picket'` (kind `variant-model`, `for` = 변형 id). 변형 모델이 없으면 선체 모델을 쓴다.
4. `npm run models:hash -- --write` → `sha256` 이 채워진다.
5. `npm run -s content:check` → 0 error.

제한:
- **기본(core) 팩의 `*_mk1` 선체에는 모델을 연결할 수 없다** (오류). 기존 월드(c0)의 외형을 바꾸지 않기 위해서다. 새 선체(성장 팩)나 `minContentV: 3` 팩의 변형에 연결한다.
- 성장 팩(contentV ≥ 3) 선체만 모델을 쓰므로, 모델은 새 콘텐츠 버전 월드에서만 보인다.
- `dev: true` 선체는 판매(`sale`)·설계도 없이 둔다. 구매·건조·UI 목록에서 막혀 있고 테스트·미리보기에서만 생성된다.

## 30. 하드포인트 맞추기

1. 모델링 도구에서 포탑 받침 윗면 중심에 빈 노드 `hp_<id>` 를 둔다.
2. 그 좌표(게임 단위, +z 선수)를 HullDef `hardpoints[].pos` 에 그대로 적는다. 변형이 하드포인트를 추가하면 변형 모델에도 마커를 둔다.
3. `content:check` 가 마커와 데이터를 비교한다.
   - 거리 초과: `hp_main1 마커 [x,y,z] 가 하드포인트 데이터 [..] 와 1.20 떨어짐` → 데이터나 모델을 고친다.
   - 마커 없음: 경고. 위치를 확인할 수 없다.
   - 데이터에 없는 마커: 경고.
4. 미리보기(§31)에서 초록 점이 받침 위에 있는지 눈으로 본다.

## 31. 미리보기

```
npm run dev          # 또는 npm run build && npm start
http://localhost:5173/?modelview=<hullId>            # 모델 + 왼쪽에 절차적 대체 외형 비교
  &variant=<variantId>   &preset=<presetId>         # 변형·무장 지정 (기본: 첫 변형·첫 프리셋)
  &team=1                                            # 적(적색) 진영색
  &solo                                              # 모델만
  &models=0                                          # 모델 끄기 (대체 외형 확인)
  &still  &nohp                                      # 회전 정지 · 하드포인트 표시 끄기
```

- 화면 왼쪽 위에 상태(`model` / `loading` / `fallback`), 길이, 하드포인트·장착·엔진 수, 로더 통계가 나온다.
- 초록 점·화살표 = 하드포인트 데이터 위치·방향. 마우스로 회전·확대, `h` 표시 전환, `space` 회전 정지.
- `fallback` 이면 브라우저 콘솔의 `[model] …` 경고에 이유(파일 없음·형식 오류)가 있다.
- 자동 스크린샷: `npm run build` 후 `node scripts/models/check-preview.cjs` (결과 `shots/models/`). 게임 내 전 과정은 `check-game.cjs`.

## 32. 최적화

- 삼각형 한도 안에서 실루엣에 쓰고, 보이지 않는 내부 면은 지운다.
- 같은 재질은 합친다 (로더도 재질별로 합치지만 파일이 작아진다). 재질 4개 이하 권장.
- 텍스처는 1024 이하 JPEG(색)·PNG(마스크). 진영색 재질은 엔진의 패널 텍스처를 쓰므로 텍스처 없이도 된다.
- 압축 확장(Draco 등)은 쓰지 않는다. 대신 정점 수를 줄이고 `KHR_mesh_quantization` 은 써도 된다.
- 원거리용 LOD 를 넣으면 다수 함선 화면에서 부담이 준다.
- 엔진이 보장하는 것: 같은 모델은 한 번만 내려받고(캐시), 모든 함선이 같은 지오메트리를 공유하며, 화면 밖 함선은 그리지 않는다.

## 33. 자동 검증과 게임 내 확인

자동:

```
npm run -s models:hash            # 등록된 모델의 sha256 확인 (DIFF 면 --write 로 갱신)
npm run -s content:check          # 구조·해시·축·길이·원점·마커·예산 검사
npx vitest run tests/model-pipeline.test.ts
```

게임 내 (성장 월드, `?sp=new`):

1. 선체가 판매·건조 가능하면 조선소에서 구입·건조한다. dev 선체는 테스트 스크립트로 생성한다.
2. 전략 지도에서 확인: 모델로 보이는지, 이동·선회, 확대·축소(멀면 LOD).
3. 피팅 화면에서 무장을 바꾸면 포탑이 하드포인트 위치에 바뀌어 붙는지 확인한다.
4. 전투(해적 기지 근처)에서 확인: 포격·피격 효과, 파괴 시 모델이 앞뒤 두 동강.
5. 새로 고침(재접속) 후 같은 모델인지 확인한다.
6. 파일을 막았을 때(`?models=0` 또는 파일 삭제) 함선이 절차적 외형으로 그대로 보이는지 확인한다.

| 증상 | 원인 → 해결 |
|---|---|
| 함선이 옆으로 누워 있다 / 뒤로 간다 | 축 (Forward +Z) — 검증기 "가장 긴 축" / "엔진 마커가 +z" 오류 |
| 함선이 너무 크거나 작다 | 단위 (cm 로 내보냄 등) — "모델 길이 … 목표 …" |
| 포탑이 떠 있다 / 묻혀 있다 | `hp_` 마커·`pos[1]`·받침 높이 불일치 |
| 진영색이 안 보인다 | 재질 이름 `sid_*` 누락 |
| 모델 대신 절차적 외형 | 파일 없음·sha256 불일치·형식 오류 — 콘솔 `[model]` 경고와 `content:check` 확인 |
| "fixture(테스트) 모델을 실제 선체에 연결할 수 없음" | `models/fixtures/` 파일은 dev 선체 전용 |
| "기본(core) 선체 … 에는 모델을 연결하지 않는다" | `*_mk1` 대신 새 선체나 성장 팩 변형에 연결 |

고쳐도 되는 파일은 §23 과 같다. 모델 추가에 `src/render/**`·`src/sim/**` 수정은 필요 없다.
