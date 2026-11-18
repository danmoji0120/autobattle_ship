import './devCombatLab.css';
import { api } from '../client/account';
import { TECHS } from '../world/industry';
import { BATTLE_RULES } from '../sim/world';
import type { OrderRecord } from '../sim/types';
import { BattleSession } from '../game/session';
import { BattleHUD } from '../ui/battleHud';
import { sfx } from '../audio/sfx';
import { battleSetup, configProblems, defaultConfig, migrateConfig, type Experiment, type LabConfig, type LabPreset, type LabShip } from './labModel';
import { LabSetupScreen } from './labSetup';
import { LabFittingScreen } from './labFitting';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number, digits = 0) => n.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const research = () => Object.values(TECHS).filter(t => !!t.cfx || t.id === 'combined_arms');
const download = (name: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

class CombatLab {
  private config = defaultConfig();
  private worker: Worker | null = null;
  private result: Experiment | null = null;
  private battle: BattleSession | null = null;
  private hud: BattleHUD | null = null;
  private setup: LabSetupScreen | null = null;
  private fitting: LabFittingScreen | null = null;
  private clipboard: LabPreset | null = null;
  private controlsOpen = false;
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private notice = '';
  constructor(private app: HTMLElement, private getCanvas: () => HTMLCanvasElement, private onExit: () => void) {
    this.timer = setInterval(() => { void this.requireGrant(); }, 30_000); this.render();
  }
  private async requireGrant(): Promise<boolean> {
    if (this.disposed) return false;
    try { await api('api/dev-combat/session'); return true; }
    catch { this.dispose(); this.onExit(); return false; }
  }
  private closeViews() { this.fitting?.close(); this.fitting = null; this.setup?.dispose(); this.setup = null; this.app.querySelector('[data-lab-control]')?.remove(); }
  private dispose() { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); this.worker?.terminate(); this.worker = null; this.closeViews(); this.teardownBattle(); this.app.innerHTML = ''; }
  private teardownBattle() { this.hud?.dispose(); this.hud = null; this.battle?.dispose(); this.battle = null; sfx.stopMusic(); document.body.classList.remove('devlab-battle'); this.getCanvas().style.visibility = 'hidden'; }
  private openFitting(ship: LabShip, team: 0 | 1) {
    this.fitting?.close();
    this.fitting = new LabFittingScreen(this.app, ship, this.config.sides[team].research, this.config.presets, {
      apply: (variant, fitting) => { ship.variant = variant; ship.fitting = fitting; },
      close: () => { this.fitting = null; this.setup?.refresh(); }, clipboard: () => this.clipboard,
      copy: p => { this.clipboard = structuredClone(p); }, presetsChanged: () => {},
    });
  }
  private refreshValidation() {
    const problems = configProblems(this.config), panel = this.app.querySelector<HTMLElement>('[data-config-errors]');
    if (panel) { panel.hidden = !problems.length; panel.innerHTML = problems.map(e => `<div>${esc(e)}</div>`).join(''); }
    this.app.querySelectorAll<HTMLButtonElement>('[data-watch],[data-run],[data-run-custom]').forEach(b => { b.disabled = !!problems.length || !!this.worker; });
  }
  private resultHtml(): string {
    const result = this.result; if (!result) return '<p class="dim small">완료된 반복 실험이 없습니다.</p>';
    const s = result.summary;
    const side = (i: 0 | 1) => { const x = s.meanSides[i]; return `<div><b>${i ? 'RED' : 'BLUE'} · 승률 ${pct(s.winRate[i])}</b><span>생존 ${fmt(x.survivors, 2)} · 격침 ${fmt(x.kills, 2)} · 손실 ${fmt(x.destroyed, 2)} · 이탈 ${fmt(x.escaped, 2)}</span><span>가한 피해 ${fmt(x.dealt, 1)} · 받은 피해 ${fmt(x.taken, 1)} · 잔여 내구 ${fmt(x.hull, 1)} / ${fmt(x.maxHull, 1)}</span><span>발사 ${fmt(x.shots, 1)} · 명중 ${fmt(x.hits, 1)} · 요격 ${fmt(x.intercepts, 1)}</span></div>`; };
    const rows = result.battles.slice(0, 30).map((r, i) => `<tr><td>${i + 1}</td><td>${r.seed}</td><td>${r.swapped ? '교환' : '기본'}</td><td>${r.winner === -1 ? '무승부' : r.winner ? 'RED' : 'BLUE'}</td><td>${fmt(r.time, 1)}초</td><td><button class="btn mini" data-replay="${i}">재현</button></td></tr>`).join('');
    return `<div class="dl-summary"><div class="dl-overview"><b>${s.total}회 완료</b><span>BLUE ${s.wins[0]}승 · RED ${s.wins[1]}승 · 무승부 ${s.draws}</span><span>평균 ${fmt(s.meanTime, 1)}초</span></div>${side(0)}${side(1)}</div><p class="dim small">진영별 수치는 전투당 평균입니다. 피해는 엔진이 기록한 선체 피해로, 방어막 흡수량은 포함하지 않습니다. 유폭 피해는 받은 쪽에만 기록될 수 있습니다.</p>
      <div class="dl-resultsbar"><button class="btn" data-export-result>결과 JSON 내보내기</button><label>전투 번호 <input type="number" data-result-index min="1" max="${result.battles.length}" value="1"></label><button class="btn" data-replay-input>선택 결과 재현</button><span class="dim small">아래는 처음 30회 · 전체 시드와 결과는 JSON에 저장</span></div>
      <div class="dl-table"><table><thead><tr><th>번호</th><th>시드</th><th>배치</th><th>승자</th><th>시간</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  private render() {
    if (this.disposed || this.battle) return;
    this.getCanvas().style.visibility = 'hidden';
    if (!this.setup) {
      this.app.innerHTML = '';
      const host = document.createElement('div'); host.className = 'lab-setup-host'; this.app.appendChild(host);
      this.setup = new LabSetupScreen(host, this.config, { fit: (s,t) => this.openFitting(s,t), controls: () => { this.controlsOpen = true; this.render(); }, changed: () => this.refreshValidation() });
    }
    const previous = this.app.querySelector<HTMLElement>('[data-lab-control]');
    if (!this.controlsOpen) { previous?.remove(); return; }
    const scroll = previous?.scrollTop ?? 0;
    const expanded = Array.from(previous?.querySelectorAll<HTMLDetailsElement>('.dl-settings') ?? [], d => d.open);
    const c=this.config, errors=configProblems(c);
    const researchHtml=([0,1] as const).map(team=>`<details class="dl-settings"><summary>${team?'RED':'BLUE'} 연구 보너스</summary><p class="dim small">해금·설계도·재고 조건은 실험에 적용하지 않습니다.</p><div class="dl-research">${research().map(t=>`<label><input type="checkbox" data-research="${team}:${esc(t.id)}" ${c.sides[team].research.includes(t.id)?'checked':''}> ${esc(t.name)}</label>`).join('')}</div></details>`).join('');
    const panel=document.createElement('main');panel.className='dl';panel.dataset.labControl='';
    panel.innerHTML=`<header class="dl-header"><div><span class="dl-kicker">SIDERARIUM / DEVELOPMENT</span><h1>Combat Lab</h1><p>실제 전투 엔진으로 두 함대를 비교합니다. 실험은 브라우저 안에서만 실행됩니다.</p></div><div class="dl-actions"><button class="btn" data-close-controls>← 함대 편성</button><button class="btn" data-default>기본 비교</button><button class="btn" data-export>설정 내보내기</button><label class="btn dl-file">설정 가져오기<input type="file" accept="application/json,.json" data-import></label><button class="btn" data-logout>실험실 잠금</button></div></header>
      ${this.notice&&!this.worker?`<div class="dl-notice" role="status">${esc(this.notice)}</div>`:''}
      <section class="dl-conditions"><div><span class="dl-kicker">EXPERIMENT CONDITIONS</span><h2>전투 조건</h2></div><label>시드<input type="number" min="0" max="2147483647" data-condition="seed" value="${c.seed}"></label><label>기준 거리<input type="number" min="400" max="6000" step="100" data-condition="distance" value="${c.distance}"></label><label>제한 시간 (초)<input type="number" min="10" max="3600" step="10" data-condition="timeLimit" value="${c.timeLimit}"></label><label>관전 배속<select data-condition="speed">${[.5,1,2,4].map(n=>`<option value="${n}"${n===c.speed?' selected':''}>${n}×</option>`).join('')}</select></label><label title="규칙 3에서만 함재기가 출격하고 미공개 항모를 편성할 수 있습니다">전투 규칙<select data-rules><option value="">기본 (규칙 ${BATTLE_RULES})</option><option value="3"${c.rules===3?' selected':''}>규칙 3 — 함재기 시험</option></select></label></section>
      <section class="dl-run">${researchHtml}</section>
      <section class="dl-run"><div><span class="dl-kicker">RUN EXPERIMENT</span><h2>전투 실행</h2><p class="dim small">반복 횟수는 시드 수입니다. 배치 교환을 선택하면 각 시드를 두 번 실행합니다.</p></div><div class="dl-errors" data-config-errors role="alert" ${errors.length?'':'hidden'}>${errors.map(e=>`<div>${esc(e)}</div>`).join('')}</div><div class="dl-runbar"><button class="btn go" data-watch ${errors.length||this.worker?'disabled':''}>전투 관전</button><button class="btn" data-run="10" ${errors.length||this.worker?'disabled':''}>10 시드</button><button class="btn" data-run="100" ${errors.length||this.worker?'disabled':''}>100 시드</button><button class="btn" data-run="1000" ${errors.length||this.worker?'disabled':''}>1,000 시드</button><label>직접 지정 <input type="number" data-custom min="1" max="10000" value="100"></label><button class="btn" data-run-custom ${errors.length||this.worker?'disabled':''}>실행</button><label class="dl-check"><input type="checkbox" data-swap-runs checked> 동일 시드 배치 교환</label></div><div id="dlProgress" role="status">${esc(this.notice)}</div><button class="btn" data-cancel ${this.worker?'':'hidden'}>반복 실험 취소</button></section>
      <section class="dl-results"><div class="dl-sidehead"><div><span class="dl-kicker">BATTLE REPORT</span><h2>실험 결과</h2></div><span class="dim small">${esc(c.content.fingerprint)}</span></div>${this.resultHtml()}</section>`;
    if(previous)previous.replaceWith(panel);else this.app.appendChild(panel);
    panel.onclick=e=>{void this.click(e);};panel.onchange=e=>this.change(e);panel.oninput=e=>{if((e.target as HTMLElement).dataset.condition)this.change(e);};
    panel.querySelectorAll<HTMLDetailsElement>('.dl-settings').forEach((d,i)=>{d.open=expanded[i]??false;});panel.scrollTop=scroll;
  }
  private async click(event: MouseEvent) {
    const button=(event.target as HTMLElement).closest<HTMLElement>('button');if(!button)return;const d=button.dataset;
    if(d.closeControls!==undefined){this.controlsOpen=false;this.render();return;}
    if(d.logout!==undefined){try{await api('api/dev-combat/logout',{});}finally{this.dispose();this.onExit();}return;}
    if(d.default!==undefined){this.closeViews();this.config=defaultConfig();this.result=null;this.notice='';this.render();return;}
    if(d.export!==undefined){download('siderarium-combat-lab.json',this.config);return;}
    if(d.exportResult!==undefined&&this.result){download('siderarium-combat-results.json',this.result);return;}
    if(d.cancel!==undefined){this.worker?.terminate();this.worker=null;this.notice='반복 실험을 취소했습니다.';this.render();return;}
    if(d.watch!==undefined){if(await this.requireGrant())this.startBattle(structuredClone(this.config),this.config.seed,false);return;}
    if(d.run!==undefined||d.runCustom!==undefined){if(!await this.requireGrant())return;const n=d.run!==undefined?Number(d.run):Number(this.app.querySelector<HTMLInputElement>('[data-custom]')?.value);const swap=!!this.app.querySelector<HTMLInputElement>('[data-swap-runs]')?.checked;this.startBatch(n,swap);return;}
    if(d.replay!==undefined||d.replayInput!==undefined){if(!this.result||!await this.requireGrant())return;const i=d.replay!==undefined?Number(d.replay):Number(this.app.querySelector<HTMLInputElement>('[data-result-index]')?.value)-1;const r=this.result.battles[i];if(r)this.startBattle(structuredClone(this.result.config),r.seed,r.swapped);else{this.notice='존재하지 않는 전투 번호입니다.';this.render();}}
  }
  private change(event: Event) {
    const el=event.target as HTMLInputElement|HTMLSelectElement;
    if(el.dataset.import!==undefined&&el instanceof HTMLInputElement){const file=el.files?.[0];if(!file)return;if(file.size>2_000_000){this.notice='설정 파일은 2 MB를 넘을 수 없습니다.';this.render();return;}
      void file.text().then(raw=>{try{const next=migrateConfig(JSON.parse(raw));this.closeViews();this.config=next;this.result=null;this.notice='설정을 가져왔습니다.';}catch(e){this.notice=`가져오기 실패: ${(e as Error).message}`;}this.render();});return;}
    if(el.dataset.condition){(this.config as any)[el.dataset.condition]=Number(el.value);this.refreshValidation();return;}
    // P16.3: rules 3 (strike craft) is explicit per experiment; the setup catalogue shows the carrier only then
    if(el.dataset.rules!==undefined){if(el.value==='3')this.config.rules=3;else delete this.config.rules;this.setup?.refresh();this.refreshValidation();return;}
    if(el.dataset.research){const[team,id]=el.dataset.research.split(':'),side=this.config.sides[Number(team) as 0|1];side.research=(el as HTMLInputElement).checked?[...new Set([...side.research,id])]:side.research.filter(x=>x!==id);this.refreshValidation();}
  }
  private startBatch(count: number, swap: boolean) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) { this.notice = '시드 수는 1~10,000이어야 합니다.'; this.render(); return; }
    const problems = configProblems(this.config); if (problems.length) { this.notice = problems.join(' · '); this.render(); return; }
    this.worker?.terminate();
    const worker = new Worker(new URL('./combatLabWorker.ts', import.meta.url), { type: 'module' }); this.worker = worker;
    this.notice = `0 / ${count * (swap ? 2 : 1)} 전투`; this.render();
    worker.onmessage = event => {
      const message = event.data;
      if (message.type === 'progress') { this.notice = `${fmt(message.done)} / ${fmt(message.total)} 전투 완료`; const progress = this.app.querySelector<HTMLElement>('#dlProgress'); if (progress) progress.textContent = this.notice; }
      else if (message.type === 'complete') { this.result = message.result; this.worker?.terminate(); this.worker = null; this.notice = `${message.result.summary.total}회 완료`; this.render(); }
      else if (message.type === 'error') { this.worker?.terminate(); this.worker = null; this.notice = `실험 실패: ${message.error}`; this.render(); }
    };
    worker.onerror = () => { this.worker?.terminate(); this.worker = null; this.notice = '반복 실험 작업자를 시작하지 못했습니다.'; this.render(); };
    worker.postMessage({ config: structuredClone(this.config), count, swap });
  }

  private startBattle(config: LabConfig, seed: number, swapped: boolean, orders: OrderRecord[] | null = null) {
    const problems = configProblems(config); if (problems.length) { this.notice = problems.join(' · '); this.render(); return; }
    this.worker?.terminate(); this.worker = null; this.teardownBattle();
    this.closeViews(); this.app.innerHTML = ''; this.controlsOpen = true;
    document.body.classList.add('devlab-battle');
    const old = this.getCanvas(), canvas = old.cloneNode() as HTMLCanvasElement; canvas.style.visibility = 'visible'; old.replaceWith(canvas);
    const session = new BattleSession(canvas, battleSetup(config, seed, swapped), sfx); this.battle = session; session.timeScale = config.speed;
    if (orders) session.world.scheduleReplay(orders.map(o => ({ ...o })));
    this.hud = new BattleHUD(this.app, session, { replay: !!orders, inspectAll: true, onExit: () => { this.teardownBattle(); this.render(); },
      onRestart: () => this.startBattle(config, seed, swapped), onReplay: () => this.startBattle(config, seed, swapped, orders ?? session.world.orderLog.slice()) });
    this.app.querySelectorAll<HTMLElement>('[data-sp]').forEach(button => button.classList.toggle('on', Number(button.dataset.sp) === config.speed));
    const back = document.createElement('button'); back.className = 'btn dl-battle-back'; back.textContent = '← 실험 편성'; back.onclick = () => { this.teardownBattle(); this.render(); }; this.app.appendChild(back);
    const inner = session.onFrame; session.onFrame = dt => { inner?.(dt); sfx.listener = session.view.rig.camera.position; sfx.updateMusic(Math.min(1, session.world.intensity / 25)); };
    sfx.startMusic(); session.start();
  }
}

export function startDevCombatLab(app: HTMLElement, getCanvas: () => HTMLCanvasElement, onExit: () => void) { return new CombatLab(app, getCanvas, onExit); }
