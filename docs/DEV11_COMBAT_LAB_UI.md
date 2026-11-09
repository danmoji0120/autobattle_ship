# DEV-1.1 개발자 전투 실험실 UI

## 범위와 구조

기준은 `codex/dev1-combat-lab`의 `c10a74bc8e2977edb315dbb36cb50f4a58e80524`이다. 기존 `src/ui/setup.ts`와 `src/client/strategic/fittingUi.ts`를 각각 `src/devlab/labSetup.ts`, `src/devlab/labFitting.ts`로 복사해 실험실 전용으로 바꿨다. 두 원본과 기존 공용 CSS, 피팅 규칙, 전투 엔진 및 영속 월드는 수정하지 않는다. 복사본은 기존 3단 편성·지휘 계통·지휘관 카드와 3D 피팅·장착점·장비 카드·능력치 비교를 사용한다. 모바일 겹침을 막는 스타일만 실험실 화면에 한정했다.

편성에는 BLUE/RED 전환·복사·교환, 함선 카탈로그 검색 및 파생형, 수량 추가·복제·이동, 하위 부대 편집, 개별 지휘관 복제·편집·해임, 초기 명령과 후퇴 기준을 연결했다. 1,700포인트 예산과 자산·연구 해금은 적용하지 않지만 두 진영 합계 200척 제한은 유지한다. 상급 부대 변경은 자기 자신과 하위 부대를 제외한다.

피팅은 실제 회사·정거장·서버 명령을 사용하지 않는 임시 초안이다. `variantLayout`, `checkFitting`, `shipLoadout`, `bayModules`, `fitFx`, `growthFx`와 기존 렌더러를 사용한다. 호환성·전력·질량을 검사해 유효한 초안만 적용한다. 실험용 프리셋은 설정 JSON에 포함하고 피팅 클립보드는 실험실 메모리에만 보관한다. 다른 선체에 붙여넣을 때는 대상의 실제 슬롯과 용량을 검사한다. 취소하면 초안을 버린다.

## 데이터와 호환성

새 `siderarium-combat-lab-2`는 진영마다 `LabGroup` 루트와 하위 부대를 갖고 각 부대에 `CommanderDef`, 명령, 후퇴 기준, 수량·피팅을 가진 함선 묶음을 저장한다. 실행할 때 기존 `FleetSpec`·`GroupSpec`·`BattleSetup`으로 바꾸며 AI를 새로 구현하지 않는다. 입력은 트리 깊이, 중복 ID, 함선 수, 피팅 및 콘텐츠 식별자를 검증한다. 진영 복사는 깊은 복사다.

DEV-1 `siderarium-combat-lab-1` 설정은 기존 행 순서대로 루트 바로 아래 부대로 이전한다. 각 행의 이름, 함선, 수량, 피팅, 명령과 양측 지휘관 능력을 보존한다. 예전 루트·각 행의 지휘관과 함선 생성 순서도 보존해 엔진의 난수 순서가 바뀌지 않도록 했다. 결과 JSON은 설정 JSON과 구분해 설정 가져오기에서 거부한다. 기존 모의 전투의 localStorage나 회사 프리셋은 사용하지 않는다.

기존 DEV-1 인증과 15분 세션, Worker, 관전·재시작·리플레이·결과 통계와 시드 재현을 유지한다. 새 화면 코드는 인증이 필요한 `devCombatLab-*` 번들에 들어가며 서버나 PMC 권한을 추가하지 않는다.

## 기준 실험

`artifacts/dev1/default-experiment.json`의 DEV-1 설정을 가져와 시드 1~100, 원래 배치와 교환 배치, 거리 2,900 및 540초 제한의 200전을 다시 실행했다. 길잡이급 149승, 스틸레토급 51승, 무승부 0회로 같았고 각 전투의 결과·시간·통계·결정론 해시도 모두 일치했다. 결과는 `artifacts/dev11/default-experiment.json`, 재실행은 `npx vite-node scripts/dev11-compare.ts`에 있다. 서로 다른 지휘관과 세 단계 부대를 실제 `World`에서 생성하는 별도 표적 검사도 추가했다.

## 검증 및 제한

### 시각 비교

동일한 격리 브라우저에서 원본과 복사본을 각각 촬영했다. 피팅 비교는 같은 길잡이급 선체와 기본 피팅이다. 운영 데이터는 사용하지 않았다.

