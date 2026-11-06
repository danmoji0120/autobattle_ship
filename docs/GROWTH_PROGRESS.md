# 장기 성장 개편 — 진행 상황

설계: `docs/GROWTH_PLAN.md`. 세션이 끊기면 이 문서의 "다음 작업"부터 재개한다.

| 단계 | 상태 | 커밋 | 비고 |
|---|---|---|---|
| P0 분석·계획 | ✅ 승인 (수정 지시 7개 반영) | 78bcb47, P1 커밋 | |
| P1 공통 데이터 모델·마이그레이션 | ✅ 승인 / ⏸ 운영 적용 보류 (사용자 지시) | 31a872b | 운영은 dry-run 모드 |
| P2 피팅 V2 (+ Codex 가이드 초안) | ✅ 구현·리허설 완료 / ⏸ 운영 적용 승인 대기 (P1과 함께 c0→c2) | 04df46d | 운영은 dry-run 모드 |
| P3 선체·변형·산업선 크기 | ⏳ | | |
| P4 운영비·시장 | ⏳ | | 운영 반영 전 별도 승인 |
| P5 무기·연구·시설 | ⏳ | | |
| P6 청사진 | ⏳ | | |
| P7 가이드·검증기 최종 완성 | ⏳ | | |
| P8 대표 콘텐츠 팩 | ⏳ | | |
| P9 장기 시뮬레이션·밸런스 | ⏳ | | |

## P1 결과 (2026-11-06)

**구현**
- `src/content/schema.ts` — Hull / Variant / Hardpoint / InternalSlot / Preset / Asset / Pack 타입
- `src/content/registry.ts` — 팩 병합, `variantLayout`, `presetMounts`, `legacyOf`, `assetUrl`
- `src/content/validate.ts` + `scripts/content-check.ts` (`npm run content:check`) — 참조 무결성, 하드포인트 범위·형식,
  무기 장착 규칙, 변형 구조 보정 범위, 기존 로드아웃 충실도(마운트·구조 보정·비용 완전 일치), 에셋 디렉터리·확장자·
  용량·대상·미등록 파일
- `src/content/packs/core/` — 선체 12, 변형 13, 프리셋 25, 하드포인트 110, 에셋 등록 파일(비어 있음)
- `public/assets/content/{models,portraits,icons}/` — Codex 그래픽 자산 디렉터리
- `src/world/migrate.ts` — `CONTENT_VERSION = 1`, `migrateContent`(멱등, 롤백 후 재적용 보정), `syncShipContent`
  (구매·건조·개조 시 동기화), `census`(장착 무기까지 장비로 집계)·`compareCensus`(이전 + 지급 = 이후), `grants` 원장
- `src/server/node.ts` — `CONTENT_MIGRATE=apply`일 때만 적용(백업 `backup-pre-v<ver>.c<old>`, 기존 백업이 있으면
  `-2` 접미사), 기본값은 운영 세이브 사본 dry-run 로그만. 서버 센서스 검증이 장비 보존까지 확인
- `scripts/rehearse-file.mjs`, `scripts/rehearse-pg.mjs` — 마이그레이션 리허설
- 문서: `docs/CONTENT_SCHEMA.md` 초안, `docs/GROWTH_PLAN.md` 수정본

**테스트**
- `npm test` 105개 통과 (신규 `tests/content.test.ts` 11개), `tsc`, `content:check` 0 오류·0 경고
- 리허설(이전 코드 78bcb47 빌드로 만든 플레이어 3명·함선 162척·건조 대기 1·장비 보관 세이브):
  1. 새 코드 기본 모드 → dry-run 로그 `census OK · round-trip OK`, 파일 변경 없음
  2. `CONTENT_MIGRATE=apply` → 백업 기록·검증, 162척 + 건조 1건 매핑, 지급 0, 센서스 일치
  3. 이전 코드로 롤백 → 마이그레이션된 세이브 정상 로드·저장(필드 보존)
  4. 새 코드 재기동 → 정상
  5. 백업 파일 복원 → dry-run 상태로 복귀
  6. 데이터 롤백 후 재적용 → 새 백업 키 `-2`로 기록 (수정 전에는 서버가 기동 실패하던 문제를 발견·수정)
  7. Postgres: dry-run 무변경 → apply → 운영자 복원 SQL(gen+1) → 실행 중 인스턴스 저장 거부(펜스) 확인 → 재시작 시
     복원 월드 로드 → 이전 코드가 마이그레이션 데이터 위에서 동작
