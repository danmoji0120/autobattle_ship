# 장기 성장 개편 — 진행 상황

설계: `docs/GROWTH_PLAN.md`. 세션이 끊기면 이 문서의 "다음 작업"부터 재개한다.

| 단계 | 상태 | 커밋 | 비고 |
|---|---|---|---|
| P0 분석·계획 | ✅ 승인 (수정 지시 7개 반영) | 78bcb47, P1 커밋 | |
| P1 공통 데이터 모델·마이그레이션 | ✅ 구현·리허설 완료 / ⏸ 운영 적용 승인 대기 | (P1 커밋) | 운영은 dry-run 모드 |
| P2 피팅 V2 (+ Codex 가이드 초안) | ⏳ 다음 | | |
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
- 싱글플레이 브라우저 스모크 통과, `scripts/mptest.mjs` 통과
- UI 변경 없음 (P1은 데이터 모델 단계)

**운영 적용 대기 (승인 필요)**
- 배포 후 운영 로그의 `content migration DRY RUN` 결과를 확인해 보고 → 승인 시 Render 환경 변수 `CONTENT_MIGRATE=apply`
- P2는 운영 적용 여부와 무관하게 진행 가능 (P2 코드도 contentV 0 세이브에서는 기존 방식으로 동작하도록 유지)

## 다음 작업
- P2 피팅 V2: 장비 아이템 인스턴스(`origin`), 내부 슬롯 데이터(core 선체), 장착/해제 서버 명령, 전투 엔진이
  프리셋/피팅 마운트를 사용, 피팅 UI, `CODEX_CONTENT_GUIDE.md` 초안.

## 운영 상태 메모
- 운영 월드: Supabase `bpexsknwmdosdcpsgbmw`, `main` 행 (gen 1), 리셋 백업 `backup-reset-reset-20261105`.
- `WORLD_VERSION=4`, `INDUSTRY_VERSION=2`, `CONTENT_VERSION=1`(운영 미적용, contentV 없음).
- 데이터 롤백 SQL과 코드 롤백 절차: `GROWTH_PLAN.md` §6.3.
