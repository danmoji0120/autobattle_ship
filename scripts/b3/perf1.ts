import { world, outpost, warships, patrol, run } from '../../tests/helpers/territory';
for (const sov of [true, false]) {
  const sim = world();
  if (!sov) delete (sim.st as any).sovV;
  const A = sim.addPlayer('개척사'); run(sim, 600);
  const st = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse']);
  const g = warships(sim, A, st.pos, ['cruiser', 'cruiser', 'cruiser', 'destroyer', 'destroyer', 'destroyer', 'destroyer']);
  patrol(sim, A, g, 'gloam', st);
  const t0 = Date.now(); run(sim, 900); console.log('sov', sov, 'ms/900s', Date.now() - t0);
}
