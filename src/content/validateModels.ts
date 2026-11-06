// Ship / variant model checks (P8 pipeline). The file itself is inspected (GLB structure, size, axes,
// length, origin, markers, triangle and texture budgets) and compared with the content data that uses
// it (hull length, hardpoints). Standard: src/content/modelSpec.ts, guide §26–§31.
import { SHIP_CLASSES } from '../sim/data/ships';
import type { AssetDef, HardpointDef, HullDef } from './schema';
import { variantLayout, type Registry } from './registry';
import { inspectGlb, MODEL_STD, type GlbInfo } from './modelSpec';
import type { AssetFs } from './validate';

type Report = (where: string, msg: string) => void;

const SHA = /^[0-9a-f]{64}$/;
const fixed = (n: number, d = 1) => n.toFixed(d);

/** the length a hull is drawn at (and its model is scaled to) */
export const hullDrawLength = (h: HullDef) => (SHIP_CLASSES[h.classId]?.length ?? 0) * (h.mesh?.scale ?? 1);

export function validateModels(reg: Registry, fs: AssetFs | undefined, err: Report, warn: Report) {
  const packMinV = (kind: string, id: string) => reg.packs.find(p => p.id === reg.origin[`${kind}:${id}`])?.minContentV ?? 0;
  for (const a of Object.values(reg.assets)) {
    if (a.kind !== 'ship-model' && a.kind !== 'variant-model') {
      if (a.kind === 'model-lod' && !Object.values(reg.assets).some(x => x.lod === a.id)) warn(`asset ${a.id}`, '어느 모델의 lod 로도 쓰이지 않음');
      continue;
    }
    const at = `asset ${a.id}`;
    // who uses it, at which length, against which hardpoints
    const hullUsers = Object.values(reg.hulls).filter(h => h.mesh?.model === a.id);
    const varUsers = Object.values(reg.variants).filter(v => v.model === a.id);
    const uses: { label: string; hull: HullDef; hps: HardpointDef[] }[] = [
      ...hullUsers.map(h => ({ label: `hull ${h.id}`, hull: h, hps: h.hardpoints })),
      ...varUsers.flatMap(v => { const h = reg.hulls[v.hull]; return h ? [{ label: `variant ${v.id}`, hull: h, hps: variantLayout(v.id, reg)?.hardpoints ?? h.hardpoints }] : []; }),
    ];
    if (!uses.length) warn(at, '어느 선체·변형에도 연결되지 않은 모델 (HullDef.mesh.model / VariantDef.model)');
    // test fixtures vs final art
    const devOnly = uses.length > 0 && uses.every(u => u.hull.dev);
    if (a.fixture && !a.file.startsWith('models/fixtures/')) err(at, 'fixture 모델은 models/fixtures/ 아래에 둔다');
    if (!a.fixture && a.file.startsWith('models/fixtures/')) err(at, 'models/fixtures/ 의 파일은 fixture: true 로 등록');
    if (a.fixture && uses.some(u => !u.hull.dev)) err(at, `fixture(테스트) 모델을 실제 선체에 연결할 수 없음 — dev 선체 전용 (${uses.filter(u => !u.hull.dev).map(u => u.label).join(', ')})`);
    if (!a.fixture && devOnly) warn(at, 'dev 선체 전용인데 fixture 표시가 없음');
    // legacy (c0) worlds keep the procedural look: models only on growth content
    for (const h of hullUsers) if (reg.origin[`hull:${h.id}`] === 'core') err(at, `기본(core) 선체 ${h.id} 에는 모델을 연결하지 않는다 — 기존 월드 외형 보호. 새 선체나 성장 팩 변형에 연결`);
    for (const v of varUsers) if (reg.origin[`hull:${v.hull}`] === 'core' && packMinV('variant', v.id) < 3) err(at, `변형 ${v.id} 은 기본 선체의 변형이므로 minContentV 3 팩에 있어야 모델을 쓸 수 있음`);
    // version pin
    if (!a.sha256) err(at, 'sha256 필수 (npm run models:hash 로 계산해 등록)');
    else if (!SHA.test(a.sha256)) err(at, 'sha256 형식 (소문자 hex 64자)');
    if (a.lod) {
      const l = reg.assets[a.lod];
      if (!l) err(at, `lod 에셋 "${a.lod}" 미등록`);
      else if (l.kind !== 'model-lod' || l.for !== a.id) err(at, `lod "${l.id}" 는 kind model-lod, for "${a.id}" 여야 함`);
      else if (!l.sha256 || !SHA.test(l.sha256)) err(`asset ${l.id}`, 'sha256 필수');
    }
    if (!fs?.read) continue;
    const info = checkFile(a, fs, err);
    if (!info) continue;
    for (const u of uses) checkAgainst(a, info, u.label, u.hull, u.hps, err, warn);
    if (a.lod && reg.assets[a.lod]) {
      const l = reg.assets[a.lod];
      const li = checkFile(l, fs, err);
      if (li) {
        if (li.triangles > info.triangles * MODEL_STD.lodShare) warn(`asset ${l.id}`, `LOD 삼각형 ${li.triangles} > 본 모델(${info.triangles})의 ${MODEL_STD.lodShare * 100}%`);
        for (const u of uses.slice(0, 1)) { const len = li.max[2] - li.min[2], T = hullDrawLength(u.hull); if (Math.abs(len / T - 1) > MODEL_STD.lengthErr) err(`asset ${l.id}`, `LOD 길이 ${fixed(len)} 가 목표 ${fixed(T)} 와 다름`); }
      }
    }
  }
}