- 싱글플레이 브라우저 스모크 통과, `scripts/mptest.mjs` 55개 통과·실패 0
- UI 변경 없음 (P1은 데이터 모델 단계)

**운영 dry-run 결과 (2026-11-06 00:27 UTC, 배포 31a872b)**
- `content migration DRY RUN c0→c1: ships 154 · builds 0 · unmapped 0 · granted 0 · census OK · round-trip OK — 적용하지 않음`
- 서버 센서스: 플레이어 3, 크레딧 796,387, 플레이어 함선 19, 장비(장착 무기) pd 44 · 155mm 3 · 기관포 24 — 운영 월드는 변경되지 않음

**운영 적용 대기 (승인 필요)**
- 승인 시 Render 환경 변수 `CONTENT_MIGRATE=apply` 설정 → 재배포 → 백업 행 `backup-pre-v4.2.c0` 확인
- P2는 운영 적용 여부와 무관하게 진행 가능 (P2 코드도 contentV 0 세이브에서는 기존 방식으로 동작하도록 유지)

## P2 결과 (2026-11-06)

**구현**
- 장비 규격 `src/content/packs/core/equipment.ts` (EquipSpec: 크기·질량·전력·마운트 18종), 선체 `power`/`mass`,
  mk1 선체 내부 베이(범용 M × 기존 슬롯 수), 하드포인트 `arcBy`(기존 사계 축소 13건 이전), 프리셋 = 장비 id
- `src/content/rules.ts` — 장착 규칙(크기·계열·PD·마운트·베이 종류·전력·질량)을 검증기·서버·UI가 공유
- `src/world/fitting.ts` — `checkFitting`, `fittingFromLegacy`, `placeModules`, `shipLoadout`(전투·렌더 공용 마운트),
  `itemDelta`, `normFitting`(클라이언트 입력 정화)
- 서버 명령(`src/world/sim.ts`): `fit`(변형·하드포인트·베이, 전부 아니면 전무, 빠진 장비는 보관함으로, 공용 정거장만
  1.2배 구매·수수료, 연구 안 된 장비 구매 불가, 비 common 변형 잠금), `savePreset`/`delPreset`(회사 프리셋 20개),
  기존 `refit`/`fitShip`은 V2 함선에서 같은 경로로 변환. contentV < 2(현재 운영)는 기존 경로 그대로
- 전투 엔진: `ShipSpec.fit` → 함선이 실제 장착 마운트로 생성. 바뀌지 않은 기존 프리셋은 **기존 마운트 순서**를 유지
  (순서가 전투 난수에 영향 — 25개 중 3개 프리셋에서 확인, 순서 유지로 완전 동일)
- 렌더러: 전략 지도·전투 화면 모두 `shipLoadout`의 마운트 좌표에 포탑을 그림
- 마이그레이션 `CONTENT_VERSION = 2`: 플레이어 함선에 피팅 생성, 장착 무기·모듈을 **변환 원장 `st.conversions`**로
  기록(지급 아님), 베이가 없는 모듈은 보관함으로(`returned`), `fitting.sig`로 이전 코드가 바꾼 함선을 재기동 시 재구성
- mk1 호환 보장: power/mass = 기존 프리셋 + 기존 허용 모듈 조합(Σ크기 ≤ 슬롯)의 최댓값과 정확히 일치 → 기존 함선은 모두
  들어가고 예전보다 더 싣지 못함. 검증기가 전수 검사
- 피팅 화면 `src/client/strategic/fittingUi.ts`: 3D 미리보기(하드포인트 마커, 클릭 선택), 하드포인트·베이 목록,
  전력·질량 막대, 장비 검색·호환 필터·정렬(화력·사거리·질량·전력·보유), 현재 장비 대비 증감, 함선 전투 수치 비교,
  선체·회사 프리셋, 되돌리기·초기화, 변경 요약(장착·해제·부족·비용), morph 갱신으로 입력 유지
