// Prints the sha256 of every registered model asset file and, with --write, updates the `sha256: '…'`
// value on the asset's line in the pack source (one asset per line, matched by its file path).
// Usage: npm run models:hash [-- --write]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONTENT } from '../../src/content/registry';

const ROOT = 'public/assets/content';
const write = process.argv.includes('--write');
const packFiles = fs.readdirSync('src/content/packs', { recursive: true }).map(String).filter(f => f.endsWith('.ts')).map(f => path.join('src/content/packs', f));
let changed = 0, bad = 0;
for (const a of Object.values(CONTENT.assets)) {
  if (!/model/.test(a.kind)) continue;
  const p = path.join(ROOT, a.file);
  if (!fs.existsSync(p)) { console.log(`${a.id}: 파일 없음 ${p}`); bad++; continue; }
  const h = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const ok = a.sha256 === h;
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${a.id}  ${h}  (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
  if (ok || !write) continue;
  for (const f of packFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    let hit = false;
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(`file: '${a.file}'`) && /sha256: '[0-9a-f]*'/.test(lines[i])) { lines[i] = lines[i].replace(/sha256: '[0-9a-f]*'/, `sha256: '${h}'`); hit = true; }
    if (hit) { fs.writeFileSync(f, lines.join('\n')); changed++; console.log(`  → ${f}`); }
  }
}
if (write) console.log(`${changed}개 갱신`);
process.exit(bad ? 1 : 0);
