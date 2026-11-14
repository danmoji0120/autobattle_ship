# P13.1 실물 전장 잔해 및 통합 인양

기준 브랜치 `feature/p12-5-logistics-simplification`(`008dba5`), 작업 브랜치 `feature/p13-1-salvage-overhaul`.
옵트인: 새 개발 월드 전용(`SALVAGE_P131=1` / `WorldSim.create(seed, { salvage: 'p131' })`, P11·P12·P12.5 포함). 운영 월드·기존 저장에는 적용하지 않는다.

## 1. 조사 결과 (작업 전 코드 기준)

### 1.1 인양·잔해가 생기는 경로는 넷이다

| 경로 | 코드 | 동작 | 문제 |
|---|---|---|---|
| 무작위 유기선 | `explore.ts` `seedSites`·`surveyStep`·`surveyLeft`·`salvageLoot`·`retireSite`, `sim.ts` `behaveSurvey`·`behaveSalvage`, `Op.survey`·`Op.salvage{site}` | 성계마다 2개 지점을 해시 위치에 만들고, 탐사 시간이 차면 발견. 인양 완료 시 RNG로 합금·희귀금속·전자·정밀·센서·설계도 조각·완성 설계도(`explore` 출처) 지급 후 4시간 뒤 재생성 | 전투와 무관한 무한 보상원. 잔해가 실제 자산이 아님 |
| 전투 잔해 광구 | `finishEngagementObserved` 끝부분 | 격침 함선 `shipValue×2.2`를 합산해 300 초과면 `Field{salvage:true}`(합금 혼합 `SALVAGE_MIX`)를 교전 중심에 생성, 1,500초 후 삭제. 채굴선이 채굴 | 화물·장비와 무관한 합금 광구. 아래 원격 회수와 같은 격침에서 이중 생성 |
| 원격 전장 회수 | `salvageWrecks`·`recoverLoot`, `research.ts` `wreckLoot`, `blueprints.ts` `wreckFragments` | `salvage_ops` 연구가 있으면 **해적** 격침 함선마다 피해 지분 확률로 부품·장비(장착 무장 중 무작위 1개 35%)·설계도 조각을 생성해 가장 가까운 정거장 창고 또는 `co.pendingLoot`에 지급 | 함선을 보내지 않아도 순간이동 지급. 무장 수량이 실제 장착과 무관하게 생성 |
| 격침 함선 화물 | `finishEngagementObserved` `r.dead` | 격침 함선의 `cargo` 전량을 `consume/combat_cargo_loss`로 소멸 처리 | 실제 화물이 남지 않음 |

### 1.2 탐사 기능의 의존 관계 (분리 대상)

- `behaveSurvey`는 두 가지를 같이 한다: ① P10 안개 월드의 광구 정보 조사(`surveyIntel` → `intel.ts`), ② 유기선 발견(`surveyStep`). P13.1에서는 ②만 끄고 ①은 그대로 둔다.
- 성계 방문 기록(`exploreStep` → `visit`), P10 회사별 정보(`intel`), 광구 시험 채굴 표본(`recordSample`), `survey_field`·`develop_field` 회사 목표(`fieldOps.ts`), P12 정찰(`recon`, `fleetops.ts`), 센서 기술(`long_sensors`)은 유기선과 무관하며 **보존**한다.
- 클라이언트: `hud.ts` 성계 탐사 버튼(`st.sites` 있을 때만 표시)과 유기선 인양 버튼(`data-salvage`), `growthUi.ts` 성계 탐사 요약이 `sites`에 의존.
- 마이그레이션: `migrate.ts`(c4)와 `worldgen-p9/p10`이 `seedSites`를 호출한다. 레거시 월드에서는 유지.

### 1.3 탐사 출처 설계도 (`kind: 'explore'`)

14종이 탐사 출처를 가진다. **탐사로만 얻을 수 있는 설계도는 없다** — 모두 상업 라이선스·세력·계약·잔해 조각 중 하나 이상이 있다. 따라서 폐지로 획득 불가능해지는 설계도는 없고, 탐사 출처는 향후 정식 탐사 콘텐츠용으로 데이터에 남겨 둔다(P13.1 월드에서는 지급 경로만 없음).

| 설계도 | 다른 출처 | 탐사 |
|---|---|---|
| 중순양함 | 상업 | 3등급 12% |
| 순양전함 | 세력·계약 | 3등급 5% |
| 전함 | 세력·잔해 조각 | 3등급 3% |
| 창살급 미사일 구축함 / 연장 발사관형 | 상업 | 2등급 8% / 6% |
| 채굴선 L / 채광모함급 드론형 | 상업 | 2등급 6% / 1등급 5% |
| 수송선 L | 세력 | 1등급 5% |
| 공작선 XL | 상업 | 3등급 4% |
| 철퇴급 장갑 강화형 | 잔해 조각·계약 | 2등급 7% |
| 침봉급 구축함 | 상업 | 2등급 6% |
| 자오선급 수송선 | 상업 | 1등급 5% |
| 감시자급 경순양함 / 지휘형 | 상업(·잔해 조각) | 2등급 4% / 5% |

잔해 조각(`salvage`) 출처 설계도 5종(전함, 철퇴급, 철퇴급 장갑 강화형, 채굴선 XL, 감시자급)은 기존에 원격 회수(`wreckFragments`)로만 조각을 얻었다. P13.1에서는 같은 확률로 **실제 잔해에 조각을 남기고**, 인양해야 얻는다.

### 1.4 기타 확인 사항

- BB-EX: 격침 시 삭제·잔해·조각 없이 `exclusiveLost`로 복구 대기(`isExclusiveShip`). 전용 장비는 `isExclusiveEquip`, `enforceExclusive`가 비정상 사본을 제거.
- 화물 용량: 군함(코르벳~드레드노트)의 `econ.cargo`는 0. 채굴선 140, 공작선 300, 수송선 450.
- 범죄 시스템은 없다. 기존 장치는 치안도(`effSec`/`secAt`), 회사 평판(`rep`), P10 세력 우호도(`bumpStanding`, `DOCK_REFUSE` -25에서 입항 거부), P11 회사 관계(`coRelation`, 적대 선언)다.
- P12.5: 격침된 수송선의 운송은 `maintainPool`이 `lost`로 처리하고 남은 물량을 재배차한다. 회수된 미추적 화물은 `stowCargo`가 가까운 창고로 하역한다.
- 함선 장착 장비: 플레이어 함선은 `fitting`(하드포인트·베이 → 장비 id, `fittingItems`), NPC 함선은 프리셋(`loadoutEquipment(getLoadout(...).mounts)`).

## 2. 설계 (P13.1 월드)

(구현과 함께 기록)