- 문서: `docs/CODEX_CONTENT_GUIDE.md` 초안(작업 흐름·예제 팩·좌표·자산·오류표·체크리스트, 예제는 테스트로 검증),
  `docs/CONTENT_SCHEMA.md` P2 갱신, `GROWTH_PLAN.md` §5·§6 결정 반영(인스턴스 대신 변환 원장)

**테스트**
- `npm test` 126개 (신규 `tests/fitting.test.ts` 20개 + 가이드 예제 1개), `tsc`, `content:check` 0·0
  - 보존: 6회 장착/해제 반복 총량 불변, 실패 시 상태·크레딧 불변, 두 함선이 한 아이템 공유 불가
  - 서버 거부: 크기·계열·PD·무장/모듈 혼동·없는 슬롯·없는 장비·타 선체 변형·마운트·전력·질량·타사·미정박·프로토타입 키
  - 전투: 25개 프리셋 피팅 = 기존 로드아웃 (함선 수치·마운트 순서·전투 다이제스트 동일), 사용자 피팅은 무장 변경 반영
  - 렌더: 3D 모델 포탑 좌표 = 피팅 하드포인트 좌표
  - 마이그레이션: v1→v2 보존·변환 원장·멱등·왕복, 베이 없는 모듈 보관함 반환, dry-run 무변경, 롤백 후 재구성
- `scripts/mptest.mjs`: 검사 수 고정 가드 `EXPECTED = 61` 추가(분기 누락 시 실패), WebSocket 피팅 검사 6개
- 리허설(이전 코드 세이브, 플레이어 3·함선 162·건조 1): dry-run c0→c2 무변경 → apply(백업·피팅 22척·변환 99개·지급 0·
  센서스 일치) → P1 코드로 롤백(정상 로드·저장) → P2 재기동 → 백업 복원(c0 복귀) → 재적용 정상
- 브라우저: 1920×1080·2560×1440 피팅 화면 확인, 초안→적용→보관함 이동 확인
- mptest 61 PASS / 0 FAIL (61/61 실행), vitest 126 통과, tsc·content:check 0/0
- 운영 사본 dry-run (04df46d 배포 부팅, 메모리 상 사본, 쓰기 없음): `c0→c2: ships 148 · builds 0 · fitted 19 ·
  converted 71 items · returned 0 · unmapped 0 · granted 0 · census OK · round-trip OK` — 운영 contentV 0 유지
- 운영 DB 읽기 전용 확인 (2026-11-06 02:00 UTC, Supabase `main` 행, eb512f2 가동 중): gen 1 유지, `contentV` 없음(=0),
  `fitting`이 붙은 함선 0척, `conversions` 없음 → 마이그레이션 미적용. 플레이어 회사 3곳·플레이어 함선 19척(6·5·8)으로
  dry-run 집계와 일치, 정상 저장 계속(updated 01:59). 백업 행 `backup-pre-v4.0`·`backup-reset-reset-20261105` 보존.

**55 → 56 표기 확인:** mptest의 `ok()` 호출은 1adbc5e 이후 55개였고 P1 실행도 55 PASS였다. 이전 보고의 56은 집계
오기이며 누락된 검사는 없다. 재발 방지로 실행 수 가드를 넣었다.

## 다음 작업
- (승인 시) 운영 c0→c2 적용: 운영 사본 dry-run 로그 확인 → Supabase 백업 행 확인 → `CONTENT_MIGRATE=apply`.
- P3 선체·변형·산업선 크기: 새 선체 구매·건조 경로, 타입 베이 선체, 모델 로더.

## 운영 상태 메모
- 운영 월드: Supabase `bpexsknwmdosdcpsgbmw`, `main` 행 (gen 1), 리셋 백업 `backup-reset-reset-20261105`.
- `WORLD_VERSION=4`, `INDUSTRY_VERSION=2`, `CONTENT_VERSION=2`(운영 미적용, contentV 없음 = 0).
- 데이터 롤백 SQL과 코드 롤백 절차: `GROWTH_PLAN.md` §6.3.