| 해상도 | 원본 편성 | 실험실 편성 | 원본 피팅 | 실험실 피팅 |
| --- | --- | --- | --- | --- |
| 2560×1440 | [원본](../artifacts/dev11/original-setup-2560.png) | [실험실](../artifacts/dev11/lab-setup-2560.png) | [원본](../artifacts/dev11/original-fitting-2560.png) | [실험실](../artifacts/dev11/lab-fitting-2560.png) |
| 1440×900 | [원본](../artifacts/dev11/original-setup-1440.png) | [실험실](../artifacts/dev11/lab-setup-1440.png) | [원본](../artifacts/dev11/original-fitting-1440.png) | [실험실](../artifacts/dev11/lab-fitting-1440.png) |
| 390×844 | [원본](../artifacts/dev11/original-setup-390.png) | [실험실](../artifacts/dev11/lab-setup-390.png) | [원본](../artifacts/dev11/original-fitting-390.png) | [실험실](../artifacts/dev11/lab-fitting-390.png) |

[다중 계층 편성](../artifacts/dev11/lab-hierarchy-1440.png), [모바일 슬롯](../artifacts/dev11/lab-fitting-slots-390.png), [모바일 장비 카탈로그](../artifacts/dev11/lab-fitting-catalog-390.png)도 기록했다. 원본 인게임 피팅의 390px 스크린샷에는 원래의 열 겹침이 남아 있다. 원본을 변경하지 않는 이번 범위에 따라 실험실 복사본에서만 수정했다.

### 표적 검증과 실패 이력

- 타입 검사와 운영 빌드 통과. 콘텐츠 검사 결과 오류 0개·경고 0개다. DEV-1 인증·전투와 계층형 변환을 포함한 표적 검사 13개가 통과했다.
- 운영 빌드를 일회용 파일 저장소와 계정으로 연 브라우저에서 본 검사 56개와 추가 시각 검사 13개가 통과하고 런타임 오류는 없었다. 원본 예산 제한, 30개 선체, 독립 진영, 부대 이동·순환 방지, 개별 지휘관, 3D 하드포인트 점 선택·드래그, 장비 호환성과 피팅 취소, 프리셋, JSON, Worker, 실제 관전·재시작·리플레이, 관리자·동일 출처·잠금 처리를 포함한다. 결과는 `artifacts/dev11/browser-results.json`, `browser-extra-results.json`이다. 서버에 게임 연결이나 실제 PMC를 만들지 않았다.
- 루프백 전용 일회용 PostgreSQL에서 DEV-1 계정·전용 세션 검사는 1/1 통과했다. 기존 저장 회귀는 첫 실행에서 7/8 통과하고 P8 통합 복원 1개가 실패했다. 종료 전 시뮬레이션이 1틱 진행해 연구 잔여 시간이 1795에서 1794.75로 달라진 경우다. 관련 서버·월드·테스트 코드는 기준과 동일하다. 실패 항목만 기준 커밋의 별도 작업 트리와 현재 코드에서 각각 새 일회용 DB로 재시험했으며 두 실행 모두 통과했다. 기준 코드에서 최초 실패 자체가 다시 재현되지는 않았으므로 이를 확정적으로 기존 실패라고 단정하지 않는다. 최초 실패와 재시험은 각각 `postgres-regression.txt`, `postgres-baseline-target.txt`, `postgres-current-target.txt`에 남겼다.
- 개발 중 입력 포커스를 제거하면서 중첩된 변경 이벤트가 발생하는 오류를 발견해 복사본에서 재진입을 막았다. 초기 비교 실행에서는 소프트웨어 렌더러가 원본 게임의 전체 리소스 로드를 기다리다가 탐색 제한 시간에 걸렸으며, 이후 실제 DOM 준비를 기다리고 실험실 렌더러를 종료한 상태로 재시험했다. 최종 브라우저 실행에서는 두 문제가 재발하지 않았다.
- 테스트 브라우저는 소프트웨어 WebGL을 사용했다. 별도 실제 GPU의 장시간 성능은 측정하지 않았다. 원본 인게임 피팅의 모바일 열 겹침은 이번 변경 금지 범위에 남는다.

### 변경 파일

- 실험 화면·모델: `src/devlab/labSetup.ts`, `labSetup.css`, `labFitting.ts`, `labFitting.css`, `labModel.ts`, `devCombatLab.ts`.
- 검증: `tests/dev1-combat.test.ts`, `tests/dev11-combat.test.ts`, `scripts/dev11-compare.ts`, `scripts/dev11-browser.cjs`, `scripts/dev11-visual.cjs`, `artifacts/dev11/`.
- 설계·결과: `docs/DEV11_COMBAT_LAB_UI.md`.

### 최종 전체 회귀

최종 코드에서 기존 시간 제한을 바꾸지 않고 단일 워커로 한 차례 실행했다. **45개 파일 통과, 2개 파일 건너뜀; 351개 테스트 통과, 0개 실패, 9개 건너뜀**이다 (약 1,172초). 건너뛴 9개는 PostgreSQL 전용이며 위의 격리 DB 실행 및 실패 항목의 재시험에서 별도로 확인했다. 전체 출력은 `artifacts/dev11/full-regression.txt`에 있다.
