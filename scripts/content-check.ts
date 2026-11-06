// npm run content:check — validates every content pack and the files in public/assets/content/.
// Exit code 1 on any error (warnings are printed but do not fail).
import { CONTENT } from '../src/content/registry';
import { validateContent } from '../src/content/validate';
import { nodeAssetFs } from '../src/content/assetFs';

const issues = validateContent(CONTENT, nodeAssetFs());
const errors = issues.filter(i => i.level === 'error'), warns = issues.filter(i => i.level === 'warn');
for (const i of [...errors, ...warns]) console.log(`${i.level === 'error' ? 'ERROR' : 'warn '} ${i.where}: ${i.msg}`);
const n = (o: object) => Object.keys(o).length;
console.log(`\ncontent: packs ${CONTENT.packs.map(p => p.id).join(',')} · hulls ${n(CONTENT.hulls)} · variants ${n(CONTENT.variants)} · presets ${n(CONTENT.presets)} · assets ${n(CONTENT.assets)}`);
console.log(`${errors.length} error(s), ${warns.length} warning(s)`);
process.exitCode = errors.length ? 1 : 0;
