// Ship model standard + a dependency-free GLB inspector (no three.js), shared by the content validator,
// the tests and the model tools. The renderer (src/render/modelLoader.ts) follows the same conventions.
//
// Model standard (docs/CODEX_CONTENT_GUIDE.md §26):
//  - glTF 2.0 binary (.glb), one scene. +z = bow, +y = up, +x = port (the simulation's ship frame).
//  - 1 unit = 1 game unit. The hull's length along z = SHIP_CLASSES[classId].length × mesh.scale.
//    The loader scales the model uniformly about its origin to exactly that length (small authoring
//    errors are absorbed; large ones are validation errors because hardpoints would no longer match).
//  - Origin = hull centre (the point the simulation moves and turns).
//  - Empty marker nodes (any depth): `hp_<hardpointId>` (turret base on the hull surface),
//    `engine_<n>` (nozzle exit centre; node scale = nozzle radius), `light_<n>` (navigation light).
//  - Materials named `sid_hull`, `sid_dark`, `sid_trim`, `sid_accent`, `sid_light` are replaced by the
//    team materials (faction colours, panel textures); any other material is drawn as authored (PBR).
//  - Combat is independent of the model: hit radius, armour, hardpoints and stats come from data.

export const MODEL_STD = {
  /** triangle budget of the main model by hull size */
  tris: { S: 6000, M: 15000, L: 30000, XL: 50000 } as Record<string, number>,
  /** an optional LOD model must use at most this share of the main model's triangles */
  lodShare: 0.4,
  /** distance (in hull lengths) from which the LOD model is drawn */
  lodDistance: 14,
  /** largest texture edge in pixels by hull size */
  tex: { S: 1024, M: 1024, L: 2048, XL: 2048 } as Record<string, number>,
  maxTextures: 4,
  maxMaterials: 8,
  /** authored length vs target length: warning / error */
  lengthWarn: 0.05, lengthErr: 0.25,
  /** bounding-box centre off the origin (share of length): warning / error */
  centreWarn: 0.1, centreErr: 0.3,
  /** hp_ marker vs hardpoint data distance: max(abs, share × length) */
  hpTolAbs: 0.6, hpTolShare: 0.03,
  /** glTF extensions a model may require (the loader decodes these without extra decoders) */
  allowedRequired: ['KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength'],
  teamMaterials: ['sid_hull', 'sid_dark', 'sid_trim', 'sid_accent', 'sid_light'],
} as const;

export interface GlbMarker { name: string; pos: [number, number, number]; scale: number }
export interface GlbInfo {
  ok: boolean;
  error?: string;
  version?: string;
  generator?: string;
  extensionsRequired: string[];
  extensionsUsed: string[];
  triangles: number;
  meshes: number;
  materials: string[];
  textures: { bytes: number; w?: number; h?: number; mime?: string }[];
  /** world-space bounding box of all mesh instances (authored units) */
  min: [number, number, number]; max: [number, number, number];
  hp: GlbMarker[]; engines: GlbMarker[]; lights: GlbMarker[];
  skinned: boolean; animated: boolean;
}

type M4 = number[];
const I4 = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {   // column-major a × b
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}
function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]): M4 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
const apply = (m: M4, p: number[]): [number, number, number] => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const colLen = (m: M4, c: number) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);

function imageSize(b: Uint8Array): { w?: number; h?: number; mime?: string } {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) { const d = new DataView(b.buffer, b.byteOffset, b.byteLength); return { w: d.getUint32(16), h: d.getUint32(20), mime: 'image/png' }; }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], mime: 'image/jpeg' };
      i += 2 + len;
    }
    return { mime: 'image/jpeg' };
  }
  return {};
}

const empty = (error: string): GlbInfo => ({ ok: false, error, extensionsRequired: [], extensionsUsed: [], triangles: 0, meshes: 0, materials: [], textures: [], min: [0, 0, 0], max: [0, 0, 0], hp: [], engines: [], lights: [], skinned: false, animated: false });

