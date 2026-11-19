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
/** P17.3 hull silhouettes (render/hulls17.ts) */
export const P17_MESH_BASES = [
  'p17_cv_militia', 'p17_cv_blackwing', 'p17_cv_spark', 'p17_cv_hornet', 'p17_cv_relic',
  'p17_ff_mirage', 'p17_ff_shieldwall', 'p17_ff_lantern', 'p17_ff_scrap',
  'p17_dd_hedgehog', 'p17_dd_hammerhead', 'p17_dd_scavenger', 'p17_dd_spindle', 'p17_dd_tempest', 'p17_dd_forge',
  'p17_cl_longbow', 'p17_cl_siren', 'p17_cl_warden', 'p17_cl_ironside',
  'p17_ca_nova', 'p17_ca_swarm', 'p17_ca_aegis', 'p17_ca_hydra',
  'p17_bc_breaker', 'p17_bc_falchion', 'p17_bc_corsair', 'p17_bc_monitor',
  'p17_bb_solaris', 'p17_bb_hulk', 'p17_bb_bastion', 'p17_bb_vanguard',
  'p17_dn_citadel', 'p17_dn_leviathan', 'p17_dn_sovereign',
  'p17_cv_hive', 'p17_cv_ark',
] as const;
export const isExtraMeshBase = (b: string) => (EXTRA_MESH_BASES as readonly string[]).includes(b) || (P17_MESH_BASES as readonly string[]).includes(b);
