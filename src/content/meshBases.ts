// Procedural silhouettes the renderer knows besides the class ids (src/render/shipMesh.ts design()).
// Kept outside the renderer so the content validator can check references without three.js.
export const EXTRA_MESH_BASES = [
  'dd_vls', 'dd_picket', 'dd_heavy', 'dd_fast',
  'miner_m', 'miner_l', 'miner_xl',
  'hauler_m', 'hauler_l', 'hauler_xl',
  'con_s', 'con_l', 'con_xl',
  'salv_s',
  'bbex',
] as const;
export const isExtraMeshBase = (b: string) => (EXTRA_MESH_BASES as readonly string[]).includes(b);