function checkFile(a: AssetDef, fs: AssetFs, err: Report): GlbInfo | null {
  const at = `asset ${a.id}`;
  const bytes = fs.read!(a.file);
  if (!bytes) return null;                        // the generic asset check already reported "파일 없음"
  if (a.sha256 && fs.sha256) {
    const h = fs.sha256(a.file);
    if (h && h !== a.sha256) err(at, `파일 내용이 등록된 sha256 과 다름 (파일 ${h.slice(0, 12)}…, 등록 ${a.sha256.slice(0, 12)}…) — 파일이 바뀌었으면 npm run models:hash 로 갱신, 아니면 올바른 파일을 받는다`);
  }
  const info = inspectGlb(bytes);
  if (!info.ok) { err(at, info.error ?? 'GLB 해석 실패'); return null; }
  if (info.version !== '2.0') err(at, `glTF asset.version "${info.version}" (2.0 필요)`);
  const bad = info.extensionsRequired.filter(e => !(MODEL_STD.allowedRequired as readonly string[]).includes(e));
  if (bad.length) err(at, `필수 확장 ${bad.join(', ')} 은 지원하지 않음 (Draco·meshopt·KTX2 압축 없이 내보내기)`);
  if (info.materials.length > MODEL_STD.maxMaterials) err(at, `재질 ${info.materials.length}개 > ${MODEL_STD.maxMaterials}`);
  if (info.textures.length > MODEL_STD.maxTextures) err(at, `텍스처 ${info.textures.length}장 > ${MODEL_STD.maxTextures}`);
  if (info.textures.some(t => t.bytes === 0)) err(at, '외부 파일을 참조하는 텍스처 — GLB 안에 포함(embed)해야 함');
  return info;
}

