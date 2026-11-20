import '@fontsource/noto-sans-kr/400.css';
import '@fontsource/noto-sans-kr/700.css';
import '@fontsource/noto-sans-kr/900.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/700.css';
import './ui/style.css';
import { BattleSession } from './game/session';
import { BattleHUD } from './ui/battleHud';
import { SetupScreen, loadFleet, loadScenarioId } from './ui/setup';
import { getScenario } from './sim/data/scenarios';
import { BATTLE_RULES, CPU_BEHAVIOUR, type BattleSetup } from './sim/world';
import type { OrderRecord } from './sim/types';
import { sfx } from './audio/sfx';
import { showMenu, startCampaign, type Campaign } from './client/app';
import { showDevCombatGate } from './client/devCombatGate';

const getCanvas = () => document.getElementById('view') as HTMLCanvasElement;
const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

let session: BattleSession | null = null;
let hud: BattleHUD | null = null;
let setup: SetupScreen | null = null;
let lastSetup: BattleSetup | null = null;
let lastOrders: OrderRecord[] = [];

function unlockAudio() { sfx.init(); }
addEventListener('pointerdown', unlockAudio, { capture: true });
addEventListener('keydown', unlockAudio, { capture: true });

let campaign: Campaign | null = null;

function showMainMenu() {
  teardownBattle();
  setup?.dispose(); setup = null;
  campaign?.stop(); campaign = null;
  getCanvas().style.visibility = 'hidden';
  showMenu(app, {
    onSkirmish: () => showSetup(),
    onCampaign: (mode, name) => { campaign = startCampaign(mode, name, app, () => { campaign = null; showMainMenu(); }); },
  });
}

function showSetup() {
  teardownBattle();
  getCanvas().style.visibility = 'hidden';
  setup = new SetupScreen(app, r => {
    setup?.dispose(); setup = null;
    startBattle({ seed: (Date.now() & 0x7fffffff) >>> 0, scenarioId: r.scenarioId, fleets: [r.fleet, getScenario(r.scenarioId).enemy], rules: r.rules, cpuV: CPU_BEHAVIOUR });
  }, () => showMainMenu());
}

function teardownBattle() {
  hud?.dispose(); hud = null;
  if (session) { sfx.stopMusic(); session.dispose(); session = null; }
}

function startBattle(bs: BattleSetup, replay: OrderRecord[] | null = null) {
  teardownBattle();
  lastSetup = bs;
  const old = getCanvas();
  // a fresh canvas per battle avoids stale GL state
  const fresh = old.cloneNode() as HTMLCanvasElement;
  fresh.style.visibility = 'visible';
  old.replaceWith(fresh);
  (window as any).__canvas = fresh;
  const s = new BattleSession(fresh, bs, sfx);
  session = s;
  if (replay) { s.world.scheduleReplay(replay); s.view.rig.setMode('director'); }
  hud = new BattleHUD(app, s, {
    replay: !!replay,
    onExit: () => { lastOrders = s.world.orderLog.slice(); showSetup(); },
    onRestart: () => startBattle({ ...bs, seed: bs.seed }),
    onReplay: () => { const orders = replay ?? s.world.orderLog.slice(); lastOrders = orders; startBattle(bs, orders); },
  });
  if (replay) hud.select(s.world.roots[0]);
  const innerFrame = s.onFrame;
  s.onFrame = dt => {
    innerFrame?.(dt);
    sfx.listener = s.view.rig.camera.position;
    sfx.updateMusic(Math.min(1, s.world.intensity / 25));
  };
  sfx.startMusic();
  (window as any).session = s;
  (window as any).hud = hud;
  if (params.get('cam') === 'director') s.view.rig.setMode('director');
  if (!params.has('manual')) s.start();
}

// expose for automated play-testing
(window as any).fleetcmd = { startBattle, showSetup, showMainMenu, get session() { return session; }, get lastOrders() { return lastOrders; } };


if (params.get('devskirmish') === '1') showDevCombatGate(app, getCanvas);
else if (params.has('modelview')) void import('./render/modelPreview').then(m => m.startModelPreview(app, getCanvas(), params));
else if (params.has('lineup')) void import('./render/lineup').then(m => m.startLineup(app, getCanvas(), params));
else if (params.has('bbex') && import.meta.env.DEV) {
  // development showcase / visual verification of the account-exclusive BB-EX (not in production builds):
  //   ?bbex=descent[&n=200]  ANGEL DESCENT    ?bbex=<trial id>  one of the combat trials (sim/bbex/trials.ts)
  void import('./sim/bbex/trials').then(m => {
    const seed = Number(params.get('seed') ?? 1), t = m.TRIALS.find(x => x.id === params.get('bbex'));
    startBattle(t ? m.trialSetup(t, seed) : m.angelDescentSetup(seed, { n: Number(params.get('n') ?? 200), ...(params.has('arrive') ? { arrive: Number(params.get('arrive')) } : {}) }));
  });
} else if (params.has('auto')) {
  const scen = params.get('scenario') ?? loadScenarioId();
  startBattle({ seed: Number(params.get('seed') ?? 1), scenarioId: scen, fleets: [loadFleet(), getScenario(scen).enemy], rules: Number(params.get('rules') ?? BATTLE_RULES), cpuV: Number(params.get('cpuV') ?? CPU_BEHAVIOUR) });
} else if (params.has('skirmish')) showSetup();
else if (params.has('sp')) campaign = startCampaign(params.get('sp') === 'new' ? 'sp-new' : 'sp-continue', params.get('name') ?? '테스트 PMC', app, () => showMainMenu());
else showMainMenu();
