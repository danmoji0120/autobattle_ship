# Codex 콘텐츠 제작 가이드 (P2 초안)

> 대상: 함선·변형·프리셋·그래픽 자산을 추가하는 Codex(및 사람) 작업자.
> 필드 정의는 `docs/CONTENT_SCHEMA.md`, 규칙 구현은 `src/content/rules.ts`·`src/content/validate.ts`.
> 이 문서와 코드가 다르면 코드가 맞다. 최종본은 P7.

---

## 0. 역할 분담 — 무엇을 Codex가 하고, 무엇을 요청하는가

| 작업 | 담당 | 비고 |
|---|---|---|
| 기존 선체의 **변형** 추가 (하드포인트 추가·제거, 구조 보정) | Codex | 지금 바로 게임에 반영됨 (피팅 화면의 "구조 변형") |
| **프리셋** 추가 (무장 배치안) | Codex | 피팅 화면의 프리셋 버튼으로 바로 사용 |
| 그래픽 자산 등록 (모델·초상화·아이콘) | Codex | 등록·검증은 지금, 게임 내 표시(모델 로더)는 P3 |
| 새 **선체**(hull) 추가 | Codex (데이터) | 검증은 지금 통과 가능, 구매·건조 경로는 P3에서 엔진이 연결 |
| 기존 장비의 피팅 규격(`equipment.ts`) 조정 | Codex 제안 → 검토 | 밸런스 변경이므로 PR 설명에 근거 필수 |
| 새 무기·모듈 **종류**, 새 아이템·레시피·연구 | **엔진(Claude)** | `EQUIPMENT`/`WEAPONS`/`RECIPES` 수정이 필요 — 이슈로 요청 |
| 전투 엔진, 서버 명령, 세이브 마이그레이션 | **엔진(Claude)** | Codex는 손대지 않는다 |
| `*_mk1` 선체의 하드포인트·베이 **삭제·id 변경**, power/mass 축소 | **금지** | 기존 플레이어 함선이 깨진다 (검증기가 막는다) |

## 1. 작업 흐름 (매번 이 순서)

1. `git switch -c content/<짧은-이름>`
2. 팩 폴더를 만든다 (§2). 기존 팩을 고칠 때는 해당 파일만.
3. 데이터를 쓴다 (§3~§6의 예제를 복사해서 시작).
4. 검사: `npm run content:check` → **0 error** 가 될 때까지 고친다. warning은 PR 설명에 이유를 적는다.
5. 전체 확인: `npx tsc --noEmit && npm test`
6. 눈으로 확인 (§8): 피팅 화면에서 변형·프리셋이 보이고, 하드포인트 점이 선체 위에 있는지.
7. PR: 무엇을 왜 추가했는지 + §9 체크리스트 + 스크린샷.

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
5. 현재(P2)는 모델·아이콘이 등록·검증만 되고 화면에는 절차적 메시가 쓰인다. 로더는 P3에서 연결된다.

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

## 9. PR 체크리스트

- [ ] `npm run content:check` 0 error (warning이 있으면 이유를 PR에 적음)
- [ ] `npx tsc --noEmit && npm test` 통과
- [ ] 새 id가 기존 id와 겹치지 않고, 기존(공개된) id를 바꾸거나 지우지 않았다
- [ ] `core` 팩의 mk1 선체·기존 프리셋·legacy 매핑을 수정하지 않았다 (수정했다면 엔진 검토 요청)
- [ ] 변형·프리셋마다 트레이드오프가 설명(`desc`)에 드러난다
- [ ] 자산: 등록 + 라이선스 + 용량 + 하드포인트 위치 일치
- [ ] 게임 화면 스크린샷 첨부
- [ ] 세이브·서버·전투 엔진 파일(`src/world/*`, `src/sim/*`, `src/server/*`)을 건드리지 않았다