function checkAgainst(a: AssetDef, info: GlbInfo, label: string, h: HullDef, hps: HardpointDef[], err: Report, warn: Report) {
  const at = `asset ${a.id} (${label})`;
  const budget = MODEL_STD.tris[h.size] ?? MODEL_STD.tris.M;
  if (info.triangles > budget) err(at, `삼각형 ${info.triangles} > ${h.size} 선체 한도 ${budget}`);
  else if (info.triangles < 200) warn(at, `삼각형 ${info.triangles} — 최종 자산으로는 지나치게 단순 (fixture 가 아니면 검토)`);
  const texMax = MODEL_STD.tex[h.size] ?? 1024;
  for (const t of info.textures) if ((t.w ?? 0) > texMax || (t.h ?? 0) > texMax) err(at, `텍스처 ${t.w}×${t.h} > ${h.size} 선체 한도 ${texMax}`);
  if (info.skinned || info.animated) warn(at, '스킨·애니메이션은 무시됨 (포탑·엔진은 엔진이 움직인다)');
  const dx = info.max[0] - info.min[0], dy = info.max[1] - info.min[1], dz = info.max[2] - info.min[2];
  if (dx > dz || dy > dz) { err(at, `가장 긴 축이 z 가 아님 (x ${fixed(dx)} · y ${fixed(dy)} · z ${fixed(dz)}) — 선수가 +z 를 향하게 내보내기`); return; }
  const T = hullDrawLength(h);
  const k = T / dz;
  const off = Math.abs(dz / T - 1);
  if (off > MODEL_STD.lengthErr) err(at, `모델 길이 ${fixed(dz)} 가 목표 ${fixed(T)} (= ${h.classId} 길이 × mesh.scale ${h.mesh.scale}) 와 ${fixed(off * 100, 0)}% 다름 — 1 단위 = 게임 1 단위로 내보내기`);
  else if (off > MODEL_STD.lengthWarn) warn(at, `모델 길이 ${fixed(dz)} ≠ 목표 ${fixed(T)} — 로더가 ×${k.toFixed(3)} 로 맞춘다 (하드포인트 오차 주의)`);
  if (!a.recenter) {
    const cz = (info.max[2] + info.min[2]) / 2, cx = (info.max[0] + info.min[0]) / 2;
    for (const [axis, c] of [['z', cz], ['x', cx]] as const) {
      const r = Math.abs(c) / dz;
      if (r > MODEL_STD.centreErr) err(at, `경계 상자 중심이 원점에서 ${axis} ${fixed(c)} 벗어남 — 원점 = 선체 중심 (또는 recenter: true)`);
      else if (r > MODEL_STD.centreWarn) warn(at, `경계 상자 중심 ${axis} ${fixed(c)} — 원점이 선체 중심인지 확인`);
    }
  }
  if (!info.engines.length) warn(at, 'engine_ 마커 없음 — 기본 실루엣의 엔진 위치를 쓴다 (불꽃이 모델과 어긋날 수 있음)');
  else if (info.engines.some(e => e.pos[2] > 0)) err(at, '엔진 마커가 +z(함수) 쪽에 있음 — 선수·선미가 뒤집혔는지 확인');
  if (!info.materials.some(m => m === 'sid_accent')) warn(at, 'sid_accent 재질 없음 — 진영 색(아군 청 / 적 적)이 모델에 표시되지 않음');
  // hardpoint markers vs data (after the loader's length correction)
  const tol = Math.max(MODEL_STD.hpTolAbs, MODEL_STD.hpTolShare * T);
  const markers = new Map(info.hp.map(m => [m.name.slice(3), m]));
  const missing: string[] = [];
  for (const p of hps) {
    const m = markers.get(p.id);
    if (!m) { missing.push(p.id); continue; }
    const d = Math.hypot(m.pos[0] * k - p.pos[0], m.pos[1] * k - p.pos[1], m.pos[2] * k - p.pos[2]);
    if (d > tol) err(at, `hp_${p.id} 마커 ${JSON.stringify(m.pos.map(v => +(v * k).toFixed(2)))} 가 하드포인트 데이터 ${JSON.stringify(p.pos)} 와 ${fixed(d, 2)} 떨어짐 (허용 ${fixed(tol, 2)})`);
  }
  if (missing.length) warn(at, `hp_ 마커 없는 하드포인트: ${missing.join(', ')} — 위치 일치를 확인할 수 없음`);
  for (const id of markers.keys()) if (!hps.some(p => p.id === id)) warn(at, `hp_${id} 마커에 해당하는 하드포인트가 데이터에 없음`);
}
