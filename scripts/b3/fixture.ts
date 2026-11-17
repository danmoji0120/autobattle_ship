// Produces real engine output for the browser check (scripts/b3/b3-browser.cjs): B pioneers gloam to sovereignty, A
// holds a foothold and a claim there and declares war. Writes { owner: sovReport(B), claimant: sovReport(A), terr }.
import fs from 'fs';
import { world, run, kit, ff, deliver, earn, addMods, outpost, garrison } from '../../tests/helpers/territory';
import { CLASS, stageOf, sovReport, publish } from '../../src/world/sovereignty';
const out = process.argv[2] ?? 'b3-fixture.json';
const sim = world(); const B = sim.addPlayer('보레아스 산업'), A = sim.addPlayer('아르고 개척'); run(sim, 300);
const k = kit(sim, B, 'gloam');
const gov = () => { earn(sim, B, 30_000); if (k.st.modules.some(m => m.kind === 'governance')) deliver(sim, B, k.st, 1.2); };
for (let h = 0; h < 12 && stageOf(sim, B, 'gloam') < 3; h++) ff(sim, 1, gov);
console.log('declare', sim.command(B, { c: 'sov', op: 'declare', sys: 'gloam' } as never));
addMods(k.st, ['governance', ...Array(CLASS.outer.defense).fill('defense')]);
for (let h = 0; h < 60 && sim.st.sov!.sys.gloam.owner !== B; h++) ff(sim, 1, gov);
console.log('owner', sim.st.sov!.sys.gloam.owner === B);
sim.command(B, { c: 'sov', op: 'policy', sys: 'gloam', policy: { mine: 'royalty', royalty: 0.1, pass: 'toll', toll: 800, price: { mine: 6000, build: 0, pass: 2500 } } } as never);
const a = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse'], 9);
garrison(sim, A, 'gloam', a, ['cruiser', 'cruiser', 'cruiser', 'destroyer'], Array(6).fill('cruiser'));
sim.st.companies[A].credits += 3_000_000;
for (let h = 0; h < 10 && stageOf(sim, A, 'gloam') < 3; h++) ff(sim, 1, () => { gov(); earn(sim, A, 30_000); });
console.log('A declare', sim.command(A, { c: 'sov', op: 'declare', sys: 'gloam' } as never));
console.log('A war', sim.command(A, { c: 'sov', op: 'war', sys: 'gloam' } as never));
ff(sim, 1, gov);
publish(sim);
fs.writeFileSync(out, JSON.stringify({ B, A, owner: sovReport(sim, B), claimant: sovReport(sim, A), terr: (sim.st.systems.gloam as any).terr, names: { [B]: sim.st.companies[B].name, [A]: sim.st.companies[A].name } }));
console.log('written', out);
