import type { AssetDef } from '../../schema';

// One asset per line so models:hash --write can pin each file's actual content.
export const P8_ASSETS: AssetDef[] = [
  { id: 'model.patrol_pathfinder', kind: 'ship-model', file: 'models/patrol_pathfinder.glb', for: 'patrol_pathfinder', license: 'CC0', author: 'Siderarium P8', sha256: 'aca43b5a1c23a6c9e287a987b3d8ebbb601939addc394195b037113e2d8c92ad' },
  { id: 'model.destroyer_lancet', kind: 'ship-model', file: 'models/destroyer_lancet.glb', for: 'destroyer_lancet', license: 'CC0', author: 'Siderarium P8', sha256: 'a35ebb154e7a6f76658653b6b56455e7c0dd6a275eb51162426f6e917382f6a8' },
  { id: 'model.miner_quarry', kind: 'ship-model', file: 'models/miner_quarry.glb', for: 'miner_quarry', license: 'CC0', author: 'Siderarium P8', sha256: '92937f023ecbb56beddebb08d4babaac4c93a920d2a29c8dad6338e445690003' },
  { id: 'model.hauler_meridian', kind: 'ship-model', file: 'models/hauler_meridian.glb', for: 'hauler_meridian', license: 'CC0', author: 'Siderarium P8', sha256: 'd124a333c2287c7af38a02da888a03762feffd6b0493cb537aea4128e2f1ff42' },
  { id: 'model.cruiser_vigil', kind: 'ship-model', file: 'models/cruiser_vigil.glb', for: 'cruiser_vigil', license: 'CC0', author: 'Siderarium P8', sha256: 'e1848b16b36bd35754811a21b98548f283b3bf1d9b6092f0ae148aec41d0bd63' },
];
