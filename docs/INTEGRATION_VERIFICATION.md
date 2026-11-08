# 성장·P8·물류 통합 검증

검증일 2026-11-08. 통합 브랜치 `integration/growth-p8-logistics`. 운영 배포·운영 DB 변경·운영 콘텐츠 마이그레이션은 수행하지 않았다.

**최종 판정: Partial.** 기능 검증은 완료했고 성능 악화 없음은 확정하지 못했다. 운영 사본 검증과 실제 GPU·장기 부하는 남아 있다.

## 통합 이력

| 입력 브랜치 | 확인한 원격 커밋 |
|---|---|
| `ccr-f3f46604-1jievd` | `4a19e19bc47ca7ae27d9c97e7f57533232686fe1` |
| `codex/storage-world-analytics` | `f108438be431c81a05fd1687f18723f0b26f1c0f` |
| `codex/logistics-automation-p2` | `92d1fac10ba91e885329e8aaea3c3e26fac1c5cd` |
| `content/p8-first-fleet` | `922029ffd6274dd68cf7436ae0fd2ffab342e403` |

검증 대상 코드·테스트 고정 커밋은 `59eeb12d3f5380d93d7b0f08fb030df65b4f13e7`이다. 이후 변경은 검증 스크립트·자료·문서이며 런타임 `src/`와 GLB `public/`는 병합 커밋과 동일하다.

작업 전 트리는 깨끗했고 입력 SHA가 사용자 지시와 일치했다. 물류 브랜치가 경제 분석 브랜치를 포함함을 조상 검사로 확인했다. `92d1fac`에서 새 통합 브랜치를 만들고 P8을 `--no-ff`로 병합했다. 병합 커밋은 `20ea70c1bda9ff81b6d6f825c0823d1cdc6a7a68`이며 Git 충돌은 없었다. 기존 브랜치와 이력은 수정하거나 삭제하지 않는다.

P8의 다섯 선체·10개 변형·10개 프리셋·6개 설계도·5개 GLB를 유지한다. P3~P7 가격·연구·생산·건설·장비·유지비 데이터와 런타임은 변경하지 않는다. 최종 타입 검사·전체 빌드, 콘텐츠 검사(32선체·48변형·62프리셋·8자산, 오류/경고 0), 등록 모델 해시 8/8은 통과했다.

## 통합 중 확인한 문제

- P8이 기존 연구 2건·조선소 1건에 추가했던 300초 제한을 제거하고 기존 60초로 검증했다. 단일 워커 집중 실행에서 각각 57.725초·40.272초·52.689초로 통과했다. 기대값이나 검증 조건을 낮추지 않았다. 구축함 목록도 기존 4종과 P8 침봉급을 정확히 확인하도록 강화했다.
- 최초 브라우저 저장 비교는 재접속 시 정상 1배속으로 진행된 0.5게임초 때문에 위치·속도·마모가 달랐다. 같은 틱을 새 권위 서버에서 재실행한 결과와 자산·전체 함선 상태·노선을 비교해 일치함을 확인했다. 저장 결함으로 판정하지 않았다. 원래 차이와 실패 기록은 `artifacts/integration/browser-save-diagnostic.json` 등에 보존했다.
- 전투 시험의 관측 코드에서 엔진에 없는 `shotsFired`를 읽는 오류를 확인했다. 실제 누적 값인 `Ship.stats.shots`로 바로잡았으며 전투 결과·HP·파괴를 강제하지 않는다. 이전 시험 실패도 진단 자료로 보존한다.

## 검증 결과

