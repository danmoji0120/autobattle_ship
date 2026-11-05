import { GameClient, LocalTransport, WsTransport, hasLocalSave, clearLocalSave, type Transport } from './net';
import { StrategicView } from './strategic/view';
import { PmcHud } from './strategic/hud';
import { BattleLink } from './battleLink';
import { sfx } from '../audio/sfx';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const LS = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } } };

export interface Campaign { client: GameClient; view: StrategicView; hud: PmcHud; stop: () => void }

export async function serverAvailable(): Promise<boolean> {
  try { const r = await fetch('./health', { cache: 'no-store' }); if (!r.ok) return false; const j = await r.json(); return !!j.ok; } catch { return false; }
}

export function showMenu(app: HTMLElement, opts: { onSkirmish: () => void; onCampaign: (mode: 'sp-new' | 'sp-continue' | 'mp', name: string) => void }) {
  const saved = hasLocalSave();
  const name = LS.get('siderarium.name') ?? '';
  app.innerHTML = `<div id="menu"><div class="panel mbox">
    <div class="mlogo">SIDERARIUM</div>
    <div class="msub">영속형 우주 PMC 운영 RPG</div>
    <div class="mdesc">몇 척의 낡은 함선과 빚으로 시작한 민간군사기업. 소행성을 캐고, 해적을 사냥하고, 계약을 따내고, 언젠가 당신의 이름이 걸린 정거장을 세운다.<br>
    함선은 직접 조종하지 않는다 — 편대를 만들고, 지휘관을 앉히고, 임무를 맡겨라.</div>
    <div class="mrow"><input id="pmcName" maxlength="20" placeholder="PMC 이름" value="${esc(name)}" /></div>
    <div class="mopt"><b>싱글플레이</b><div class="dim small">브라우저 안에서 같은 서버 시뮬레이션이 돌아간다. 자동 저장되며 배속·일시정지 가능.</div>
      <div class="mrow">${saved ? '<button class="btn go" id="spCont">이어하기</button>' : ''}<button class="btn${saved ? '' : ' go'}" id="spNew">${saved ? '새 세계에서 다시 시작' : '새 PMC 설립'}</button></div></div>
    <div class="mopt"><b>멀티플레이 — 공유 세계</b><div class="dim small" id="mpInfo">서버 확인 중…</div>
      <div class="mrow"><button class="btn" id="mpJoin" disabled>공유 세계 접속</button></div></div>
    <div class="mopt"><b>모의 전투</b><div class="dim small">기존 함대전 단판 모드 (편성 → 전투 → 리플레이).</div><div class="mrow"><button class="btn" id="skirmish">모의 전투</button></div></div>
  </div></div>`;
  const getName = () => { const n = (document.getElementById('pmcName') as HTMLInputElement).value.trim() || '이름 없는 PMC'; LS.set('siderarium.name', n); return n; };
  const unlock = () => sfx.init();
  (document.getElementById('spNew') as HTMLButtonElement).onclick = () => { unlock(); if (!saved || confirm('기존 싱글플레이 세계를 지우고 새로 시작할까요?')) opts.onCampaign('sp-new', getName()); };
  const cont = document.getElementById('spCont') as HTMLButtonElement | null; if (cont) cont.onclick = () => { unlock(); opts.onCampaign('sp-continue', getName()); };
  (document.getElementById('skirmish') as HTMLButtonElement).onclick = () => { unlock(); opts.onSkirmish(); };
  serverAvailable().then(ok => {
    const info = document.getElementById('mpInfo'); const btn = document.getElementById('mpJoin') as HTMLButtonElement | null;
    if (!info || !btn) return;
    if (ok) { info.textContent = '이 서버의 영속 세계에 접속한다. 친구들과 같은 성계에서 각자의 PMC를 운영하며, 접속하지 않아도 함대는 지휘관들이 계속 운용한다.'; btn.disabled = false; btn.classList.add('go'); btn.onclick = () => { unlock(); opts.onCampaign('mp', getName()); }; }
    else info.textContent = '이 주소에는 멀티플레이 서버가 없다 (정적 호스팅). npm start 로 실행한 서버 주소로 접속하면 활성화된다.';
  });
}

export function startCampaign(mode: 'sp-new' | 'sp-continue' | 'mp', name: string, app: HTMLElement, onExit: () => void): Campaign {
  if (mode === 'sp-new') clearLocalSave();
  let t: Transport;
  let tokenKey: string;
  if (mode === 'mp') {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${location.pathname.replace(/[^/]*$/, '')}ws`;
    t = new WsTransport(url);
    tokenKey = 'siderarium.mp.token';
  } else {
    t = new LocalTransport(mode === 'sp-new');
    tokenKey = 'siderarium.sp.token';
  }
  if (mode === 'sp-new') localStorage.removeItem(tokenKey);
  const client = new GameClient(t);
  app.innerHTML = '<div id="loading">SIDERARIUM — 성계 데이터 수신 중…</div>';
  const old = document.getElementById('view')!;
  const canvas = old.cloneNode() as HTMLCanvasElement;
  canvas.style.visibility = 'visible';
  old.replaceWith(canvas);
  const view = new StrategicView(canvas, client);
  let hud: PmcHud | null = null;
  let battle: BattleLink | null = null;
  let raf = 0, last = performance.now(), stopped = false;
  const camp: Campaign = { client, view, hud: null as unknown as PmcHud, stop: () => {} };
  client.onWelcome.push(() => LS.set(tokenKey, client.token));
  client.onSnap.push(() => {
    if (hud || !client.state || !client.company) return;
    hud = new PmcHud(app, client, view, {
      onOpenBattle: eng => {
        if (battle) return;
        hud!.suspend();
        view.active = false;
        battle = new BattleLink(client, eng, () => { battle = null; view.active = true; hud!.resume(); });
      },
      onExit: () => { camp.stop(); onExit(); },
    });
    camp.hud = hud;
    const home = client.state.stations[client.state.companies[client.company]?.homeStation ?? 'astra'];
    if (home) view.focusOn(home.pos, 2600);
    // select the first group so orders are one right-click away
    const g = Object.values(client.state.groups).find(x => x.owner === client.company && !x.parentId);
    if (g) hud.select({ kind: 'group', id: g.id });
    sfx.startMusic();
  });
  client.join(name, LS.get(tokenKey) ?? undefined);
  const loop = (now: number) => {
    if (stopped) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!battle) {
      view.frame(dt);
      hud?.frame(dt);
      sfx.listener = view.rig.camera.position;
      sfx.updateMusic(0.08);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  camp.stop = () => {
    stopped = true; cancelAnimationFrame(raf);
    battle?.close();
    hud?.dispose();
    view.dispose();
    t.close();
    sfx.stopMusic();
  };
  (window as any).siderarium = camp;
  return camp;
}
