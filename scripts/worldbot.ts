// Headless progression check: a scripted "reasonable player" runs a PMC for N minutes.
import { WorldSim } from '../src/world/sim';
import { ECON } from '../src/world/data';
const minutes = Number(process.argv[2] ?? 40);
const verbose = process.argv.includes('-v');
const sim = WorldSim.create(Number(process.argv[3] ?? 7));
const me = sim.addPlayer('테스트 PMC');
const st = sim.st;
const groups = () => Object.values(st.groups).filter(g => g.owner === me);
const G = (name: string) => groups().find(g => g.name === name)!;
const cmd = (c: any) => { const e = sim.command(me, c); if (e && verbose) console.log('  ! ', c.c, e); return e; };
cmd({ c: 'setOp', group: G('제1 채굴반').id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
cmd({ c: 'setOp', group: G('경비대').id, op: { k: 'escort', group: G('제1 채굴반').id } });
let lastLog = 0; let seen = 0; let founded = false;
const t0 = Date.now();
const co = st.companies[me];
for (let t = 0; t < minutes * 60; t += 0.05) {
  sim.update(0.05 * 4); // 4x speed: also steps live battles quickly
  if (st.time - lastLog >= 60) {
    lastLog = st.time;
    // simple policy
    const ships = Object.values(st.ships).filter(s => s.owner === me);
    const mg = G('제1 채굴반');
    for (const k of Object.values(st.contracts)) if (!k.takenBy && !k.done && (k.kind === 'delivery' && k.res === 'ore' && k.stationId === 'astra' || k.kind === 'bounty')) cmd({ c: 'accept', contract: k.id });
    if (!ships.some(s => s.classId === 'hauler') && co.credits > 6000) cmd({ c: 'buyShip', station: 'astra', classId: 'hauler', loadoutId: 'std', group: mg.id });
    else if (ships.filter(s => s.classId === 'miner').length < 4 && co.credits > 6000) cmd({ c: 'buyShip', station: 'astra', classId: 'miner', loadoutId: 'std', group: mg.id });
    else if (ships.filter(s => s.classId === 'destroyer').length < 2 && co.credits > 9000) cmd({ c: 'buyShip', station: 'astra', classId: 'destroyer', loadoutId: 'aa', group: G('경비대').id });
    else if (!founded && co.credits > 30000) {
      cmd({ c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' });
      const cg = groups().find(g => g.shipIds.some(id => st.ships[id]?.classId === 'constructor'))!;
      if (!cmd({ c: 'setOp', group: cg.id, op: { k: 'found', at: { x: 3200, y: 0, z: -5200 }, name: '전진기지' } })) founded = true;
    }
    const own = Object.values(st.stations).find(s => s.owner === me);
    if (own && own.modules.find(m => m.kind === 'core')?.built && own.modules.length < 3 && co.credits > 12000) cmd({ c: 'queueModule', station: own.id, kind: own.modules.length === 1 ? 'refinery' : 'repair' });
    // damaged ships: repair when docked
    for (const s of ships) if (s.hp < 0.7 && s.state === 'docked') cmd({ c: 'repair', ship: s.id });
    const nb = Object.values(st.engagements).length;
    console.log(`t=${(st.time / 60).toFixed(1)}m cr=${Math.round(co.credits)} ships=${ships.length} (${ships.map(s => s.classId[0]).join('')}) mined=${Math.round(co.stats.mined)} earned=${Math.round(co.stats.earned)} rep=${co.rep} kills=${co.stats.kills} lost=${co.stats.lost} battles=${nb} pirates=${Object.values(st.ships).filter(s => s.owner === 'pirates').length} status=[${groups().map(g => g.name + ':' + g.status).join(' | ')}]`);
  }
  for (; seen < st.events.length; seen++) {
    const e = st.events[seen];
    if (verbose || e.kind !== 'radio' && e.kind !== 'money') if (!e.company || e.company === me) console.log(`   [${(e.t / 60).toFixed(1)}m ${e.kind}] ${e.who ? e.who + ': ' : ''}${e.text}`);
  }
  if (seen > 380) seen = st.events.length;
}
console.log('milestones', co.milestones, 'networth', sim.netWorth(me), 'cpu ms', Date.now() - t0, 'save bytes', sim.serialize().length);