| 검사 | 현재 결과 |
|---|---|
| 집중 검증 | 물류·창고·체납·통계·P8·신규 통합 55개 통과 |
| PostgreSQL | 전용 PostgreSQL 16 테스트 DB에서 5/5 통과. 진행 중 P8 건조·연구·시설 건설·화물·노선·통계를 두 번의 실제 서버 프로세스 재시작 후 비교 |
| 실제 브라우저 | P8 구매·5종 모델·파생형·이동·채굴·판매·산업 공급/출하·관리자 6화면 확인. 전투 포함 실제 플레이 21개 검사 통과. 별도 전략 근접 5종·전술 파괴 잔해 검수 완료 |
| 전체 회귀 | **228개 통과 / 실패 0**, PG 5개는 별도 실행. 28파일 통과·1파일 분리, 1,357.68초(22분 38초). 전체 스위트는 한 번 실행 |
| P8 멀티플레이 | **16/16 통과**. 실제 2계정·2브라우저, P8 GLB·피팅·오프라인 운송·재시작·창고 복구·자원 보존·회사 격리 |
| 기존 멀티플레이 | **67/67 통과**. 실제 10척 교전·동일 관전·지휘 거부·종료·리플레이 포함 |
| 분석 권한 멀티플레이 | **14/14 통과**. 기본 관리자 비활성화·신뢰 UUID만 허용·위조 거부·회사별 전송 제한·시작 자금 중복 없음 |
| c0 결정론 | **30/30 매분 해시 일치**, 두 회사·1,800게임초·통계 활성. 원래 `4a19e19`와 전체 상태 비교, 화폐 대사 0 |
| 성능 | 전후 비교 완료, 악화 없음 확정 불가로 Partial |

## 검증 자산과 운영 사본

테스트에 필요한 회사 자금·시설·연구 조건·추가 함선을 격리된 저장에 준비했다. 다섯 주력 P8 함선은 실제 공영 구매 명령으로 구입했고 추가 제품 운송선 한 척은 시나리오 자산으로 생성했다. 채굴·운송·생산·시장 거래와 자원 소모는 정상 서버 경로를 사용한다. 신규 통합 테스트는 실제 건조/연구 시간을 줄이지 않고 진행 중 상태와 정상 진행을 검증한다. 기존 P8 전용 건조 시험의 완료 가속용 테스트 코드는 그대로 유지하므로 그 시험을 실제 전체 건조 시간 검증으로 표현하지 않는다.

운영 데이터의 읽기 전용 사본이나 연결은 이 작업 환경에 제공되지 않았다. 운영 `gen 1 / c0`는 사용자가 제공한 마지막 상태이며 이번에 직접 조회한 상태가 아니다. 합성 c0 사본의 마이그레이션 dry-run·자산 census·저장 왕복을 검증하며 원본이 바뀌지 않는 것을 확인한다. 운영 사본 검증을 대체했다는 사실을 명시한다. 실제 운영 사본의 dry-run은 운영 적용 검토 전에 별도로 필요하다.

## 성능 비교

`integration-analytics-perf.mjs`는 물류 기준 `92d1fac`과 통합 코드를 별도 프로세스에서 실행했다. 같은 3회사 채굴·시장·임대 월드, 각 활성/비활성 300게임초 예열 후 교대 600게임초 5쌍을 단독 측정했다. 수집 활성/비활성의 게임 전체 JSON은 각 버전 안에서 완전히 일치했다. 버전 간 비교에서는 새 P8 공영 조선소 재고 키 다섯 개만 제외했으며 그 외 상태 해시와 통계 JSON 해시는 모든 쌍에서 동일했다. 원래 전체 상태 해시도 원자료에 남겼다. 사건·수량을 줄이지 않았다.

| 항목 | 물류 기준 `92d1fac` | 통합 코드 |
|---|---:|---:|
| 짝별 추가 CPU 중앙값 | 4.544% | 9.976% |
| 짝별 최소~최대 | −0.893~14.934% | −1.865~16.753% |
| 5쌍 CPU 합계 기준 추가 부하 | 6.366% | 8.123% |
| 수집 활성 CPU 중앙값 / 600게임초 | 6,640.503ms | 7,311.703ms |
| 활성 틱 p95 최대 | 3.365ms | 3.755ms |
| 활성 최악 틱 | 32.473ms | 7.774ms |
| 통계 JSON | 87,904B | 87,904B |
| 누락 행 | 0 | 0 |

**성능 판정 Partial:** 이번 대조에서는 추가 CPU 중앙값이 +5.432%p 높았다. 분산이 크고 과거 9.53%와 측정 조건도 달라, 악화 없음이나 5% 목표 달성을 주장하지 않는다. 통계 코드는 병합 전과 같고 기존 경제/통계 결과도 일치하지만, P8 데이터가 추가된 런타임 비용과 GC/JIT·호스트 변동의 원인을 완전히 분리하지 못했다. 대규모 최적화나 밸런스 변경은 하지 않았다. 운영 적용 검토 전 통제된 호스트에서 비교 재측정·병목 확인이 필요하다. 원자료: [성능 JSON](../artifacts/integration/analytics-performance.json).

