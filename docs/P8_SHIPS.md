# P8 정식 함선 1차 시험

성장 월드(contentV 3 이상)용 선체 다섯 종이다. 기존 `arsenal` 콘텐츠 팩의 뒤에 등록했으며, 원래 선체와 장비 데이터는 수정하지 않았다. 각 선체는 별도 GLB와 표준형·파생형·프리셋·선체 설계도를 갖는다. 감시자급 지휘형에는 별도 변형 설계도가 필요하다. 공영 조선소는 완성 함선을 판매하며, 자사 건조에는 설계도 외에도 표에 적힌 연구와 선체별 시설·부품·조선소가 필요하다.

| 선체 | 설계와 표준 무장 | 파생형과 절충 | 건조 연구 |
|---|---|---|---|
| 길잡이급 초계함 | 낮은 쐐기 선체, 전방·양현 기관포와 후방 방공포, 쌍 추진기 | 정찰형: 방공포를 센서 베이로 교환, 속도 증가·내구 감소 | 없음 |
| 침봉급 미사일 구축함 | 중앙 VLS 4기, 선수 부포, 함미 양현 방공포 | 호위 지휘형: VLS 2기 대신 전자전 베이, 내구 감소 | 유도 미사일 |
| 석맥급 중형 채굴선 | 쌍 굴착 붐·톱니 절삭기, 중앙 반송부와 선광 호퍼 | 확장 호퍼형: 적재 +25%, 채굴 −15%, 순항 −5% | 채굴 레이저 |
| 자오선급 대형 수송선 | 종통 골조에 결속된 화물 모듈 6개와 전후 방공포 | 급행형: 적재 −20%, 순항 +13%, 유지비 +10% | 물류 AI |
| 감시자급 고급 경순양함 | 전후 범용 포좌, 양현 광학 포좌와 방공포 | 지휘형: 광학 포좌 대신 센서·전자전 베이, 내구 감소. 별도 설계도·장거리 센서 연구·통신 시설 필요 | 경순양함 설계, 미세 전자공학, 광학 레이저 |

모델의 +Z는 선수다. 포탑 자체는 기존 피팅 렌더러가 만들고 GLB에는 받침과 `hp_` 마커를 둔다. 엔진 이펙트는 `engine_` 마커에 붙는다. 모델을 사용하지 못할 때는 각 `mesh.base`의 절차적 선체로 돌아간다.

| GLB | 크기 | 삼각형 |
|---|---:|---:|
| `public/assets/content/models/patrol_pathfinder.glb` | 78,596 B | 1,040 |
| `public/assets/content/models/destroyer_lancet.glb` | 89,228 B | 1,184 |
| `public/assets/content/models/miner_quarry.glb` | 101,776 B | 1,356 |
| `public/assets/content/models/hauler_meridian.glb` | 105,344 B | 1,404 |
| `public/assets/content/models/cruiser_vigil.glb` | 103,184 B | 1,380 |

모든 모델은 `p8-assets.ts`에 SHA-256과 CC0로 등록한다. 재생성은 `npx vite-node scripts/models/make-p8.ts` 후 `npm run models:hash -- --write`로 한다.

## 화면 확인

실제 `?modelview=` 화면의 사선 미리보기: [길잡이](p8-previews/patrol_pathfinder.png), [침봉](p8-previews/destroyer_lancet.png), [석맥](p8-previews/miner_quarry.png), [자오선](p8-previews/hauler_meridian.png), [감시자](p8-previews/cruiser_vigil.png). 같은 디렉터리의 `-hardpoints.png`는 상면과 하드포인트 표시다. [전략 지도](p8-previews/game-strategic.png)와 [정찰형 피팅](p8-previews/game-fitting.png)은 로컬 싱글플레이 화면이다. 촬영 스크립트는 시험용 자금·평판을 설정해 공영 구매하고, 화면 확인을 위해 함선 위치를 모은다. 검토 중 초계함의 중형 포탑을 소형 포좌로 바꾸고, 채굴기 끝에 절삭 이빨을 추가했다.

미리보기 재촬영: `npm run dev`를 실행한 뒤 `OUT=docs/p8-previews node scripts/models/check-p8-preview.cjs`. 게임 화면 재촬영: `OUT=docs/p8-previews node scripts/models/check-p8-game.cjs`. 둘 다 Playwright와 Chromium이 필요하다. 이미지는 SwiftShader 소프트웨어 렌더링으로 촬영했다.

`tests/p8-ships.test.ts`는 다섯 선체의 공영 구매, 설계도·연구 조건, 부품 건조, 파생형 개장, 저장·재로드와 군함 발사를 확인한다. 콘텐츠 검증기는 실제 파일·해시·길이·축·마커·예산을 검사한다. 원거리 LOD는 포함하지 않았으며, 실제 GPU에서의 대규모 함대 성능과 장기 경제·전투 밸런스는 아직 측정하지 않았다.

## 검증 결과

- `npm run content:check`: 오류 0, 경고 0. `npm run models:hash`: 등록 모델 8개 해시 일치.
- `npm run build`와 `tsc --noEmit`: 통과. 빌드에 복사된 다섯 GLB는 원본과 바이트 단위로 일치한다.
- 신규 함선 전용 테스트 4건과 기존 콘텐츠·모델 파이프라인 테스트 20건: 통과. 세 군함의 장착 무기 발사도 전투 시뮬레이션에서 확인했다.
- 전체 `npm test`의 최초 실행: 173건 통과, 기존 연구 2건·조선소 1건은 60초 시간 초과, PostgreSQL 전용 2건은 `PG_TEST_URL`이 없어 건너뜀. 해당 장시간 검사 세 건의 제한만 300초로 조정해 재실행했고 3건 모두 통과했다. 전체 스위트를 수정 후 다시 한 번 완주한 결과는 아니다.
- 로컬 싱글플레이에서 다섯 함선 구매·전략 지도 로드와 초계함 정찰형 피팅을 확인했다. 초계함 GLB 요청을 차단하면 대체 선체가 표시된다.


통합 브랜치에서 실시한 후속 회귀·물류·통계·브라우저·저장 검증은 [통합 검증 보고서](INTEGRATION_VERIFICATION.md)를 참조한다. 위 결과는 P8 독립 브랜치 당시의 기록으로 보존한다.
