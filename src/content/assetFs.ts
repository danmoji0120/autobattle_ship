// Node-only: AssetFs over public/assets/content/ (used by the content:check CLI and the tests).
import fs from 'node:fs';
import path from 'node:path';
import type { AssetFs } from './validate';

export function nodeAssetFs(root = path.resolve('public/assets/content')): AssetFs {
  const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  return {
    size: f => { try { return fs.statSync(path.join(root, f)).size; } catch { return null; } },
    list: () => walk(root).map(f => path.relative(root, f).split(path.sep).join('/')),
  };
}