/** parse a .glb and report what the validator needs. Never throws. */
export function inspectGlb(bytes: Uint8Array): GlbInfo {
  try {
    if (bytes.length < 20) return empty('파일이 너무 작음 (GLB 아님)');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x46546c67) return empty('GLB 매직 값이 아님 (.gltf JSON 이 아니라 .glb 로 내보내기)');
    if (dv.getUint32(4, true) !== 2) return empty(`glTF 컨테이너 버전 ${dv.getUint32(4, true)} (2 필요)`);
    if (dv.getUint32(8, true) > bytes.length) return empty('파일이 잘림 (헤더 길이 > 실제 크기)');
    let off = 12; let json: any = null; let bin: Uint8Array | null = null;
    while (off + 8 <= bytes.length) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      const data = bytes.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
      else if (type === 0x004e4942) bin = data;
      off += 8 + len;
    }
    if (!json) return empty('JSON 청크 없음');
    const info = empty(''); info.ok = true; delete info.error;
    info.version = json.asset?.version; info.generator = json.asset?.generator;
    info.extensionsRequired = json.extensionsRequired ?? []; info.extensionsUsed = json.extensionsUsed ?? [];
    info.materials = (json.materials ?? []).map((m: any, i: number) => m.name ?? `#${i}`);
    info.meshes = (json.meshes ?? []).length;
    info.skinned = (json.skins ?? []).length > 0;
    info.animated = (json.animations ?? []).length > 0;
    for (const img of json.images ?? []) {
      if (img.bufferView === undefined || !bin) { info.textures.push({ bytes: 0 }); continue; }
      const bv = json.bufferViews[img.bufferView];
      const b = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      info.textures.push({ bytes: b.length, ...imageSize(b), ...(img.mimeType ? { mime: img.mimeType } : {}) });
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const nodes: any[] = json.nodes ?? [];
    const visit = (i: number, parent: M4, depth: number) => {
      if (depth > 64) return;
      const n = nodes[i]; if (!n) return;
      const local = n.matrix ? n.matrix.slice() : trs(n.translation, n.rotation, n.scale);
      const w = mul(parent, local);
      const name: string = n.name ?? '';
      const pos = apply(w, [0, 0, 0]);
      const mk = (): GlbMarker => ({ name, pos, scale: (colLen(w, 0) + colLen(w, 1) + colLen(w, 2)) / 3 });
      if (/^hp_/.test(name)) info.hp.push(mk());
      else if (/^engine_/.test(name)) info.engines.push(mk());
      else if (/^light_/.test(name)) info.lights.push(mk());
      if (n.mesh !== undefined) {
        for (const p of json.meshes[n.mesh]?.primitives ?? []) {
          const mode = p.mode ?? 4;
          const pa = json.accessors[p.attributes?.POSITION];
          if (!pa) continue;
          const count = p.indices !== undefined ? json.accessors[p.indices].count : pa.count;
          if (mode === 4) info.triangles += Math.floor(count / 3); else if (mode === 5 || mode === 6) info.triangles += Math.max(0, count - 2);
          if (pa.min && pa.max) for (let c = 0; c < 8; c++) {
            const q = apply(w, [c & 1 ? pa.max[0] : pa.min[0], c & 2 ? pa.max[1] : pa.min[1], c & 4 ? pa.max[2] : pa.min[2]]);
            for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
          }
        }
      }
      for (const c of n.children ?? []) visit(c, w, depth + 1);
    };
    const scene = json.scenes?.[json.scene ?? 0];
    const roots: number[] = scene?.nodes ?? nodes.map((_, i) => i).filter(i => !nodes.some(n => n.children?.includes(i)));
    for (const r of roots) visit(r, I4(), 0);
    if (!isFinite(lo[0])) return { ...info, ok: false, error: '메시가 없거나 POSITION min/max 가 없음' };
    info.min = lo as [number, number, number]; info.max = hi as [number, number, number];
    return info;
  } catch (e) {
    return empty(`GLB 해석 실패: ${(e as Error).message}`);
  }
}

/** SHA-256 hex of a file's bytes (Node and browsers: WebCrypto) */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
