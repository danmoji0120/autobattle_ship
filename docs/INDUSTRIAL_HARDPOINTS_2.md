# 산업 하드포인트 보완 (IND2)

산업 하드포인트(indV 월드) 1차 구현에 대한 세 가지 설계 보완과 외부 장비 위치 구조 점검.

## 1. 소형 인양선 `salvager_s` (갈고리급)

- 러스트포트 해체조합, T1·S, classId `hauler`(운송·판매 경로 호환), 화물 300, 순항 92.
- 내부 베이: `bay1` special S, `ind1` industrial M. 하드포인트 `pd1`(방공포 1).
- 설계 보너스 `ops.bonus.salvage = 1.3` — 인양 장비 효율 × 1.3. 표준 장비 `ops.gear = ['ind_salv_s']`.
  장비가 없으면 인양 능력 0 (선체 자체 능력 없음).
- 판매: rustport·drakeout·astra·p9_ceres_works. 설계도 common, 상점 3,000 cr (rustport·drakeout·astra).
- 범용 산업선·수송선에 인양 장비를 다는 방식은 그대로 허용(보너스 1.0).

인양 스타터(indV): 갈고리급 ×2(소형 인양 장비) + 수송선 1(장비 없음, 회수품 운송·투하 화물 회수·판매 왕복).
가치 약 22.7k, 유지비 약 1,002/h. 재기 경로(`salvageComeback`)도 갈고리급 → 수송선 순으로 제안.

## 2. 장비 없는 인양 예외 제거

indV 월드에서 `s.ind` 함선(플레이어 함선)은 군함 포함 모두 인양 장비 없이는 잔해 인양·해체를 못 한다.

| 경로 | 처리 |
|---|---|
| `salvageRate` (P13.1 엔진: lotsFor·workable·prospect·workShip) | ind 함선은 `SALV.gear × econOf(s).salv`만 사용, 역할 표 값(군함 cargo 등) 미사용 |
| `validateSalvage` recover / salvzone | 장비 함선이 없으면 `NO_SALV_GEAR` |
| `validateOp('salvage')` (구형 인양 명령) | ind 함선만 있고 장비가 없으면 거부 |
| `behaveSalvage` (구형 자동 인양) | 같은 조건이면 작업 중단·상태 표시 |

구분되는 예외(의도적으로 유지):
- **투하된 화물 회수**(`st.drops`, P13.2 약탈 투하): 이미 분리된 화물이므로 장비 없이 회수 가능.
- **전투 직후 전리품**(`salvageWrecks`, salvage_ops 연구): 잔해 작업이 아닌 즉시 지급 — 변경 없음.
- NPC 함선(fitting 없음, `ind` 아님)은 기존 표 값 유지.

## 3. 자체 조선소 출고 피팅

`buildShip` 명령에 `outfit: 'hull' | 'standard' | 'preset'`, `fitPreset` 추가.

- `standard`: 선택한 무장 프리셋 + 선체 표준 산업 장비(`ops.gear`).
- `hull`: 빈 피팅으로 출고.
- `preset`: 회사의 저장 피팅 프리셋(같은 선체 변형만).
- 장비는 `buildNeeds`가 부품과 함께 정거장 창고에서 차감(용골 착수 시). 없으면 "부품 부족"으로 대기 — 무상 생성 없음.
- 성장 콘텐츠가 아닌 월드는 성장 장비 제한 검사 유지. `outfit`을 주지 않으면 기존 동작(자동 운영 경로 호환).
- UI: 조선소 선체 상세에 출고 피팅 선택(표준/선체만/회사 프리셋), 필요 부품 목록에 장비 포함.

## 4. 구조 점검: 외부 장비 위치·작업 애니메이션

현재 구조:
- 산업 장비는 `HullDef.internals`의 `InternalSlotDef {id, kind, size}`에 장착되며 **위치 정보가 없다**.
  무기 하드포인트(`HardpointDef`)는 `pos`·`facing`·`arc`·`mount`를 갖고, `shipLoadout().mounts`를 통해 렌더러가 포탑을 배치한다.
- 선체 메시는 mesh base별 절차적 생성(`shipMesh.ts`, 예: `con_s`의 조작 팔, `salv_s`의 집게 팔)이며 산업 장비 장착 여부와 무관하게 정적으로 그려진다.
- 외부 모델은 `hp_` 마커로 하드포인트 위치를 검증한다(모델 검증기). 산업 베이용 마커는 없다.
- 클라이언트에는 그룹의 작전(op)·상태 문자열과 함선 화물이 동기화된다. 함선 단위 "현재 작업 중" 상태는 별도 필드가 없다.

연결 가능성: **가능하며 저장 호환을 깨지 않고 단계적으로 추가할 수 있다.**
1. `InternalSlotDef`에 선택 필드 `anchor?: { pos: [x,y,z]; facing?: number }` 추가 — 기존 베이 id·피팅 키 불변, 저장 데이터 영향 없음.
   (대안: 산업 장비를 `HardpointType 'industrial'` 하드포인트로 이전 — 위치는 자연스럽지만 피팅 키·검증·마이그레이션 영향이 커서 비권장.)
2. 렌더러: `fitting.bay[id]`의 장비 → 장비별 부착 메시(레이저 헤드·크레인·견인 빔)를 anchor에 배치. 절차적 선체의 정적 팔은 anchor가 있는 선체부터 장비 메시로 대체.
   외부 모델은 `ind_<bayId>` 마커를 검증기에 추가.
3. 작업 애니메이션: 함선 단위 작업 상태(예: `s.work = 'mine'|'salvage'|'build'` + 대상 위치)를 서버 시뮬레이션(채굴 틱·`workShip`·건설 틱)에서 설정하고 동기화.
   현재도 그룹 op/상태로 근사 표시는 가능하나, 개별 함선의 빔 방향·대상은 이 필드가 필요하다.

보류(설계 결정 필요): anchor 방식 vs 하드포인트 이전, 함선 작업 상태 필드의 동기화 비용(델타 직렬화 포함), 장비별 부착 메시의 아트 기준.