## 기존 한계

통계 수집 추가 CPU 중앙값 9.53%는 기존 미완료 항목이다. 이번 통합은 별도 성능 비교로 악화 여부를 확인하고 대규모 최적화로 범위를 확장하지 않는다. P8에는 원거리 전용 LOD가 없고 실제 GPU 대규모 성능과 장기 경제 밸런스는 기존에도 미검증이다. 테스트의 SwiftShader 화면 성능을 실제 GPU 성능으로 주장하지 않는다.


## 실제 화면 및 시험 자료

- [실제 플레이 결과](../artifacts/integration/browser-play-results.json): 구매·파생형·이동·P8 채굴/판매·생산 공급/출하·1440/1024/390 물류 화면·플레이어 분석·관리자 6화면·통화 대사·재로드·실제 전투까지 21개 검사 통과.
- [전략 지도 자오선급](../artifacts/integration/strategic-hauler_meridian.png), [길잡이급](../artifacts/integration/strategic-patrol_pathfinder.png), [침봉급](../artifacts/integration/strategic-destroyer_lancet.png), [석맥급](../artifacts/integration/strategic-miner_quarry.png), [감시자급](../artifacts/integration/strategic-cruiser_vigil.png), [파생형 피팅](../artifacts/integration/p8-fitting-1440.png).
- [전술 사격](../artifacts/integration/p8-battle-fire.png), [피격](../artifacts/integration/p8-battle-hit.png), [자연 파괴 후 모델 잔해](../artifacts/integration/p8-battle-destruction.png). 처음 촬영은 카메라가 이동 중이어서 빈 공간을 담았다. 최종 사진은 실제 투영 좌표가 화면 안에 들어올 때까지 확인하고 추적 카메라를 사용했다. 파괴 애니메이션을 멈추기 전에 실제 GLB 잔해 생성까지 기다렸다. 함선 역할에 따라 초계함은 폭발·파편, 큰 함선은 두 동강 잔해를 쓰는 기존 규칙을 유지했다.
- 시나리오상의 적 전함 5척은 시험 자산이며 전투 HP·스탯·격침을 강제하지 않았다. 군함 3종과 산업선 2종 모두 실제 전술 모델로 로드됐다. 첫 전 과정 시험에서 길잡이 328발·침봉 32발·감시자 20발의 실제 누적 발사를 관측했고 길잡이는 격침, 감시자는 파괴 중이었다.
- [단계별 브라우저 결과 요약](../artifacts/integration/browser-summary.json), [집중 전투 결과](../artifacts/integration/browser-battle-results.json).
- 집중 렌더 검수는 긴 경제 시뮬레이션을 반복하지 않고 `INTEGRATION_UI_PHASE=save`·`battle`로 분리 실행했다. 중간 시험 도구 오류·촬영 대기 실패와 최종 성공은 각각 진단 JSON·로그로 구분한다.

[전체 회귀 JSON](../artifacts/integration/unit-tests.json) · [전체 로그](../artifacts/integration/unit-tests.log) · [PostgreSQL JSON](../artifacts/integration/pg-tests.json) · [GLB 원본/빌드 일치](../artifacts/integration/models.json) · [Git 조상/입력 검증](../artifacts/integration/git-inputs.json)


## 최종 검증 근거

최종 전체 회귀에서도 원래 60초 제한의 연구 역설계·연구 재시작·건조 재시작 검사가 각각 49.523초·37.718초·40.431초로 통과했다. 테스트의 기대값이나 제한을 늘려 실패를 덮지 않았다. 전 테스트는 단일 워커로 한 번 완주했고 PG 전용 5개는 실제 테스트 DB에서 별도로 모두 실행했다.

최종 빌드의 다섯 P8 GLB는 원본과 바이트 단위로 같다. c0 최종 상태 해시는 `baf2897aa5701df971d05d19ba12c85e1c953fa4d774ac074a9273afda6404a4`다. 기존 1차·2차 검증 자료는 덮어쓰지 않았다. 새로운 보고 자료는 `artifacts/integration/`에만 저장했다. 일반 MP·분석 MP는 상대 경로 `data/`와 출력물을 초기화하므로 임시 작업 디렉터리의 빌드 심볼릭 링크로 실행했다.

