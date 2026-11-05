import { BattleSession } from './game/session';
import { defaultPlayerFleet } from './sim/fleet';
import { getScenario } from './sim/data/scenarios';

const canvas = document.getElementById('view') as HTMLCanvasElement;
Object.assign(document.body.style, { margin: '0', background: '#000', overflow: 'hidden' });
Object.assign(canvas.style, { width: '100vw', height: '100vh', display: 'block' });
const params = new URLSearchParams(location.search);
const scen = params.get('scenario') ?? 'kestrel';
const s = new BattleSession(canvas, { seed: Number(params.get('seed') ?? 1), scenarioId: scen, fleets: [defaultPlayerFleet(), getScenario(scen).enemy] }, null);
(window as any).session = s;
if (params.get('cam') === 'director') s.view.rig.setMode('director');
addEventListener('resize', () => s.view.resize(innerWidth, innerHeight));
if (!params.has('manual')) s.start();