P8 멀티플레이의 두 수송선은 격리된 시나리오 자산으로 생성했다. 실제 계정·HTTP 쿠키·WebSocket·브라우저·서버 재시작과 운송 명령을 사용했으며 무상 시나리오 함선을 정상 게임 구매라고 표현하지 않는다. 구매·설계도·연구·건조 조건은 별도 P8 시험과 통합 구매 경로에서 확인했다.

[종합 결과](../artifacts/integration/verification.json) · [환경](../artifacts/integration/environment.json) · [타입 검사](../artifacts/integration/typecheck.log) · [빌드](../artifacts/integration/build.log) · [콘텐츠 검사](../artifacts/integration/content-check.log) · [모델 해시](../artifacts/integration/models-hash.log) · [P8 MP](../artifacts/integration/multiplayer-results.json) · [기존 MP](../artifacts/integration/legacy-multiplayer.log) · [분석 권한 MP](../artifacts/integration/analytics-multiplayer-results.json) · [c0](../artifacts/integration/c0-results.json)

## 운영 적용 전 남은 작업

1. 통제된 호스트에서 통계 성능을 재측정하고, P8 데이터가 추가된 비용과 GC/JIT·호스트 변동을 분리한다. 이번 결과로 성능 악화가 없다고 판정할 수 없다.
2. 실제 운영 `gen 1 / c0`의 읽기 전용 사본으로 마이그레이션 dry-run·census·복원을 확인하고 적용·복구 절차를 별도 승인받는다. 이번 합성 저장 검증은 운영 사본 검증을 대신하지 않는다.
3. 실제 GPU의 대규모 함대·장기 월드 부하와 P8 전용 원거리 LOD·P9 밸런스는 별도 검토한다. 이번에 가격·보상·연구/건조 시간·물류 수량 정책을 조정하지 않았다.
4. 구버전 바이너리로 새 저장을 그대로 여는 역호환은 보장하지 않는다. 기존 물류/분석 저장의 개인정보 가림·명세를 아는 호환 백업과 서버 정지·복원 절차가 필요하다.

## 재현

- `npm run typecheck`, `npm run build`, `npm run content:check`, `npm run models:hash`
- `npx vitest run --maxWorkers=1` (PG 5개는 `PG_TEST_URL`이 가리키는 **초기화 가능한 테스트 DB**에서 `npm run test:pg -- --maxWorkers=1`)
- `node scripts/integration-browser.mjs` (Playwright·Chromium 필요). 긴 플레이 뒤 렌더 검수를 분리할 때 `INTEGRATION_UI_PHASE=save` 또는 `battle` 사용.
- `node scripts/integration-multiplayer.mjs`
- `node scripts/integration-analytics-perf.mjs` (다른 무거운 작업과 겹치지 않는 단독 측정)
- `C0_OUTPUT_DIR=artifacts/integration node scripts/verify-c0.mjs`

이번 통합에서 원본 개발 브랜치는 삭제·재작성하지 않았다. GitHub 게시 대상은 새 `integration/growth-p8-logistics` 브랜치 하나이며, 게시 후 원격 SHA 대조 결과는 아래 게시 기록과 완료 메시지에 남긴다.


## GitHub 게시 기록

통합 코드·검증 스크립트·증거·보고서를 포함한 `c8a2be1a35f8ecae96e432e6b6feefcb677ea2d5`를 `origin/integration/growth-p8-logistics`에 새 브랜치로 푸시했고, 실제 `git ls-remote --heads origin`에서 같은 SHA임을 확인했다. [게시된 검증 커밋](https://github.com/danmoji0120/autobattle_ship/commit/c8a2be1a35f8ecae96e432e6b6feefcb677ea2d5) · [최신 통합 브랜치](https://github.com/danmoji0120/autobattle_ship/tree/integration/growth-p8-logistics).

이 게시 기록을 덧붙이는 후속 커밋은 보고 자료만 변경한다. 최종 브랜치 HEAD SHA는 완료 메시지와 원격 브랜치에서 확인할 수 있다. 원래 네 입력 브랜치의 원격 SHA는 변경하지 않았다. PR 병합·기존 브랜치 삭제·강제 푸시·운영 배포·운영 DB 수정은 수행하지 않았다.
