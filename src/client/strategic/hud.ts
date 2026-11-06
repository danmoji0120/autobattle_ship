import * as THREE from 'three';
import type { GameClient } from '../net';
import type { StrategicView, Pick } from './view';
import type { WGroup, WShip, Op, Station, Res, WorldEvent, V } from '../../world/types';
import { RES, cargoSum, qty, cargoKeys } from '../../world/types';
import type { WorldView } from '../../server/protocol';
import { SHIP_CLASSES, getLoadout } from '../../sim/data/ships';
import { SPECIALTY_TEXT } from '../../sim/data/commanders';
import { ECON, MODULES, MAX_MODULES, RES_NAME, RES_COLOR, MILESTONES, FOUND_COST } from '../../world/data';
import { sfx } from '../../audio/sfx';
import { secAt, effSec } from '../../world/security';
import { FACTION_NAME, LAIR_FOOTHOLD } from '../../world/factions';
import { secBand } from '../../world/worldgen';
import { sysAt, jumps } from '../../world/geom';
import { morph, trackSelects } from '../../ui/morph';
import { planState, PLAN_STATE_NAME, missing, queueShortfall, plans as planList, matsOf, type Mat } from '../../world/construction';
import { storeHtml, prodHtml, marketHtml as marketPanel, newIndUi, iname, FAC_CATS, yardOwnHtml, fitHtml, researchHtml } from './industryUi';
import { TECHS, ITEMS, EQUIPMENT } from '../../world/industry';
import { FittingScreen } from './fittingUi';
import { CONTENT } from '../../content/registry';
import { checkFitting } from '../../world/fitting';
import { growthOn, econOf } from '../../world/hullops';
import { priceOf } from '../../world/market';
import { pubYardHtml, ownYardGrowthHtml, newGrowthYardUi, exchangeHtml, blueprintsHtml, upkeepTop, upkeepHtml, storageGrowthHtml, sitesHtml } from './growthUi';
import { STATION_CREW_RATE, type ModuleDef } from '../../world/data';

type Mode = null | 'move' | 'dock' | 'mine' | 'haul_from' | 'haul_to' | 'patrol' | 'escort' | 'attack' | 'build' | 'found';
type Sel = { kind: 'group' | 'ship' | 'station' | 'field' | 'lair' | 'battle' | 'gate' | 'planet'; id: string } | null;

const h = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
const fmtT = (t: number) => `${Math.floor(t / 3600) ? Math.floor(t / 3600) + ':' : ''}${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const hpCol = (f: number) => f > 0.6 ? 'var(--good)' : f > 0.3 ? 'var(--warn)' : 'var(--enemy)';

const OP_NAME: Record<string, string> = { idle: '대기', move: '이동', dock: '정박', mine: '채굴', haul: '운송', patrol: '순찰', escort: '호위', attack: '공격', build: '건설', found: '정거장 설립', survey: '탐사', salvage: '인양', raid: '약탈', trade: '교역', guard: '경비' };

export interface PmcHudOpts { onOpenBattle: (eng: string) => void; onExit: () => void; onAccount?: () => void }

/** zones of local security as shown under the cursor (same thresholds as the system bands) */
const secZone = (v: number) => v >= 90 ? { name: '핵심 관리 구역', grade: '안전', color: '#6fe0ff' }
  : v >= 70 ? { name: '일반 거주 구역', grade: '안전', color: '#7dffb0' }
  : v >= 40 ? { name: '변방 구역', grade: '주의', color: '#ffd166' }
  : v >= 15 ? { name: '위험 구역', grade: '위험', color: '#ff8a4c' }
  : { name: '무법 구역', grade: '매우 위험', color: '#ff4a3a' };

export class PmcHud {
  private root: HTMLElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  sel: Sel = null;
  group: string | null = null;      // own group receiving orders
  private mode: Mode = null;
  private haulFrom: string | null = null;
  private refreshT = 0;
  private expanded = new Set<string>();
  private modal: HTMLElement | null = null;
  private modalStation: string | null = null;
  private modalTab = 'market';
  private ind = newIndUi();
  private gy = newGrowthYardUi();
  private upkOpen = false;
  private upkEl: HTMLElement | null = null;
  private tabScroll = new Map<string, number>();
  private pointer = { x: 0, y: 0, down: -1, sx: 0, sy: 0, moved: false, over: false };
  private keys = new Set<string>();
  private disposers: (() => void)[] = [];
  private toastBox: HTMLElement;
  private labels: { x0: number; x1: number; y0: number; y1: number }[] = [];
  private lastSelKey = '';
  private unseen = 0;

  constructor(root: HTMLElement, private c: GameClient, private v: StrategicView, private opts: PmcHudOpts) {
    this.root = root;
    this.overlay = h('canvas') as HTMLCanvasElement;
    this.overlay.id = 'overlay';
    document.body.appendChild(this.overlay);
    this.ctx = this.overlay.getContext('2d')!;
    root.innerHTML = '';
    root.appendChild(h('div', 'panel', '')).id = 'ptop';
    const org = h('div', 'panel'); org.id = 'org'; org.innerHTML = `<div class="ptitle"><span>조직</span><span><button class="btn mini" id="newGroup">+ 새 편대</button></span></div><div id="orgBody" class="scroll"></div>`; root.appendChild(org);
    const sel = h('div', 'panel hidden'); sel.id = 'sel'; root.appendChild(sel);
    const log = h('div', 'panel'); log.id = 'plog'; log.innerHTML = `<div class="ptitle"><span>통신 · 보고</span><span id="logUnread"></span></div><div id="logBody" class="scroll"></div>`; root.appendChild(log);
    const goals = h('div', 'panel'); goals.id = 'goals'; root.appendChild(goals);
    const hint = h('div', 'panel hidden'); hint.id = 'modeHint'; root.appendChild(hint);
    this.toastBox = h('div'); this.toastBox.id = 'toasts'; root.appendChild(this.toastBox);
    const tip = h('div', 'hidden'); tip.id = 'tooltip'; root.appendChild(tip);
    const sysbar = h('div', 'panel'); sysbar.id = 'sysbar'; root.appendChild(sysbar);
    const diag = h('div', 'panel hidden'); diag.id = 'netdiag'; root.appendChild(diag);
    v.onSystemChange = () => { this.sysKey = ''; this.renderSysbar(); };
    (document.getElementById('newGroup') as HTMLButtonElement).onclick = () => this.cmd({ c: 'newGroup', name: '새 편대', parent: null });
    c.onEvents.push(list => this.onEvents(list));
    this.bindInput();
    this.resize();
    for (const e of c.events.slice(-40)) this.addLog(e, false);
    this.onEvents([]);
  }

  dispose() { this.disposers.forEach(d => d()); this.overlay.remove(); this.root.innerHTML = ''; }

  private parked: DocumentFragment | null = null;
  /** detach DOM while a battle view is open (ids are shared with the battle HUD) */
  suspend() {
    if (this.parked) return;
    this.parked = document.createDocumentFragment();
    while (this.root.firstChild) this.parked.appendChild(this.root.firstChild);
    this.overlay.remove();
    this.closeModal();
  }
  resume() {
    if (!this.parked) return;
    this.root.appendChild(this.parked); this.parked = null;
    document.body.appendChild(this.overlay);
    this.lastSelKey = ''; this.orgKey = ''; this.goalsKey = '';
    this.refresh(true);
  }
  get suspended() { return !!this.parked; }

  private get st(): WorldView { return this.c.state!; }
  private get me() { return this.c.company; }
  private myGroups(): WGroup[] { return Object.values(this.st.groups).filter(g => g.owner === this.me); }
  private shipsOf(g: WGroup): WShip[] { return g.shipIds.map(id => this.st.ships[id]).filter(Boolean); }
  private center(g: WGroup): V | null {
    const ss = this.shipsOf(g).filter(s => s.state !== 'battle');
    if (!ss.length) return null;
    const p = { x: 0, y: 0, z: 0 };
    for (const s of ss) { const v = this.v.ships.get(s.id); const q = v ? v.pos : s.pos; p.x += q.x; p.y += q.y; p.z += q.z; }
    return { x: p.x / ss.length, y: p.y / ss.length, z: p.z / ss.length };
  }

  async cmd(c: Parameters<GameClient['cmd']>[0]): Promise<boolean> {
    const err = await this.c.cmd(c);
    if (err) { this.toast(err, 'warn'); sfx.play('click', null, 0.3); return false; }
    sfx.play('confirm', null, 0.5);
    setTimeout(() => this.refresh(true), 60);
    return true;
  }

  // ============================================================== input

  private bindInput() {
    const cv = this.v.renderer.domElement;
    const on = (el: HTMLElement | Window, ev: string, fn: (e: any) => void, o?: any) => { el.addEventListener(ev, fn, o); this.disposers.push(() => el.removeEventListener(ev, fn, o)); };
    on(cv, 'contextmenu', (e: Event) => e.preventDefault());
    on(cv, 'pointerdown', (e: PointerEvent) => { this.pointer.down = e.button; this.pointer.sx = e.clientX; this.pointer.sy = e.clientY; this.pointer.moved = false; cv.setPointerCapture(e.pointerId); });
    // the canvas only gets pointer events where no UI panel covers it
    on(cv, 'pointerleave', () => { this.pointer.over = false; });
    on(cv, 'pointermove', (e: PointerEvent) => {
      this.pointer.over = true;
      const dx = e.clientX - this.pointer.x, dy = e.clientY - this.pointer.y;
      this.pointer.x = e.clientX; this.pointer.y = e.clientY;
      if (this.pointer.down < 0) return;
      if (Math.hypot(e.clientX - this.pointer.sx, e.clientY - this.pointer.sy) > 5) this.pointer.moved = true;
      if (!this.pointer.moved) return;
      if (this.pointer.down === 2) this.v.rig.orbit(dx, dy);
      else this.v.rig.pan(dx, dy);
    });
    on(cv, 'pointerup', (e: PointerEvent) => {
      const b = this.pointer.down; this.pointer.down = -1;
      if (this.pointer.moved) return;
      if (b === 0) this.leftClick(e.clientX, e.clientY);
      else if (b === 2) this.rightClick(e.clientX, e.clientY);
    });
    on(cv, 'dblclick', (e: MouseEvent) => { const p = this.v.pick(e.clientX, e.clientY); if (p) this.v.focusOn(p.pos, p.kind === 'ship' ? 700 : 2200); });
    on(cv, 'wheel', (e: WheelEvent) => { e.preventDefault(); this.v.rig.zoom(Math.exp(e.deltaY * 0.0013)); }, { passive: false });
    on(window, 'resize', () => this.resize());
    on(window, 'keydown', (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      this.keys.add(e.code);
      if (e.code === 'Escape') { if (this.fitScreen) this.fitScreen.close(); else if (this.modal) this.closeModal(); else if (this.mode) this.setMode(null); else this.select(null); }
      if (e.code === 'Space' && this.c.sp) { e.preventDefault(); this.c.setSpeed(this.c.speed > 0 ? 0 : 1); }
      if (this.c.sp && /^Digit[1-4]$/.test(e.code)) this.c.setSpeed([1, 2, 4, 8][Number(e.code.slice(5)) - 1]);
      const keyOps: Record<string, string> = { KeyM: 'move', KeyD: 'dock', KeyN: 'mine', KeyP: 'patrol', KeyG: 'escort', KeyA: 'attack', KeyI: 'idle', KeyT: 'release' };
      if (keyOps[e.code] && this.group) this.opButton(keyOps[e.code]);
      if (e.code === 'KeyH' && this.group) this.focusSelected();
      if (e.code === 'Tab') { e.preventDefault(); this.toggleGalaxy(); }
      if (e.code === 'KeyB') this.toggleBattles();
      if (e.code === 'KeyV') { this.v.showSecurity = !this.v.showSecurity; this.sysKey = ''; this.renderSysbar(); }
      if (e.code === 'F3' || e.code === 'Backquote') { e.preventDefault(); document.getElementById('netdiag')!.classList.toggle('hidden'); }
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
  }

  private resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    this.overlay.width = innerWidth * dpr; this.overlay.height = innerHeight * dpr;
    this.overlay.style.width = innerWidth + 'px'; this.overlay.style.height = innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.v.resize(innerWidth, innerHeight);
  }

  private pirateGroupAt(p: Pick | null): string | null {
    if (p?.kind !== 'ship') return null;
    const s = this.st.ships[p.id];
    return s && s.owner === 'pirates' ? s.groupId : null;
  }

  private leftClick(x: number, y: number) {
    const p = this.v.pick(x, y);
    if (this.mode) { this.applyMode(p, x, y); return; }
    if (!p) { this.select(null); return; }
    if (p.kind === 'ship') {
      const s = this.st.ships[p.id];
      if (s.owner === this.me) { this.group = s.groupId; this.select({ kind: 'ship', id: s.id }); }
      else this.select({ kind: 'ship', id: s.id });
    } else this.select({ kind: p.kind, id: p.id });
  }

  private rightClick(x: number, y: number) {
    if (this.mode) { this.setMode(null); return; }
    if (!this.group) return;
    const g = this.st.groups[this.group]; if (!g) return;
    const p = this.v.pick(x, y);
    const hasMiner = this.subtree(g).some(s => econOf(s).mine > 0);
    const pirate = this.pirateGroupAt(p);
    if (pirate) return void this.setOp({ k: 'attack', group: pirate });
    if (p?.kind === 'field') {
      if (hasMiner) return void this.setOp({ k: 'mine', field: p.id, deliver: '', sell: true, auto: true }); // quick start: automatic unloading & sale (edit in the group panel)
      const f = this.st.fields[p.id];
      return void this.setOp({ k: 'patrol', at: f.pos, radius: f.radius + 400 });
    }
    if (p?.kind === 'station') {
      const s = this.st.stations[p.id];
      if (s.owner === this.me && this.subtree(g).some(x => x.classId === 'constructor') && s.modules.some(m => !m.built)) return void this.setOp({ k: 'build', station: s.id });
      return void this.setOp({ k: 'dock', station: p.id });
    }
    if (p?.kind === 'lair') return void this.setOp({ k: 'attack', lair: p.id });
    if (p?.kind === 'gate') { const to = this.arrivalPoint(p.id); if (to) return void this.setOp({ k: 'move', to }); }
    if (p?.kind === 'ship') { const s = this.st.ships[p.id]; if (s.owner === this.me && s.groupId !== g.id) return void this.setOp({ k: 'escort', group: s.groupId }); }
    const c = this.center(g);
    const pt = this.v.screenToPlane(x, y, c?.y ?? 0);
    if (pt) this.setOp({ k: 'move', to: { x: pt.x, y: c?.y ?? 0, z: pt.z } });
  }

  /** a point just inside the system on the far side of a gate */
  private arrivalPoint(gateId: string): V | null {
    for (const sys of Object.values(this.st.systems)) {
      const g = sys.gates.find(x => x.id === gateId); if (!g) continue;
      const dest = this.st.systems[g.to]; const exit = dest?.gates.find(x => x.id === g.exit); if (!dest || !exit) return null;
      const dx = dest.origin.x - exit.pos.x, dz = dest.origin.z - exit.pos.z, l = Math.hypot(dx, dz) || 1;
      return { x: exit.pos.x + dx / l * 1800, y: 0, z: exit.pos.z + dz / l * 1800 };
    }
    return null;
  }

  /** where to send a group that is ordered to "go to system X": the main public station, else the inner side of the first gate */
  private systemDestination(sysId: string): V {
    const sys = this.st.systems[sysId];
    const st = Object.values(this.st.stations).filter(s => s.public && sysAt(this.st.systems, s.pos)?.id === sysId).sort((a, b) => (b.garrison ?? 0) - (a.garrison ?? 0))[0];
    if (st) return { x: st.pos.x + st.radius + 900, y: 0, z: st.pos.z };
    const g = sys.gates[0];
    const dx = sys.origin.x - g.pos.x, dz = sys.origin.z - g.pos.z, l = Math.hypot(dx, dz) || 1;
    return { x: g.pos.x + dx / l * 4000, y: 0, z: g.pos.z + dz / l * 4000 };
  }

  /** cursor readout: score, zone and a coloured grade */
  private secCursor(p: V): string {
    const v = secAt(this.st, p), z = secZone(v);
    return `<span class="sectip"><b style="color:${z.color}">지역 치안 ${Math.round(v)}</b> · ${z.name} <i style="background:${z.color}">${z.grade}</i></span>`;
  }

  private secLine(p: V): string {
    const v = secAt(this.st, p), b = secBand(v);
    return `<span style="color:${b.color}">지역 치안 ${Math.round(v)} · ${b.name.replace(' 성계', '')}</span>`;
  }

  private groupSys(g: WGroup): string | undefined { const c = this.center(g) ?? this.shipsOf(g).map(s => s.pos)[0]; return c ? sysAt(this.st.systems, c)?.id : undefined; }

  // ============================================================== system bar · galaxy map · diagnostics

  private sysKey = '';
  private renderSysbar() {
    const sys = this.v.sys; if (!sys) return;
    const live = this.st.systems[sys.id] ?? sys;
    const eff = effSec(live), band = secBand(eff);
    const nb = Object.values(this.st.engagements).filter(e => !e.done).length;
    const key = `${sys.id}|${Math.round(eff)}|${Math.round(live.heat)}|${this.v.showSecurity}|${nb}`;
    if (key === this.sysKey) return;
    this.sysKey = key;
    const el = document.getElementById('sysbar')!;
    const heat = live.heat > 25 ? `<span class="warn">해적 활동 증가</span>` : live.heat > 8 ? '<span class="dim">해적 활동 있음</span>' : '';
    el.innerHTML = `<div class="sysname"><b>${esc(sys.name)}</b> <span class="secb" style="background:${band.color}">${band.name} · 치안 ${Math.round(eff)}</span> ${heat}</div>
      <div class="sysbtns"><button class="btn mini" id="galBtn" title="Tab">성계 지도</button><button class="btn mini${this.v.showSecurity ? ' on' : ''}" id="secBtn" title="V">치안 지도</button><button class="btn mini${nb ? ' hot' : ''}" id="batBtn" title="B">⚔ 교전${nb ? ` ${nb}` : ''}</button></div>`;
    (document.getElementById('batBtn') as HTMLButtonElement).onclick = () => this.toggleBattles();
    (document.getElementById('galBtn') as HTMLButtonElement).onclick = () => this.toggleGalaxy();
    (document.getElementById('secBtn') as HTMLButtonElement).onclick = () => { this.v.showSecurity = !this.v.showSecurity; this.sysKey = ''; this.renderSysbar(); };
  }

  // ── battle list: every running fight (spectate) and the recent record (replay) ──
  private battles: HTMLElement | null = null;
  toggleBattles() {
    if (this.battles) { this.battles.remove(); this.battles = null; return; }
    this.battles = h('div', 'modal battles');
    this.root.appendChild(this.battles);
    trackSelects(this.battles);
    this.battles.onclick = e => {
      const t = e.target as HTMLElement;
      if (t === this.battles) return this.toggleBattles();
      const b = t.closest<HTMLElement>('[data-watch]');
      if (b) { const id = b.dataset.watch!; this.toggleBattles(); this.opts.onOpenBattle(id); return; }
      const f = t.closest<HTMLElement>('[data-bfocus]');
      if (f) { const e2 = this.st.engagements[f.dataset.bfocus!]; if (e2) { this.v.focusOn(e2.pos, 2600); this.toggleBattles(); } }
      if (t.closest('[data-a="close"]')) this.toggleBattles();
    };
    this.renderBattles();
  }

  private battleSides(e: { sides: [string[], string[]]; names?: [string, string] }): [string, string] {
    const st = this.st;
    return e.names ?? [0, 1].map(i => e.sides[i].map(c => st.companies[c]?.name ?? c).join(', ')) as [string, string];
  }

  private renderBattles() {
    const el = this.battles; if (!el) return;
    const st = this.st;
    const sysName = (p: V) => sysAt(st.systems, p)?.name ?? '심우주';
    const bar = (a: number, b: number) => `<div class="bbar"><i style="width:${Math.round(a * 100)}%"></i><em style="width:${Math.round(b * 100)}%"></em></div>`;
    const live = Object.values(st.engagements).filter(e => !e.done).sort((a, b) => (b.prog ? b.prog.total[0] + b.prog.total[1] : 0) - (a.prog ? a.prog.total[0] + a.prog.total[1] : 0));
    const rows = live.map(e => {
      const [na, nb] = this.battleSides(e);
      const mine = e.sides[0].includes(this.me) || e.sides[1].includes(this.me);
      const p = e.prog;
      const t = Math.max(0, Math.round((st.time - e.start)));
      const watchable = e.autoEnd === undefined;
      return `<div class="brow" data-b="${e.id}">
        <div class="bh"><b>${esc(na)}</b> <span class="dim">vs</span> <b class="en">${esc(nb)}</b>${mine ? ' <span class="tag">아군 참전</span>' : ''}</div>
        <div class="bm dim">${esc(sysName(e.pos))} · ${Math.floor(t / 60)}분 ${t % 60}초 경과${p ? ` · 잔존 ${p.alive[0]}/${p.total[0]} 대 ${p.alive[1]}/${p.total[1]}척` : ''}</div>
        ${p ? bar(p.value[0], p.value[1]) : ''}
        <div class="bb"><button class="btn mini" data-bfocus="${e.id}">위치 보기</button>${watchable ? `<button class="btn mini go" data-watch="${e.id}">${mine ? '전투 지휘' : '관전'}</button>` : '<span class="dim">원거리 판정 (관전 불가)</span>'}</div></div>`;
    }).join('') || '<div class="dim" style="padding:10px">현재 진행 중인 교전이 없습니다.</div>';
    const log = (st.battleLog ?? []).slice().reverse();
    const recs = log.map(r => {
      const ago = Math.max(0, Math.round((st.time - r.end) / 60));
      const res = r.winner === 0 ? `<b>${esc(r.names[0])}</b> 승리` : r.winner === 1 ? `<b class="en">${esc(r.names[1])}</b> 승리` : '무승부';
      return `<div class="brow rec" data-r="${r.id}"><div class="bh">${esc(r.names[0])} <span class="dim">vs</span> <span class="en">${esc(r.names[1])}</span></div>
        <div class="bm dim">${esc(r.sys ? st.systems[r.sys]?.name ?? '' : sysName(r.pos))} · ${ago ? ago + '분 전' : '방금'} · ${res} · 손실 ${r.losses[0]} / ${r.losses[1]}척 (총 ${r.n}척)</div>
        <div class="bb"><button class="btn mini" data-watch="${r.id}">▶ 리플레이</button></div></div>`;
    }).join('') || '<div class="dim" style="padding:10px">아직 기록된 전투가 없습니다.</div>';
    morph(el, `<div class="box bl">
      <div class="mh"><b>⚔ 교전 현황</b><span class="dim">관전은 전투 결과에 영향을 주지 않습니다 · 관전을 끝내도 전투는 계속됩니다</span><button class="btn mini" data-a="close">닫기 (B)</button></div>
      <h3>진행 중 (${live.length})</h3><div class="blist">${rows}</div>
      <h3>최근 전투 기록 (${log.length})</h3><div class="blist">${recs}</div></div>`);
  }

  private galaxy: HTMLElement | null = null;
  toggleGalaxy() {
    if (this.galaxy) { this.galaxy.remove(); this.galaxy = null; return; }
    this.galaxy = h('div', 'modal galaxy');
    this.root.appendChild(this.galaxy);
    this.galaxy.onclick = e => { if (e.target === this.galaxy) this.toggleGalaxy(); };
    this.renderGalaxy();
  }

  private renderGalaxy() {
    const el = this.galaxy; if (!el) return;
    const st = this.st;
    const W = Math.min(980, innerWidth - 40), H = Math.min(560, innerHeight - 160);
    const P = (s: { map: { x: number; y: number } }) => ({ x: 60 + s.map.x * (W - 120), y: 40 + s.map.y * (H - 80) });
    const g = this.group ? st.groups[this.group] : null;
    const gSys = g ? this.groupSys(g) : undefined;
    const mine = (sid: string) => Object.values(st.ships).filter(s => s.owner === this.me && sysAt(st.systems, s.pos)?.id === sid).length;
    const myStations = (sid: string) => Object.values(st.stations).filter(s => s.owner === this.me && sysAt(st.systems, s.pos)?.id === sid).length;
    let svg = `<svg width="${W}" height="${H}" class="galsvg">`;
    const done = new Set<string>();
    for (const s of Object.values(st.systems)) for (const gt of s.gates) {
      const k = [s.id, gt.to].sort().join(); if (done.has(k)) continue; done.add(k);
      const a = P(s), b = P(st.systems[gt.to]);
      svg += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#4a7aa0" stroke-width="2" stroke-dasharray="6 5" opacity=".7"/>`;
    }
    for (const s of Object.values(st.systems)) {
      const p = P(s), eff = effSec(s), band = secBand(eff);
      const here = this.v.sys?.id === s.id;
      svg += `<g class="gnode" data-sys="${s.id}" style="cursor:pointer">
        <circle cx="${p.x}" cy="${p.y}" r="${here ? 30 : 24}" fill="${band.color}" opacity=".16"/>
        <circle cx="${p.x}" cy="${p.y}" r="11" fill="${s.star.color}" stroke="${band.color}" stroke-width="3"/>
        ${here ? `<circle cx="${p.x}" cy="${p.y}" r="34" fill="none" stroke="#fff" stroke-width="1" opacity=".6"/>` : ''}
        <text x="${p.x}" y="${p.y - 38}" text-anchor="middle" fill="#e8f4ff" font-size="14" font-weight="700">${esc(s.name)}</text>
        <text x="${p.x}" y="${p.y + 44}" text-anchor="middle" fill="${band.color}" font-size="12">${band.name} · 치안 ${Math.round(eff)}</text>
        ${mine(s.id) || myStations(s.id) ? `<text x="${p.x}" y="${p.y + 60}" text-anchor="middle" fill="#5fd4ff" font-size="11">자사 함선 ${mine(s.id)}${myStations(s.id) ? ` · 기지 ${myStations(s.id)}` : ''}</text>` : ''}
      </g>`;
    }
    svg += '</svg>';
    const sel = this.galSel && st.systems[this.galSel] ? st.systems[this.galSel] : this.v.sys ? st.systems[this.v.sys.id] : null;
    let info = '';
    if (sel) {
      const eff = effSec(sel);
      const stations = Object.values(st.stations).filter(x => sysAt(st.systems, x.pos)?.id === sel.id);
      const fields = Object.values(st.fields).filter(x => !x.salvage && sysAt(st.systems, x.pos)?.id === sel.id);
      const lairs = Object.values(st.lairs).filter(x => sysAt(st.systems, x.pos)?.id === sel.id);
      const hops = gSys ? jumps(st.systems, gSys, sel.id) : 0;
      info = `<div class="galinfo"><div class="stitle">${esc(sel.name)} <span class="secb" style="background:${secBand(eff).color}">${secBand(eff).name} · 치안 ${Math.round(eff)} (기본 ${sel.security})</span></div>
        <div class="dim">${esc(sel.desc)}</div>
        <div class="svc">정거장: ${stations.map(x => esc(x.name) + (x.tax ? ` <span class="dim">(세금 ${Math.round(x.tax * 100)}%)</span>` : '')).join(', ') || '없음'}</div>
        <div class="svc">자원: ${fields.map(f => `${esc(f.name)} <span style="color:${RES_COLOR[f.res]}">${RES_NAME[f.res]}</span>${(f.rich ?? 1) > 1 ? ` <span class="good">×${(f.rich ?? 1).toFixed(2)}</span>` : (f.rich ?? 1) < 1 ? ` <span class="dim">×${(f.rich ?? 1).toFixed(2)}</span>` : ''}`).join(' · ')}</div>
        ${lairs.length ? `<div class="svc warn">해적 거점: ${lairs.map(l => `${esc(l.name)}${l.alive ? '' : ` (파괴됨${(sel.inf?.pirates ?? 0) < LAIR_FOOTHOLD ? ' — 해적 세력이 약해 재건 불가' : ''})`}`).join(', ')}</div>` : ''}
        ${sel.inf ? `<div class="svc">세력 판도 ${(['union', 'pirates', 'guild'] as const).map(k => `<span class="infb" title="${FACTION_NAME[k]}"><b style="color:${k === 'union' ? '#7fb0ff' : k === 'pirates' ? '#ff4a3a' : '#e8c070'}">${FACTION_NAME[k]}</b> <i><u style="width:${Math.round(sel.inf![k])}%;background:${k === 'union' ? '#7fb0ff' : k === 'pirates' ? '#ff4a3a' : '#e8c070'}"></u></i> ${Math.round(sel.inf![k])}</span>`).join(' ')}${(sel.recoverUntil ?? 0) > st.time ? ' <span class="good">· 재건 호황 (시장 공급 증가)</span>' : ''}</div>` : ''}
        <div class="svc dim">최근 기록 — 해적 격침 ${sel.stats.pirateKills} · 연합 손실 ${sel.stats.unionLosses} · 민간 피해 ${sel.stats.civLosses}${sel.heat > 1 ? ` · 해적 활동도 ${Math.round(sel.heat)}` : ''}</div>
        <div class="mrow"><button class="btn go" data-view="${sel.id}">이 성계 보기</button>
        ${g && g.owner === this.me ? `<button class="btn" data-goto="${sel.id}" ${gSys === sel.id ? 'disabled' : ''}>${esc(g.name)} 이동 (${hops}회 점프)</button>` : '<span class="dim small">편대를 선택하면 이 성계로 이동을 명령할 수 있습니다.</span>'}</div></div>`;
    }
    morph(el, `<div class="panel sbox gbox"><div class="shdr"><div><div class="stitle">성계 지도</div><div class="dim">점프게이트로 연결된 성계들. 치안이 낮을수록 자원과 보수가 크지만 해적이 강하다. 클릭: 정보 · 더블클릭: 이동해서 보기</div></div><button class="btn" data-close>✕</button></div>${svg}${info}</div>`);
    el.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => this.toggleGalaxy();
    el.querySelectorAll<SVGGElement>('[data-sys]').forEach(n => {
      // property handlers: the map is morphed in place, so listeners must not pile up
      n.onclick = () => { this.galSel = n.dataset.sys!; this.renderGalaxy(); };
      n.ondblclick = () => { this.v.setSystem(n.dataset.sys!); this.toggleGalaxy(); };
    });
    const vb = el.querySelector<HTMLButtonElement>('[data-view]'); if (vb) vb.onclick = e => { this.v.setSystem((e.target as HTMLElement).dataset.view!); this.toggleGalaxy(); };
    const gb = el.querySelector<HTMLButtonElement>('[data-goto]'); if (gb) gb.onclick = e => { const id = (e.target as HTMLElement).dataset.goto!; this.setOp({ k: 'move', to: this.systemDestination(id) }); this.toggleGalaxy(); };
  }
  private galSel: string | null = null;

  private diagT = 0;
  private renderDiag(dt: number) {
    const el = document.getElementById('netdiag')!;
    if (el.classList.contains('hidden')) return;
    this.diagT -= dt; if (this.diagT > 0) return; this.diagT = 0.5;
    const fm = this.v.frameMs, avg = fm.reduce((a, b) => a + b, 0) / Math.max(1, fm.length), mx = Math.max(0, ...fm);
    const ck = this.c.clock, sv = this.c.net.server;
    const buf = (ck.latestAt - ck.renderTime) / Math.max(0.01, ck.rate);
    const row = (k: string, v: string, warn = false) => `<div class="kv2"><span>${k}</span><b${warn ? ' class="warn"' : ''}>${v}</b></div>`;
    el.innerHTML = `<div class="ptitle"><span>진단 (F3)</span></div>
      <div class="dh">클라이언트 렌더링</div>
      ${row('렌더 CPU 시간', `${avg.toFixed(1)} ms (최대 ${mx.toFixed(0)})`, avg > 14)}
      ${row('FPS', `${Math.round(1000 / Math.max(1, this.frameGap))}`, this.frameGap > 34)}
      <div class="dh">네트워크</div>
      ${row('왕복 지연 (RTT)', this.c.t.kind === 'local' ? '로컬' : `${Math.round(this.c.net.rtt)} ms`, this.c.net.rtt > 250)}
      ${row('패킷 간격', `${(ck.gapMean * 1000).toFixed(0)} ms ± ${(ck.gapJitter * 1000).toFixed(0)}`, ck.gapJitter > 0.12)}
      ${row('보간 버퍼', `${(buf * 1000).toFixed(0)} ms (목표 ${(ck.delayReal * 1000).toFixed(0)})`)}
      ${row('버퍼 고갈 / 재동기', `${ck.starved} / ${ck.corrections}`, ck.starved > 50)}
      ${row('수신량', sv ? `${(sv.bytes / 1024).toFixed(1)} KB/s` : '-')}
      ${row('스냅샷 크기', this.c.net.snapBytes ? `${(this.c.net.snapBytes / 1024).toFixed(1)} KB` : '-')}
      <div class="dh">서버</div>
      ${row('틱 처리 시간', sv ? `${sv.tickMs.toFixed(2)} ms (최대 ${sv.tickMax.toFixed(0)})` : '-', !!sv && sv.tickMax > 100)}
      ${row('NPC 전투 연산', sv?.battleMs !== undefined ? `${sv.battleMs.toFixed(2)} ms/틱 · 진행 중 ${Object.values(this.st.engagements).filter(e => !e.done).length}건` : '-', !!sv && (sv.battleMs ?? 0) > 8)}
      ${row('월드 진행 속도', sv ? `${(sv.rate / Math.max(0.01, this.c.speed)).toFixed(2)}× 실시간` : '-', !!sv && this.c.speed > 0 && sv.rate / this.c.speed < 0.95)}
      ${row('함선 / 전투 / 접속', sv ? `${sv.ships} / ${sv.battles} / ${sv.conns}` : '-')}
      <div class="dim small">서버 진행 속도가 1.0 미만이면 서버 과부하, 패킷 간격 편차가 크면 네트워크, FPS만 낮으면 클라이언트 렌더링 문제입니다.</div>`;
  }
  private frameGap = 16;
  private lastFrameAt = 0;

  private subtree(g: WGroup): WShip[] {
    const out = this.shipsOf(g);
    for (const cid of g.childIds) { const cg = this.st.groups[cid]; if (cg) out.push(...this.subtree(cg)); }
    return out;
  }

  private async setOp(op: Op) {
    if (!this.group) return;
    if (await this.cmd({ c: 'setOp', group: this.group, op })) this.setMode(null);
  }

  private applyMode(p: Pick | null, x: number, y: number) {
    const m = this.mode;
    const g = this.group ? this.st.groups[this.group] : null;
    if (!g) return this.setMode(null);
    const c = this.center(g);
    const plane = () => { const pt = this.v.screenToPlane(x, y, c?.y ?? 0); return pt ? { x: pt.x, y: c?.y ?? 0, z: pt.z } : null; };
    switch (m) {
      case 'move': { const pt = plane(); if (pt) this.setOp({ k: 'move', to: pt }); return; }
      case 'patrol': { if (p?.kind === 'field') { const f = this.st.fields[p.id]; this.setOp({ k: 'patrol', at: f.pos, radius: f.radius + 400 }); return; } const pt = plane(); if (pt) this.setOp({ k: 'patrol', at: pt, radius: 900 }); return; }
      case 'dock': if (p?.kind === 'station') this.setOp({ k: 'dock', station: p.id }); else this.hint('정박할 정거장을 클릭하세요'); return;
      case 'mine': if (p?.kind === 'field') { this.mineForm = { group: g.id, field: p.id, deliver: 'auto', sell: this.mineForm?.sell ?? true, live: false, t: performance.now() }; this.setMode(null); this.hint('하역 목적지와 하역 방식을 고른 뒤 「작업 시작」을 누르세요'); this.refresh(true); } else this.hint('소행성 지대를 클릭하세요'); return;
      case 'haul_from': if (p?.kind === 'station') { this.haulFrom = p.id; this.mode = 'haul_to'; this.hint('운송 목적지 정거장을 클릭하세요'); } else this.hint('출발 정거장을 클릭하세요'); return;
      case 'haul_to': if (p?.kind === 'station' && this.haulFrom) this.openHaulRes(this.haulFrom, p.id); else this.hint('목적지 정거장을 클릭하세요'); return;
      case 'escort': { const s = p?.kind === 'ship' ? this.st.ships[p.id] : null; if (s && s.owner === this.me && s.groupId !== g.id) this.setOp({ k: 'escort', group: s.groupId }); else this.hint('호위할 자사 함선을 클릭하세요'); return; }
      case 'attack': { const pg = this.pirateGroupAt(p); if (pg) this.setOp({ k: 'attack', group: pg }); else if (p?.kind === 'lair') this.setOp({ k: 'attack', lair: p.id }); else this.hint('해적 함선이나 은신처를 클릭하세요'); return; }
      case 'build': if (p?.kind === 'station' && this.st.stations[p.id].owner === this.me) this.setOp({ k: 'build', station: p.id }); else this.hint('자사 정거장을 클릭하세요'); return;
      case 'found': {
        const pt = plane(); if (!pt) return;
        const name = prompt('새 정거장 이름', `${this.st.companies[this.me].name} 기지`);
        if (name !== null) this.setOp({ k: 'found', at: pt, name: name || '전진기지' });
        return;
      }
    }
  }

  /** what to carry: a chooser listing the goods actually stored at the origin, plus the two bulk modes */
  private openHaulRes(from: string, to: string) {
    this.setMode(null);
    const A = this.st.stations[from], B = this.st.stations[to];
    const store = A.storage[this.me] ?? {};
    const logi = [A, B].some(x => x.owner === this.me && x.modules.some(m => m.kind === 'logistics' && m.built));
    const items = cargoKeys(store).filter(k => store[k] >= 1).sort((x, y) => store[y] - store[x]);
    document.getElementById('haulPick')?.remove();
    const box = h('div', 'panel haulpick');
    box.id = 'haulPick';
    box.innerHTML = `<div class="shdr"><b>운송: ${esc(A.name)} → ${esc(B.name)}</b><button class="btn" data-x>✕</button></div>
      <div class="hpl"><button class="btn${logi ? '' : ' locked'}" data-hr="*auto" ${logi ? '' : 'disabled'}><b>자동 보급</b><div class="dim small">${logi ? `${esc(B.name)}의 생산·건설에 부족한 원료만 골라 실어 나름` : '물류센터(출발지나 목적지)가 필요'}</div></button>
      <button class="btn" data-hr="*all"><b>전 품목</b><div class="dim small">출발지 보관품을 모두 옮김</div></button>
      ${items.map(k => `<button class="btn" data-hr="${k}">${iname(k)} <span class="dim">${fmt(store[k])}</span></button>`).join('') || '<div class="dim small">출발지 보관함이 비어 있습니다 (지금 비어 있어도 품목을 지정해 둘 수 있음)</div>'}</div>
      <div class="frow"><input class="search" data-hq placeholder="다른 품목 이름 입력 후 Enter"></div>`;
    document.body.appendChild(box);
    box.querySelector<HTMLButtonElement>('[data-x]')!.onclick = () => box.remove();
    box.querySelectorAll<HTMLButtonElement>('[data-hr]').forEach(b => b.onclick = () => { this.setOp({ k: 'haul', from, to, res: b.dataset.hr! }); box.remove(); });
    const q = box.querySelector<HTMLInputElement>('[data-hq]')!;
    q.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const id = Object.keys(ITEMS).find(k => ITEMS[k].name === q.value.trim() || k === q.value.trim());
      if (id) { this.setOp({ k: 'haul', from, to, res: id }); box.remove(); } else this.toast('그런 품목이 없습니다', 'warn');
    };
  }

  private hint(t: string) { const e = document.getElementById('modeHint')!; e.textContent = t; e.classList.remove('hidden'); }
  private setMode(m: Mode) {
    this.mode = m;
    const e = document.getElementById('modeHint')!;
    const txt: Record<string, string> = {
      move: '이동 지점 클릭', dock: '정박할 정거장 클릭', mine: '채굴할 소행성 지대 클릭 → 하역 목적지·방식 설정', haul_from: '운송 출발 정거장 클릭',
      patrol: '순찰 지점 또는 소행성 지대 클릭', escort: '호위할 자사 함선 클릭', attack: '해적 함선 또는 은신처 클릭', build: '건설할 자사 정거장 클릭',
      found: `정거장 부지 클릭 — 다른 정거장과 2,600 이상 떨어져야 함 (비용 ${fmt(FOUND_COST.credits)} cr + 합금 ${FOUND_COST.alloy})`,
    };
    if (m) { e.textContent = txt[m] + ' · 우클릭/Esc 취소'; e.classList.remove('hidden'); this.v.renderer.domElement.style.cursor = 'crosshair'; }
    else { e.classList.add('hidden'); this.v.renderer.domElement.style.cursor = ''; }
    this.refresh(true);
  }

  select(s: Sel) {
    this.sel = s;
    if (s?.kind === 'group') this.group = s.id;
    this.refresh(true);
  }

  private focusSelected() {
    const g = this.group ? this.st.groups[this.group] : null;
    const c = g ? this.center(g) : null;
    if (c) this.v.focusOn(c, Math.min(this.v.rig.dist, 2500));
  }

  private opButton(k: string) {
    sfx.play('click', null, 0.3);
    const g = this.group ? this.st.groups[this.group] : null;
    if (!g) return;
    switch (k) {
      case 'idle': this.setOp({ k: 'idle' }); break;
      case 'release': this.cmd({ c: 'release', group: g.id }); break;
      case 'haul': this.setMode('haul_from'); break;
      default: this.setMode(this.mode === k ? null : k as Mode);
    }
  }

  // ============================================================== events / toasts

  private onEvents(list: WorldEvent[]) {
    for (const e of list) {
      this.addLog(e, true);
      if (this.parked) continue;
      if (e.kind === 'battle' && e.text.startsWith('교전 발생') && e.ref) this.battleToast(e);
      else if (e.kind === 'milestone') { this.toast(`★ ${e.text}`, 'good'); sfx.play('win', null, 0.35); }
      else if (e.kind === 'world' && e.text.includes('파괴되었다')) this.toast(e.text, 'world');
      if (e.tag === 'build_secured') { this.toast(`▣ ${e.text}`, 'good'); sfx.play('confirm', null, 0.35); }
      else if (e.tag === 'build_start') { sfx.play('drum', null, 0.4); if (e.pos) this.v.flashAt(e.pos, 0x60d0ff); }
      else if (e.tag === 'build_done') { this.toast(`✔ ${e.text}`, 'good'); sfx.play('win', null, 0.3); if (e.pos) this.v.flashAt(e.pos, 0x9fffb0); }
      if (e.kind === 'radio' || e.kind === 'warn') sfx.play('radio', null, e.kind === 'warn' ? 0.45 : 0.18);
      if (e.kind === 'money' && /\+/.test(e.text)) sfx.play('confirm', null, 0.15);
    }
  }

  private addLog(e: WorldEvent, live: boolean) {
    const body = (this.parked?.querySelector('#logBody') as HTMLElement | null) ?? document.getElementById('logBody'); if (!body) return;
    const icon: Record<string, string> = { radio: '◉', info: 'ℹ', warn: '⚠', battle: '⚔', money: '¤', world: '◈', milestone: '★' };
    const el = h('div', `ev ev-${e.kind}`);
    el.innerHTML = `<span class="t">${fmtT(e.t)}</span><span class="ic">${icon[e.kind]}</span><div>${e.who ? `<div class="who" style="color:${e.color ?? 'var(--dim)'}">${esc(e.who)}</div>` : ''}<div class="tx">${esc(e.text)}</div></div>`;
    if (e.pos) el.onclick = () => { this.v.focusOn(e.pos!, Math.min(this.v.rig.dist, 3000)); if ((e.kind === 'battle' || e.kind === 'world') && e.ref && this.st.engagements[e.ref] && !this.st.engagements[e.ref].done) this.opts.onOpenBattle(e.ref); else if (e.ref && this.st.groups[e.ref]?.owner === this.me) this.select({ kind: 'group', id: e.ref }); };
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    body.appendChild(el);
    while (body.children.length > 160) body.firstChild!.remove();
    if (atBottom || !live) body.scrollTop = body.scrollHeight;
  }

  toast(text: string, kind: 'warn' | 'good' | 'world' | 'info' = 'info') {
    const t = h('div', `toast panel t-${kind}`, esc(text));
    this.toastBox.appendChild(t);
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 5000);
  }

  private battleToast(e: WorldEvent) {
    const t = h('div', 'toast panel t-battle');
    t.innerHTML = `<div><b>⚔ 교전 발생</b><br>${esc(e.text.replace('교전 발생! ', ''))}</div><button class="btn go">전투 지휘</button>`;
    t.querySelector('button')!.onclick = () => { t.remove(); this.opts.onOpenBattle(e.ref!); };
    this.toastBox.appendChild(t);
    sfx.play('alarm', null, 0.6);
    sfx.play('radio', null, 0.6);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 800); }, 14000);
  }

  // ============================================================== periodic DOM refresh

  frame(dt: number) {
    if (!this.c.state || this.parked) return;
    const rig = this.v.rig;
    const sp = rig.dist * 0.9 * dt;
    if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) rig.pan(0, sp);
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) rig.pan(0, -sp);
    if (this.keys.has('ArrowLeft')) rig.pan(sp, 0);
    if (this.keys.has('ArrowRight')) rig.pan(-sp, 0);
    this.refreshT -= dt;
    if (this.refreshT <= 0) { this.refreshT = 0.4; this.refresh(false); if (this.galaxy) this.renderGalaxy(); if (this.battles) this.renderBattles(); }
    const now = performance.now(); if (this.lastFrameAt) this.frameGap += (now - this.lastFrameAt - this.frameGap) * 0.1; this.lastFrameAt = now;
    this.pingT -= dt; if (this.pingT <= 0) { this.pingT = 2; this.c.ping(); }
    this.drawOverlay();
    this.tooltip();
    this.renderDiag(dt);
  }

  private pingT = 0;
  refresh(force: boolean) {
    if (!this.c.state) return;
    this.renderSysbar();
    this.renderTop();
    this.renderOrg();
    this.renderSel(force);
    this.renderGoals();
    if (this.modal && this.modalStation) this.renderModal(force);
    this.renderUpkeep(force);
    this.fitScreen?.update();
  }

  private renderTop() {
    const co = this.st.companies[this.me];
    if (!co) return;
    const stores = Object.values(this.st.stations).reduce((a, s) => { const x = s.storage[this.me]; if (x) for (const r of RES) a[r] += qty(x, r); return a; }, { ore: 0, alloy: 0, crystal: 0 } as Record<Res, number>);
    const ships = Object.values(this.st.ships).filter(s => s.owner === this.me);
    const players = this.c.players.filter(p => p.id !== this.me);
    const el = document.getElementById('ptop')!;
    const spd = this.c.speed;
    el.innerHTML = `
      <div class="co"><span class="dot" style="background:${co.color}"></span><b>${esc(co.name)}</b><small>민간군사기업</small></div>
      <div class="kv"><span>자금</span><b class="money">${fmt(co.credits)} <small>cr</small></b></div>
      <div class="kv"><span>함선</span><b>${ships.length}</b></div>
      <div class="kv"><span>연합 평판</span><b>${co.rep}</b></div>
      ${growthOn(this.st) ? upkeepTop(this.st, this.me) : ''}
      ${RES.map(r => `<div class="kv"><span style="color:${RES_COLOR[r]}">${RES_NAME[r]}</span><b>${fmt(stores[r])}</b></div>`).join('')}
      <div class="kv"><span>성계 시각</span><b>${fmtT(this.st.time)}</b></div>
      ${this.c.sp ? `<div class="speedgrp">${[[0, '❚❚'], [1, '1×'], [2, '2×'], [4, '4×'], [8, '8×']].map(([v, l]) => `<button class="btn${spd === v ? ' on' : ''}" data-spd="${v}">${l}</button>`).join('')}</div>`
        : `<div class="kv"><span>접속 중</span><b>${this.c.players.filter(p => p.online).length}명</b></div>${players.map(p => `<span class="dot" title="${esc(p.name)}${p.online ? '' : ' (오프라인)'}" style="background:${p.color};opacity:${p.online ? 1 : 0.3}"></span>`).join('')}`}
      ${this.opts.onAccount ? '<button class="btn" id="acctBtn" title="계정 정보 · 비밀번호 변경 · 로그아웃">계정</button>' : ''}
      <button class="btn" id="menuBtn" title="메인 메뉴 (자동 저장됨)">☰</button>`;
    el.querySelectorAll<HTMLButtonElement>('[data-spd]').forEach(b => b.onclick = () => this.c.setSpeed(Number(b.dataset.spd)));
    const uk = el.querySelector<HTMLElement>('[data-upkeep]'); if (uk) uk.onclick = () => { this.upkOpen = !this.upkOpen; this.renderUpkeep(true); };
    const ab = document.getElementById('acctBtn') as HTMLButtonElement | null; if (ab) ab.onclick = () => this.opts.onAccount?.();
    (document.getElementById('menuBtn') as HTMLButtonElement).onclick = () => this.opts.onExit();
  }

  private upkKey = '';
  /** running-cost panel (growth P4): forecast, arrears stage, per-ship reserve */
  private renderUpkeep(force: boolean) {
    if (!this.upkOpen || !growthOn(this.st)) { this.upkEl?.remove(); this.upkEl = null; return; }
    const co = this.st.companies[this.me]; if (!co) return;
    const key = JSON.stringify([co.upkeep?.stage, Math.round(co.upkeep?.debt ?? 0), co.upkeep?.bill?.t, co.upkeep?.autoReserve, Object.values(this.st.ships).filter(s => s.owner === this.me).map(s => [s.id, s.state, s.reserve, s.listed, Math.round((s.wear ?? 0) * 100)])]);
    if (!force && key === this.upkKey && this.upkEl) return;
    this.upkKey = key;
    if (!this.upkEl) { this.upkEl = h('div', 'upkwrap'); this.root.appendChild(this.upkEl); }
    morph(this.upkEl, upkeepHtml(this.st, this.me));
    const e = this.upkEl;
    e.querySelector<HTMLButtonElement>('[data-upclose]')!.onclick = () => { this.upkOpen = false; this.renderUpkeep(true); };
    const ar = e.querySelector<HTMLInputElement>('[data-autores]');
    if (ar) ar.onchange = () => { if (ar.checked && !confirm('체납 4단계가 되면 정박 중인 유휴 함선을 자동으로 예비역으로 돌립니다. 함선·장비는 그대로이며 재취역할 수 있습니다. 동의할까요?')) { ar.checked = false; return; } this.cmd({ c: 'autoReserve', on: ar.checked }); };
    e.querySelectorAll<HTMLButtonElement>('[data-reserve]').forEach(b => b.onclick = async () => { const [ship, on] = b.dataset.reserve!.split(':'); if (await this.cmd({ c: 'reserve', ship, on: on === '1' })) this.renderUpkeep(true); });
  }

  private orgKey = '';
  private renderOrg() {
    const groups = this.myGroups();
    const key = JSON.stringify(groups.map(g => [g.id, g.name, g.parentId, g.shipIds, g.status, g.commanderId, g.op.k, g.override, g.fleeing, this.groupSys(g)])) + [...this.expanded].join() + this.group + this.v.sys?.id + JSON.stringify(Object.values(this.st.ships).filter(s => s.owner === this.me).map(s => [Math.round(s.hp * 50), s.state, Math.round(cargoSum(s.cargo) / 10)]));
    if (key === this.orgKey) return;
    this.orgKey = key;
    const body = document.getElementById('orgBody')!;
    const scroll = body.scrollTop;
    body.innerHTML = '';
    const add = (g: WGroup, depth: number) => {
      const ships = this.shipsOf(g);
      const cm = g.commanderId ? this.st.commanders[g.commanderId] : null;
      const open = this.expanded.has(g.id);
      const row = h('div', `node${this.group === g.id ? ' sel' : ''}`);
      row.style.paddingLeft = `${6 + depth * 14}px`;
      const hp = ships.length ? ships.reduce((a, s) => a + s.hp, 0) / ships.length : 0;
      const op = g.op;
      const inherited = !g.override && g.parentId;
      const gs = this.groupSys(g);
      const sysTag = gs && gs !== this.v.sys?.id ? `<span class="systag">${esc(this.st.systems[gs]?.name ?? '')}</span>` : '';
      row.innerHTML = `<span class="tog">${ships.length || g.childIds.length ? (open ? '▾' : '▸') : ''}</span>
        <span class="nm">${sysTag}${esc(g.name)}<span class="cmd">${cm ? esc(cm.name) + (cm.injuredUntil > this.st.time ? ' (부상)' : '') : ''}</span><br><span class="stt${g.fleeing ? ' warn' : ''}">${esc(g.status)}</span></span>
        <span class="meta">${ships.length}척<span class="hp"><i style="width:${hp * 100}%;background:${hpCol(hp)}"></i></span><span class="ord${inherited ? '' : ' ov'}">${inherited ? '위임' : OP_NAME[op.k]}</span></span>`;
      row.querySelector('.tog')!.addEventListener('click', ev => { ev.stopPropagation(); if (open) this.expanded.delete(g.id); else this.expanded.add(g.id); this.orgKey = ''; this.renderOrg(); });
      row.onclick = () => this.select({ kind: 'group', id: g.id });
      row.ondblclick = () => { this.select({ kind: 'group', id: g.id }); this.focusSelected(); };
      body.appendChild(row);
      if (!open) return;
      for (const cid of g.childIds) { const cg = this.st.groups[cid]; if (cg) add(cg, depth + 1); }
      for (const s of ships) {
        const r = h('div', `shiprow${this.sel?.kind === 'ship' && this.sel.id === s.id ? ' selS' : ''}`);
        r.style.paddingLeft = `${26 + depth * 14}px`;
        const cs = cargoSum(s.cargo);
        const cap = econOf(s).cargo;
        r.innerHTML = `<span>${esc(s.name)} <span style="opacity:.6">${SHIP_CLASSES[s.classId].type}</span>${s.state === 'docked' ? ' ⚓' : s.state === 'battle' ? ' ⚔' : ''}${cap ? ` <span style="color:var(--warn)">${Math.round(cs)}/${cap}</span>` : ''}</span><span class="hp"><i style="width:${s.hp * 100}%;background:${hpCol(s.hp)}"></i></span>`;
        r.onclick = () => { this.group = g.id; this.select({ kind: 'ship', id: s.id }); };
        r.ondblclick = () => { const v = this.v.ships.get(s.id); if (v) this.v.focusOn(v.pos, 500); };
        body.appendChild(r);
      }
    };
    for (const g of groups.filter(g => !g.parentId)) add(g, 0);
    const free = Object.values(this.st.commanders).filter(c => c.owner === this.me && !groups.some(g => g.commanderId === c.id));
    if (free.length) body.appendChild(h('div', 'treesep', `대기 중인 지휘관: ${free.map(c => esc(c.name)).join(', ')}`));
    body.scrollTop = scroll;
  }

  // ============================================================== selection panel

  private renderSel(force: boolean) {
    const el = document.getElementById('sel')!;
    const s = this.sel;
    const g = this.group ? this.st.groups[this.group] : null;
    // drop a mining edit once the server reflects it (or after a few seconds)
    if (this.mineForm?.live && g && (g.id !== this.mineForm.group || performance.now() - this.mineForm.t > 4000 || (g.op.k === 'mine' && this.sameMine(g.op, this.mineForm)))) this.mineForm = null;
    if (this.mineForm && !this.mineForm.live && this.mineForm.group !== this.group) this.mineForm = null;
    const selKey = JSON.stringify([s, this.group, this.mode, g?.op, this.mineForm, g?.status, g?.commanderId, g?.parentId, g?.override, s?.kind === 'ship' ? this.st.ships[s.id] && [Math.round(this.st.ships[s.id].hp * 100), this.st.ships[s.id].state, Math.round(cargoSum(this.st.ships[s.id].cargo))] : 0, s?.kind === 'field' ? Math.round((this.st.fields[s.id]?.amount ?? 0) / 20) : 0, Math.round(this.st.companies[this.me]?.credits / 100)]);
    if (!force && selKey === this.lastSelKey) return;
    this.lastSelKey = selKey;
    if (!s && !g) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    let html = '';
    if (s && s.kind !== 'group' && !(s.kind === 'ship' && this.st.ships[s.id]?.owner === this.me)) html += this.infoHtml(s);
    if (g && g.owner === this.me) html += this.groupHtml(g);
    trackSelects(el);
    morph(el, html);
    this.bindMineForm(el);
    el.querySelectorAll<HTMLButtonElement>('[data-op]').forEach(b => b.onclick = () => this.opButton(b.dataset.op!));
    el.querySelectorAll<HTMLInputElement>('[data-detach]').forEach(b => b.onchange = () => this.cmd({ c: 'setDetached', group: b.dataset.detach!, on: b.checked }));
    el.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(b => b.onclick = () => this.openStation(b.dataset.open!));
    el.querySelectorAll<HTMLButtonElement>('[data-battle]').forEach(b => b.onclick = () => this.opts.onOpenBattle(b.dataset.battle!));
    el.querySelectorAll<HTMLButtonElement>('[data-viewsys]').forEach(b => b.onclick = () => this.v.setSystem(b.dataset.viewsys!));
    el.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach(b => b.onclick = () => this.setOp(JSON.parse(b.dataset.quick!)));
    el.querySelectorAll<HTMLButtonElement>('[data-salvage]').forEach(b => b.onclick = () => this.setOp({ k: 'salvage', site: b.dataset.salvage! }));
    el.querySelectorAll<HTMLButtonElement>('[data-minehere]').forEach(b => b.onclick = () => { if (!this.group) return; this.mineForm = { group: this.group, field: b.dataset.minehere!, deliver: 'auto', sell: this.mineForm?.sell ?? true, live: false, t: performance.now() }; this.refresh(true); });
    const nm = el.querySelector<HTMLInputElement>('[data-rename]'); if (nm) nm.onchange = () => this.cmd({ c: 'renameGroup', group: nm.dataset.rename!, name: nm.value });
    const cs = el.querySelector<HTMLSelectElement>('[data-cmdsel]'); if (cs) cs.onchange = () => this.cmd({ c: 'assignCmd', group: cs.dataset.cmdsel!, commander: cs.value || null });
    const ps = el.querySelector<HTMLSelectElement>('[data-parent]'); if (ps) ps.onchange = () => this.cmd({ c: 'setParent', group: ps.dataset.parent!, parent: ps.value || null });
    el.querySelectorAll<HTMLSelectElement>('[data-mvship]').forEach(sel => sel.onchange = () => { if (sel.value === '__new') this.cmd({ c: 'newGroup', name: '새 편대', parent: null, ships: [sel.dataset.mvship!] }); else if (sel.value) this.cmd({ c: 'moveShip', ship: sel.dataset.mvship!, group: sel.value }); });
    const del = el.querySelector<HTMLButtonElement>('[data-delgroup]'); if (del) del.onclick = () => { if (confirm('편대를 해체할까요? 함선은 상위/다른 편대로 이동합니다.')) this.cmd({ c: 'deleteGroup', group: del.dataset.delgroup! }).then(ok => { if (ok) { this.group = null; this.select(null); } }); };
  }

  private infoHtml(s: NonNullable<Sel>): string {
    const st = this.st;
    if (s.kind === 'station') {
      const x = st.stations[s.id]; if (!x) return '';
      const own = x.owner === this.me;
      const store = x.storage[this.me];
      return `<div class="info"><div class="ih"><b>${esc(x.name)}</b> <span class="tag" style="background:${st.companies[x.owner]?.color}">${esc(st.companies[x.owner]?.name ?? '')}</span></div>
        <div class="dim">${esc(x.desc)}</div>
        <div class="svc">${this.secLine(x.pos)}${x.tax ? ` · 판매세 ${Math.round(x.tax * 100)}%` : x.public ? ' · 면세' : ''}</div>
        ${x.public ? `<div class="svc">${x.market ? '시장 ' : ''}${x.services.repair ? '· 수리 ' : ''}${x.services.shipyard.length ? '· 조선소 ' : ''}${x.services.recruit ? '· 인재 ' : ''}${x.services.contracts ? '· 계약' : ''}</div>` : `<div class="svc">모듈 ${x.modules.filter(m => m.built).length}/${x.modules.length} 완공</div>`}
        ${store && cargoSum(store) > 0.5 ? `<div class="svc">자사 창고: ${cargoKeys(store).filter(r => store[r] >= 0.5).slice(0, 8).map(r => `${RES_NAME[r]} ${fmt(store[r])}`).join(' · ')}${cargoKeys(store).length > 8 ? ' …' : ''}</div>` : ''}
        <button class="btn go" data-open="${x.id}">${own ? '정거장 관리' : '정거장 서비스'}</button></div>`;
    }
    if (s.kind === 'field') {
      const f = st.fields[s.id]; if (!f) return '';
      return `<div class="info"><div class="ih"><b>${esc(f.name)}</b> <span style="color:${RES_COLOR[f.res]}">${RES_NAME[f.res]}</span>${f.salvage ? ' <span class="tag">전투 잔해</span>' : ''}</div>
        <div class="bar2"><i style="width:${f.amount / f.max * 100}%;background:${RES_COLOR[f.res]}"></i></div>
        <div class="dim">매장량 ${fmt(f.amount)} / ${fmt(f.max)}${f.regen ? ` · 재생 ${f.regen}/s` : ` · ${Math.max(0, Math.round((f.expires - st.time) / 60))}분 후 소멸`}${(f.rich ?? 1) !== 1 ? ` · 채굴 효율 ×${(f.rich ?? 1).toFixed(2)}` : ''}</div>
        <div class="svc">${this.secLine(f.pos)}</div>
        ${this.group ? `<button class="btn" data-minehere="${f.id}">이 지대 채굴 설정…</button><button class="btn" data-quick='${JSON.stringify({ k: 'patrol', at: f.pos, radius: f.radius + 400 })}'>이 지역 순찰</button>` : '<div class="dim">편대를 선택하고 우클릭하면 채굴을 지시합니다.</div>'}</div>`;
    }
    if (s.kind === 'lair') {
      const l = st.lairs[s.id]; if (!l) return '';
      return `<div class="info"><div class="ih"><b style="color:#ff8070">☠ ${esc(l.name)}</b></div>
        <div class="dim">${l.alive ? `요새 내구 ${Math.round(l.hp * 100)}% · 해적 무리를 주기적으로 출격시킨다. 토벌하면 주변 항로가 안전해진다.` : `파괴됨 — ${Math.round((l.respawnAt - st.time) / 60)}분 후 재건 예상`}</div>
        ${l.alive && this.group ? `<button class="btn danger" data-quick='${JSON.stringify({ k: 'attack', lair: l.id })}'>선택 편대로 토벌</button>` : ''}</div>`;
    }
    if (s.kind === 'ship') {
      const x = st.ships[s.id]; if (!x) return '';
      const g = st.groups[x.groupId]; const co = st.companies[x.owner];
      const val = g ? this.shipsOf(g).reduce((a, q) => a + SHIP_CLASSES[q.classId].cost, 0) : 0;
      const e = x.engagement ? st.engagements[x.engagement] : null;
      return `<div class="info"><div class="ih"><b style="color:${co?.color}">${esc(x.name)}</b> <span class="dim">${co?.kind === 'pirate' ? SHIP_CLASSES[x.classId].enemyName : SHIP_CLASSES[x.classId].name} ${SHIP_CLASSES[x.classId].type} · ${esc(co?.name ?? '')}</span></div>
        <div class="dim">${g ? `${esc(g.name)} (${g.shipIds.length}척, 전력 ${val}) · ${esc(g.status)}` : ''}</div>
        <div class="bar2"><i style="width:${x.hp * 100}%;background:${hpCol(x.hp)}"></i></div>
        ${co?.kind === 'pirate' && this.group ? `<button class="btn danger" data-quick='${JSON.stringify({ k: 'attack', group: x.groupId })}'>선택 편대로 공격</button>` : ''}
        ${e && !e.done ? `<button class="btn go" data-battle="${e.id}">전투 관전</button>` : ''}</div>`;
    }
    if (s.kind === 'gate') {
      const sys = Object.values(st.systems).find(x => x.gates.some(g => g.id === s.id)); const gt = sys?.gates.find(g => g.id === s.id);
      if (!gt) return '';
      const dest = st.systems[gt.to];
      return `<div class="info"><div class="ih"><b style="color:#7fd0ff">⟁ ${esc(gt.name)}</b></div>
        <div class="dim">${esc(dest.name)} 성계로 통하는 점프게이트. 편대를 선택하고 우클릭하면 게이트를 통과해 건너편으로 이동합니다.</div>
        <div class="svc">건너편: <span style="color:${secBand(effSec(dest)).color}">${secBand(effSec(dest)).name} · 치안 ${Math.round(effSec(dest))}</span></div>
        ${this.group ? `<button class="btn go" data-quick='${JSON.stringify({ k: 'move', to: this.arrivalPoint(gt.id) })}'>선택 편대 점프</button>` : ''}
        <button class="btn" data-viewsys="${dest.id}">${esc(dest.name)} 보기</button></div>`;
    }
    if (s.kind === 'planet') {
      const pl = this.v.sys?.planets.find(x => x.id === s.id); if (!pl) return '';
      return `<div class="info"><div class="ih"><b>${esc(pl.name)}</b></div><div class="dim">${esc(pl.desc)}${pl.moons.length ? ` 위성 ${pl.moons.length}개: ${pl.moons.map(m => esc(m.name)).join(', ')}.` : ''}</div><div class="svc">${this.secLine(pl.pos)}</div></div>`;
    }
    if (s.kind === 'battle') {
      const e = st.engagements[s.id]; if (!e) return '';
      const [na, nb] = this.battleSides(e);
      const p = e.prog;
      const mine = e.sides[0].includes(this.me) || e.sides[1].includes(this.me);
      return `<div class="info"><div class="ih"><b style="color:#ff9a7a">⚔ 교전 중</b></div><div><b>${esc(na)}</b> <span class="dim">vs</span> <b style="color:#ff9a7a">${esc(nb)}</b></div>
        ${p ? `<div class="dim">잔존 ${p.alive[0]}/${p.total[0]} 대 ${p.alive[1]}/${p.total[1]}척</div><div class="bbar"><i style="width:${Math.round(p.value[0] * 100)}%"></i><em style="width:${Math.round(p.value[1] * 100)}%"></em></div>` : ''}
        ${e.done ? '<div class="dim">교전 종료</div>' : e.autoEnd !== undefined ? '<div class="dim">원거리 판정 전투 (관전 불가)</div>' : `<button class="btn go" data-battle="${e.id}">${mine ? '전투 지휘' : '전투 관전'}</button>`}</div>`;
    }
    return '';
  }

  private groupHtml(g: WGroup): string {
    const st = this.st;
    const ships = this.shipsOf(g);
    const sub = this.subtree(g);
    const mine = Object.values(st.commanders).filter(c => c.owner === this.me);
    const cm = g.commanderId ? st.commanders[g.commanderId] : null;
    const groups = this.myGroups();
    const descend = (x: WGroup): string[] => [x.id, ...x.childIds.flatMap(id => st.groups[id] ? descend(st.groups[id]) : [])];
    const banned = new Set(descend(g));
    const hasMiner = sub.some(s => econOf(s).mine > 0), hasCargo = sub.some(s => econOf(s).cargo > 0), hasCon = sub.some(s => s.classId === 'constructor'), hasMil = sub.some(s => econOf(s).military);
    const opb = (k: string, label: string, key: string, show = true, cls = '') => show ? `<button class="btn${this.mode === k || (g.op.k === k && g.override) ? ' on' : ''} ${cls}" data-op="${k}">${label}<span class="key">${key}</span></button>` : '';
    const selShip = this.sel?.kind === 'ship' ? st.ships[this.sel.id] : null;
    return `<div class="gpanel">
      <div class="cmdcol">
        ${cm ? `<div class="portrait" style="background:${cm.color}">${esc(cm.name.replace(/\s/g, '').slice(0, 2))}</div><div class="cmdname">${esc(cm.name)} <small>Lv.${cm.level}</small></div><div class="cmdrank">${esc(cm.rank)}${cm.injuredUntil > st.time ? ' · 부상' : ''}</div>
          <div class="traits"><span>판단력</span><div class="bar"><i style="width:${cm.skill * 100}%"></i></div><span>공격성</span><div class="bar"><i style="width:${cm.aggression * 100}%;background:var(--warn)"></i></div><span>경험</span><div class="bar"><i style="width:${cm.xp / (cm.level * 100) * 100}%;background:var(--good)"></i></div></div>
          <div class="cmdspec">${SPECIALTY_TEXT[cm.specialty]}</div>`
          : `<div class="portrait" style="background:#3a4a58">—</div><div class="cmdname">선임 함장</div><div class="cmdrank">지휘관 미배치 (판단력 낮음)</div>`}
        <select data-cmdsel="${g.id}"><option value="">${cm ? '지휘관 해임' : '지휘관 배치…'}</option>${mine.map(c => `<option value="${c.id}"${c.id === g.commanderId ? ' selected' : ''}>${esc(c.rank)} ${esc(c.name)} (판단 ${Math.round(c.skill * 100)})${groups.find(x => x.commanderId === c.id && x.id !== g.id) ? ' — 재배치' : ''}</option>`).join('')}</select>
      </div>
      <div class="ordcol">
        <div class="gh"><input class="gname" data-rename="${g.id}" value="${esc(g.name)}" /><span class="dim">${ships.length}척${sub.length > ships.length ? ` (+하위 ${sub.length - ships.length})` : ''}</span>
          <select data-parent="${g.id}" title="상위 편대"><option value="">최상위 편대</option>${groups.filter(x => !banned.has(x.id)).map(x => `<option value="${x.id}"${x.id === g.parentId ? ' selected' : ''}>↳ ${esc(x.name)} 소속</option>`).join('')}</select>
          <button class="btn mini danger" data-delgroup="${g.id}" title="편대 해체">해체</button></div>
        <div class="status${g.fleeing ? ' warn' : ''}">${!g.override && g.parentId ? `<span class="tag">위임</span> 상위 편대 작전 수행 — ` : `<span class="tag ov">${OP_NAME[g.op.k]}</span> `}${esc(g.status)}</div>
        <div class="row">
          ${opb('move', '이동', 'M')}${opb('dock', '정박', 'D')}${opb('mine', '채굴', 'N', hasMiner)}${opb('haul', '운송', '', hasCargo)}
          ${opb('patrol', '순찰', 'P', hasMil)}${opb('escort', '호위', 'G')}${opb('attack', '공격', 'A', hasMil, 'danger')}
          ${opb('build', '건설', '', hasCon)}${opb('found', '정거장 설립', '', ships.some(s => s.classId === 'constructor'))}
          ${opb('idle', '대기', 'I')}${g.parentId ? `<button class="btn${!g.override ? ' on' : ''}" data-op="release" title="상위 편대 지휘관에게 위임">위임<span class="key">T</span></button>` : ''}
        </div>
        ${g.parentId ? `<div class="row small"><label class="chk" title="체크하면 이 편대는 본대 진형에서 빠져 자기 속도로 앞서 움직입니다 (정찰·선봉). 해제하면 본대와 함께 가장 느린 함선 속도로 이동합니다."><input type="checkbox" data-detach="${g.id}" ${g.detached ? 'checked' : ''}> 독립 기동 (정찰·선봉 — 본대보다 먼저 움직임)</label></div>` : ''}
        ${hasMiner ? this.mineFormHtml(g) : ''}
        ${this.exploreHtml(g, hasCargo)}
        <div class="dim small">우클릭: 소행성 지대=채굴 · 정거장=정박 · 해적=공격 · 자사 함선=호위 · 빈 곳=이동. 지휘관의 판단력이 높을수록 해적을 일찍 감지하고 효율적으로 일한다.</div>
        ${selShip && selShip.owner === this.me ? this.shipDetail(selShip) : ''}
      </div></div>`;
  }

  /** growth: survey the group's current system / salvage a site it knows */
  private exploreHtml(g: WGroup, hasCargo: boolean): string {
    if (!growthOn(this.st) || !(this.st as any).sites) return '';
    const sys = this.groupSys(g); if (!sys) return '';
    const sy = this.st.systems[sys];
    const can = sy && sy.kind !== 'core' && sy.security < 90;
    return `<div class="bdr small">${can ? `<button class="btn mini${g.op.k === 'survey' ? ' on' : ''}" data-quick='${JSON.stringify({ k: 'survey', system: sys })}'>이 성계 탐사</button> ` : ''}${sitesHtml(this.st, this.me, sys, hasCargo)}</div>`;
  }

  // ------------------------------------------------------------ mining job form
  // field → unloading station (auto / own / public, any reachable system) → store or sell → start.
  // While a mining op runs the same form shows its settings, and changes apply immediately.

  private mineForm: { group: string; field: string; deliver: string; sell: boolean; live: boolean; t: number } | null = null;

  private sameMine(op: Extract<Op, { k: 'mine' }>, f: { field: string; deliver: string; sell: boolean }) {
    return op.field === f.field && op.sell === f.sell && (f.deliver === 'auto' ? !!op.auto : !op.auto && op.deliver === f.deliver);
  }

  /** client mirror of the server's deliverProblem (the server re-validates every order) */
  private deliverWhy(stId: string, sell: boolean): string | null {
    const x = this.st.stations[stId];
    if (!x) return '정거장이 사라짐';
    if (!(x.public || (x.owner === this.me && x.modules.some(m => m.kind === 'core' && m.built)))) return x.owner === this.me ? '핵심 모듈 미완성' : '하역 권한 없음';
    if (sell && !x.market) return '시장 없음 — 판매 불가';
    return null;
  }

  private mineFormHtml(g: WGroup): string {
    const st = this.st;
    const op = g.op.k === 'mine' && (g.override || !g.parentId) ? g.op : null;
    const form = this.mineForm?.group === g.id ? this.mineForm : op ? { field: op.field, deliver: op.auto ? 'auto' : op.deliver, sell: op.sell, live: true } : null;
    if (!form) return '';
    const f = st.fields[form.field];
    const fsys = f ? sysAt(st.systems, f.pos)?.id : undefined;
    const sysName = (p: V) => st.systems[sysAt(st.systems, p)?.id ?? '']?.name ?? '';
    const hop = (p: V) => { const ss = sysAt(st.systems, p)?.id; const j = fsys && ss ? jumps(st.systems, fsys, ss) : 0; return j ? ` · 점프 ${j}회` : ''; };
    const stOpt = (x: Station) => { const why = this.deliverWhy(x.id, form.sell); return `<option value="${x.id}"${form.deliver === x.id ? ' selected' : ''}${why ? ' disabled' : ''}>${esc(x.name)} (${sysName(x.pos)}${hop(x.pos)})${why ? ` — ${why}` : x.tax ? ` · 세금 ${Math.round(x.tax * 100)}%` : ''}</option>`; };
    const all = Object.values(st.stations);
    const own = all.filter(x => x.owner === this.me), pub = all.filter(x => x.public);
    const fieldsBySys = Object.values(st.systems).map(sy => [sy, Object.values(st.fields).filter(x => sysAt(st.systems, x.pos)?.id === sy.id)] as const).filter(([, fs]) => fs.length);
    // what will actually happen
    const autoId = form.deliver === 'auto' ? (op?.auto && op.field === form.field && op.sell === form.sell ? op.deliver : null) : form.deliver;
    const dest = autoId ? st.stations[autoId] : null;
    const why = form.deliver === 'auto' ? null : this.deliverWhy(form.deliver, form.sell);
    const problem = op && form.live ? this.deliverWhy(op.deliver, op.sell) : why;
    return `<div class="minecfg" data-mineform="${g.id}">
      <div class="mh"><b>${form.live ? '채굴 작업' : '채굴 작업 설정'}</b>${form.live ? `<span class="dim"> · 변경 즉시 적용</span>` : ''}</div>
      <label>채굴 구역<select data-mf="field">${fieldsBySys.map(([sy, fs]) => `<optgroup label="${esc(sy.name)}">${fs.map(x => `<option value="${x.id}"${x.id === form.field ? ' selected' : ''}>${esc(x.name)} · ${RES_NAME[x.res]} ${fmt(x.amount)}${(x.rich ?? 1) !== 1 ? ` · 효율 ×${(x.rich ?? 1).toFixed(2)}` : ''}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label>하역 목적지<select data-mf="deliver"><option value="auto"${form.deliver === 'auto' ? ' selected' : ''}>자동 선택 (가까운 이용 가능 정거장)</option>
        ${own.length ? `<optgroup label="내 정거장">${own.map(stOpt).join('')}</optgroup>` : ''}<optgroup label="공용 정거장">${pub.map(stOpt).join('')}</optgroup></select></label>
      <label>하역 방식<select data-mf="sell"><option value="0"${!form.sell ? ' selected' : ''}>창고 보관 (정거장 내 자사 창고)</option><option value="1"${form.sell ? ' selected' : ''}>자동 판매 (정거장 시장)</option></select></label>
      <div class="mstat">${f ? `채굴 구역: <b>${esc(f.name)}</b> <span class="dim">(${sysName(f.pos)})</span>` : '<span class="warn">채굴 구역 없음</span>'}
        · 하역 목적지: <b>${form.deliver === 'auto' ? `자동${dest ? ` → ${esc(dest.name)}` : ''}` : esc(st.stations[form.deliver]?.name ?? '(소멸)')}</b>
        · 하역 방식: <b>${form.sell ? '자동 판매' : '창고 보관'}</b>${form.live ? ` · 현재 작업: <b>${esc(g.status)}</b>` : ''}</div>
      ${problem ? `<div class="warn small">⚠ 하역지 문제: ${problem}. 화물은 판매되지 않고 보관됩니다 — 목적지를 다시 지정하세요.</div>` : ''}
      ${form.live ? '' : `<div class="row"><button class="btn go" data-mf-start ${why || !f ? 'disabled' : ''}>작업 시작</button><button class="btn" data-mf-cancel>취소</button></div>`}
    </div>`;
  }

  private bindMineForm(el: Element) {
    const box = el.querySelector<HTMLElement>('[data-mineform]'); if (!box) return;
    const gid = box.dataset.mineform!;
    const g = this.st.groups[gid]; if (!g) return;
    const cur = () => {
      if (this.mineForm?.group === gid) return { ...this.mineForm };
      const op = g.op as Extract<Op, { k: 'mine' }>;
      return { group: gid, field: op.field, deliver: op.auto ? 'auto' : op.deliver, sell: op.sell, live: true, t: 0 };
    };
    const toOp = (f: { field: string; deliver: string; sell: boolean }): Op => f.deliver === 'auto' ? { k: 'mine', field: f.field, deliver: '', sell: f.sell, auto: true } : { k: 'mine', field: f.field, deliver: f.deliver, sell: f.sell };
    box.querySelectorAll<HTMLSelectElement>('[data-mf]').forEach(sel => sel.onchange = () => {
      const f = cur();
      const k = sel.dataset.mf!;
      if (k === 'field') f.field = sel.value; else if (k === 'deliver') f.deliver = sel.value; else f.sell = sel.value === '1';
      // switching to "sell" with a station that has no market: fall back to automatic choice, visibly
      if (k === 'sell' && f.deliver !== 'auto' && this.deliverWhy(f.deliver, f.sell)) { f.deliver = 'auto'; this.toast('이 정거장에서는 판매할 수 없어 하역 목적지를 자동 선택으로 바꿨습니다.', 'warn'); }
      f.t = performance.now();
      this.mineForm = f;
      if (f.live) this.cmd({ c: 'setOp', group: gid, op: toOp(f) }).then(ok => { if (!ok) this.mineForm = null; this.refresh(true); });
      else this.refresh(true);
    });
    const start = box.querySelector<HTMLButtonElement>('[data-mf-start]');
    const doneHint = () => document.getElementById('modeHint')?.classList.add('hidden');
    if (start) start.onclick = () => { const f = cur(); this.cmd({ c: 'setOp', group: gid, op: toOp(f) }).then(ok => { if (ok) { this.mineForm = null; doneHint(); } this.refresh(true); }); };
    const cancel = box.querySelector<HTMLButtonElement>('[data-mf-cancel]');
    if (cancel) cancel.onclick = () => { this.mineForm = null; doneHint(); this.refresh(true); };
  }

  private shipDetail(s: WShip): string {
    const groups = this.myGroups();
    const cap = econOf(s).cargo;
    const docked = s.task.k === 'docked' ? this.st.stations[(s.task as any).station] : null;
    return `<div class="shipd"><b>${esc(s.name)}</b> <span class="dim">${SHIP_CLASSES[s.classId].name} ${SHIP_CLASSES[s.classId].type} · ${esc(getLoadout(s.classId, s.loadoutId).name)}</span>
      · 선체 <b style="color:${hpCol(s.hp)}">${Math.round(s.hp * 100)}%</b>${cap ? ` · 화물 ${cargoKeys(s.cargo).filter(r => s.cargo[r] > 0.5).map(r => `${RES_NAME[r]} ${Math.round(s.cargo[r])}`).join(', ') || '비어 있음'} / ${cap}` : ''}
      ${docked ? ` · ⚓ ${esc(docked.name)} <button class="btn mini" data-open="${docked.id}">수리·개조</button>` : ''}
      <select data-mvship="${s.id}"><option value="">편대 이동…</option><option value="__new">→ 새 편대로 분리</option>${groups.filter(g => g.id !== s.groupId).map(g => `<option value="${g.id}">→ ${esc(g.name)}</option>`).join('')}</select></div>`;
  }

  // ============================================================== goals & contracts

  private goalsKey = '';
  private renderGoals() {
    const co = this.st.companies[this.me]; if (!co) return;
    const ks = Object.values(this.st.contracts).filter(k => k.takenBy === this.me && !k.done);
    const key = co.milestones.join() + JSON.stringify(ks.map(k => [k.id, Math.round(k.progress)])) + this.advice();
    if (key === this.goalsKey) return;
    this.goalsKey = key;
    const next = MILESTONES.filter(m => !co.milestones.includes(m.id)).slice(0, 3);
    const el = document.getElementById('goals')!;
    const tip = this.advice();
    el.innerHTML = `${tip ? `<div class="advice">💡 ${tip}</div>` : ''}<div class="ptitle"><span>PMC 목표</span><span>${co.milestones.length}/${MILESTONES.length}</span></div>
      ${next.map(m => `<div class="goal"><span>☐</span><div><b>${m.title}</b><div class="dim">${m.desc}</div></div></div>`).join('')}
      ${ks.length ? `<div class="ptitle" style="border-top:1px solid var(--line)"><span>진행 중 계약</span></div>${ks.map(k => `<div class="goal"><span>◆</span><div><b>${esc(k.title)}</b><div class="dim">${k.kind === 'delivery' ? `${Math.round(k.progress)}/${k.amount} · ` : ''}${esc(this.st.stations[k.stationId]?.name ?? '')} · ${fmt(k.reward)} cr · ${Math.max(0, Math.round((k.expires - this.st.time) / 60))}분 남음</div></div></div>`).join('')}` : ''}`;
  }

  /** context-sensitive next step for new players */
  private advice(): string {
    const st = this.st, me = this.me, co = st.companies[me];
    const groups = this.myGroups();
    const ships = Object.values(st.ships).filter(x => x.owner === me);
    const miningOps = groups.filter(g => g.op.k === 'mine');
    if (!miningOps.length && ships.some(x => x.classId === 'miner')) return '<b>제1 채굴반</b>을 선택하고 지도에서 <b>케스트렐 암초대</b>를 우클릭하면 채굴을 시작합니다.';
    if (!Object.values(st.contracts).some(k => k.takenBy === me) && co.stats.contracts === 0) return '아스트라 자유항을 클릭 → <b>계약</b> 탭에서 광석 납품 계약을 수주하면 보수가 두 배 가까이 됩니다.';
    if (!ships.some(x => x.classId === 'hauler') && co.credits > 5500) return '<b>수송선</b>을 사서 채굴반에 넣으면 채굴선이 쉬지 않고 캐냅니다 (자유항 → 조선소).';
    if (groups.some(g => g.fleeing)) return '해적이 채굴반을 위협합니다. <b>경비대</b>에 채굴반 <b>호위</b>나 소행성 지대 <b>순찰</b>을 맡기세요.';
    if (Object.values(st.commanders).filter(c => c.owner === me).length < 2 && co.credits > 4000) return '지휘관 없는 편대는 판단이 느립니다. 자유항 <b>인재</b> 탭에서 지휘관을 영입해 채굴반에 배치하세요.';
    if (!ships.some(x => x.classId === 'constructor') && !Object.values(st.stations).some(x => x.owner === me) && co.credits > 20000) return '자금이 쌓였습니다. <b>공작선</b>을 구매하고 <b>정거장 설립</b>으로 자체 기지를 세울 수 있습니다.';
    const own = Object.values(st.stations).find(x => x.owner === me);
    if (own && own.modules.some(m => m.kind === 'core' && !m.built) && !groups.some(g => g.op.k === 'build')) return `공작선 편대에 <b>건설</b> 명령을 내려 ${esc(own.name)}의 도킹 허브를 완성하세요. 합금이 부족하면 시장에서 사서 <b>운송</b>하세요.`;
    if (own && own.modules.some(m => !m.built && matsOf(m.kind).some(r => missing(m, r) > 1))) return `${esc(own.name)}의 건설 계획이 <b>자재 대기 중</b>입니다. 채굴선 하역지를 이 정거장으로 지정하거나 합금을 <b>운송</b>하면 자동으로 착공합니다.`;
    if (own && own.modules.length === 1 && own.modules[0].built) return `${esc(own.name)}에 <b>정제소</b>를 지으면 광석을 합금으로 바꿔 건설·조선에 쓸 수 있습니다.`;
    if (co.rep >= 10 && !ships.some(x => x.classId === 'cruiser')) return '평판이 올랐습니다. 수도 성계 <b>헬리오스</b> 조선소에서 <b>순양함</b>을 살 수 있습니다 (Tab: 성계 지도).';
    if (co.stats.earned > 30000 && !ships.some(s => sysAt(st.systems, s.pos)?.id !== 'astra')) return '아스트라는 안전하지만 수익이 제한적입니다. <b>Tab</b>으로 성계 지도를 열어 <b>드레이크 변경</b>을 살펴보세요 — 광맥이 풍부하고 보수가 높지만 호위가 필요합니다.';
    return '';
  }

  // ============================================================== station modal

  openStation(id: string, tab?: string) {
    this.modalStation = id;
    const s = this.st.stations[id];
    this.modalTab = tab ?? (s.owner === this.me ? 'build' : s.market ? 'market' : 'yard');
    if (!this.modal) { this.modal = h('div', 'modal smodal'); this.root.appendChild(this.modal); this.modal.onclick = e => { if (e.target === this.modal) this.closeModal(); }; }
    this.renderModal(true);
  }
  closeModal() { this.modal?.remove(); this.modal = null; this.modalStation = null; }

  private modalKey = '';
  private fitScreen: FittingScreen | null = null;
  openFitting(shipId: string) {
    this.fitScreen?.close();
    this.fitScreen = new FittingScreen(this.root, () => this.c.state, this.me, shipId, c => this.cmd(c), () => { this.fitScreen = null; });
  }
  private renderModal(force: boolean) {
    const s = this.st.stations[this.modalStation!];
    if (!s || !this.modal) return;
    const co = this.st.companies[this.me];
    const key = JSON.stringify([this.modalTab, this.ind, Math.round(co.credits), co.rep, co.tech, (co.research ?? []).map(r => [r.id, r.why, r.paused, Math.round(r.left / 10)]), this.myGroups().map(g => g.id + g.name + g.status), s.storage[this.me], s.market, s.modules, s.orders, s.listings, (s.jobs ?? []).map(j => Math.round(j.left)), (s.builds ?? []).map(b => [b.id, b.why, b.paused, Math.round(b.left / 10)]), Object.values(this.st.ships).filter(x => x.owner === this.me && x.task.k === 'docked' && (x.task as any).station === s.id).map(x => [x.id, x.hp, x.loadoutId, x.fit, x.variant, x.fitting]), Object.values(this.st.contracts).filter(k => k.stationId === s.id).map(k => [k.id, k.takenBy, k.done]), Object.values(this.st.commanders).filter(c => c.stationId === s.id && !c.owner).length, this.gy, s.shipStock, s.shipListings, co.blueprints, Math.round((s.funds ?? 0) / 500)]);
    if (!force && key === this.modalKey) return;
    this.modalKey = key;
    const own = s.owner === this.me;
    const tabs: [string, string, boolean][] = [
      ['market', '시장', !!s.market || s.modules.some(m => m.kind === 'trade_hub' && m.built)], ['store', '창고·물류', own || cargoSum(s.storage[this.me] ?? {}) > 0.5 || (growthOn(this.st) && !!s.public)],
      ['build', '건설', own], ['prod', '생산', own],
      ['yard', '조선소', s.services.shipyard.length > 0 || (own && s.modules.some(m => m.kind.startsWith('yard_') && m.built))],
      ['ships', '함선 거래', growthOn(this.st) && ((!!s.public && !!s.market) || s.modules.some(m => m.kind === 'trade_hub' && m.built))],
      ['bp', '설계도', growthOn(this.st) && (!!s.public || Object.keys(s.storage[this.me] ?? {}).some(k => k.startsWith('bpf:')))],
      ['research', '연구', own || Object.keys(s.storage[this.me] ?? {}).some(k => k.startsWith('bp:') && (s.storage[this.me][k] ?? 0) >= 1)],
      ['dock', '수리·개조', true], ['recruit', '인재', s.services.recruit], ['contracts', '계약', s.services.contracts || Object.values(this.st.contracts).some(k => k.stationId === s.id)],
    ];
    const vis = tabs.filter(t => t[2]);
    if (!vis.some(t => t[0] === this.modalTab)) this.modalTab = vis[0][0];
    let body = '';
    switch (this.modalTab) {
      case 'market': body = this.marketHtml(s); break;
      case 'yard': body = growthOn(this.st) ? (own ? `${yardOwnHtml(this.st, s, this.me, this.ind, this.myGroups()).split('<h3>함선 설계</h3>')[0]}${ownYardGrowthHtml(this.st, s, this.me, this.gy, this.myGroups())}` : pubYardHtml(this.st, s, this.me, this.myGroups())) : own ? yardOwnHtml(this.st, s, this.me, this.ind, this.myGroups()) : this.yardHtml(s); break;
      case 'ships': body = exchangeHtml(this.st, s, this.me, this.myGroups()); break;
      case 'bp': body = blueprintsHtml(this.st, s, this.me); break;
      case 'dock': body = this.dockHtml(s); break;
      case 'recruit': body = this.recruitHtml(s); break;
      case 'contracts': body = this.contractsHtml(s); break;
      case 'build': body = this.buildHtml(s); break;
      case 'store': body = (growthOn(this.st) ? storageGrowthHtml(this.st, s, this.me) : '') + storeHtml(this.st, s, this.me, this.ind); break;
      case 'prod': body = prodHtml(this.st, s, this.me, this.ind); break;
      case 'research': body = researchHtml(this.st, s, this.me, this.ind); break;
    }
    trackSelects(this.modal);
    // patched in place (not rebuilt): open dropdowns, picks, typed text and scroll survive live updates
    morph(this.modal, `<div class="panel sbox"><div class="shdr"><div><div class="stitle">${esc(s.name)}</div><div class="dim">${esc(s.desc)}</div></div><div class="money">${fmt(co.credits)} cr</div><button class="btn" data-close>✕</button></div>
      <div class="tabs">${vis.map(([k, l]) => `<button class="btn${k === this.modalTab ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div class="sbody2" data-body="${this.modalTab}">${body}</div></div>`);
    const m = this.modal;
    m.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => this.closeModal();
    m.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = () => {
      // each tab keeps its own scroll position
      const cur = m.querySelector<HTMLElement>('.sbody2'); if (cur) this.tabScroll.set(this.modalTab, cur.scrollTop);
      this.modalTab = b.dataset.tab!; this.renderModal(true);
      const nb = m.querySelector<HTMLElement>('.sbody2'); if (nb) nb.scrollTop = this.tabScroll.get(this.modalTab) ?? 0;
    });
    m.querySelectorAll<HTMLButtonElement>('[data-trade]').forEach(b => b.onclick = () => {
      const [kind, res, amt] = b.dataset.trade!.split(':');
      const into = m.querySelector<HTMLSelectElement>('[data-buyinto]')?.value || undefined;
      this.cmd(kind === 'buy' && into ? { c: 'buy', station: s.id, res: res as Res, amount: Number(amt), ship: into } : { c: kind as 'sell' | 'buy', station: s.id, res: res as Res, amount: Number(amt) });
    });
    m.querySelectorAll<HTMLButtonElement>('[data-lease]').forEach(b => b.onclick = () => this.cmd({ c: 'lease', station: s.id, blocks: Number(b.dataset.lease) }));
    m.querySelectorAll<HTMLButtonElement>('[data-buyship]').forEach(b => b.onclick = () => {
      const cls = b.dataset.buyship!;
      const loSel = m.querySelector<HTMLSelectElement>(`[data-lo="${cls}"]`), grpSel = m.querySelector<HTMLSelectElement>(`[data-grp="${cls}"]`);
      if (loSel?.classList.contains('gone') || grpSel?.classList.contains('gone')) { this.toast('선택한 무장 또는 배속 편대를 더 이상 사용할 수 없습니다. 다시 선택하세요.', 'warn'); return; }
      const lo = loSel?.value ?? SHIP_CLASSES[cls].loadouts[0].id;
      const grp = grpSel?.value || undefined;
      this.cmd({ c: 'buyShip', station: s.id, classId: cls, loadoutId: lo, group: grp });
    });
    // industry panels: filters, recipe pick, orders
    const ui = this.ind;
    const pickers: [string, keyof typeof ui][] = [['icat', 'invCat'], ['rfac', 'recFac'], ['mcat', 'mkCat'], ['rsel', 'recSel']];
    for (const [attr, key] of pickers) m.querySelectorAll<HTMLElement>(`[data-${attr}]`).forEach(b => b.onclick = () => { (ui as any)[key] = b.getAttribute(`data-${attr}`); this.renderModal(true); });
    const searches: [string, keyof typeof ui][] = [['iq', 'invQ'], ['rq', 'recQ'], ['mq', 'mkQ']];
    for (const [attr, key] of searches) { const inp = m.querySelector<HTMLInputElement>(`[data-${attr}]`); if (inp) inp.oninput = () => { (ui as any)[key] = inp.value; this.renderModal(true); }; }
    m.querySelectorAll<HTMLButtonElement>('[data-porder]').forEach(b => b.onclick = async () => {
      const mode = (m.querySelector<HTMLSelectElement>('[data-pmode]')?.value ?? 'count') as 'count' | 'stock';
      const n = Number(m.querySelector<HTMLInputElement>('[data-pn]')?.value ?? 1);
      if (await this.cmd({ c: 'prodOrder', station: s.id, recipe: b.dataset.porder!, mode, n })) { sfx.play('confirm', null, 0.3); this.toast('생산 주문 등록', 'info'); }
    });
    // shipyard + fitting
    m.querySelectorAll<HTMLElement>('[data-hull]').forEach(b => b.onclick = () => { ui.hull = b.dataset.hull!; ui.fit = []; (ui as any).lo = undefined; this.renderModal(true); });
    const hlo = m.querySelector<HTMLSelectElement>('[data-hlo]'); if (hlo) hlo.onchange = () => { (ui as any).lo = hlo.value; this.renderModal(true); };
    m.querySelectorAll<HTMLButtonElement>('[data-hfit]').forEach(b => b.onclick = () => { const k = b.dataset.hfit!; const i = ui.fit.indexOf(k); if (i >= 0) ui.fit.splice(i, 1); else ui.fit.push(k); this.renderModal(true); });
    m.querySelectorAll<HTMLButtonElement>('[data-hbuild]').forEach(b => b.onclick = async () => {
      const grp = m.querySelector<HTMLSelectElement>('[data-hgrp]')?.value || undefined;
      if (await this.cmd({ c: 'buildShip', station: s.id, classId: b.dataset.hbuild!, loadoutId: (ui as any).lo ?? SHIP_CLASSES[b.dataset.hbuild!].loadouts[0].id, fit: [...ui.fit], group: grp })) { sfx.play('confirm', null, 0.3); this.toast('건조 등록', 'good'); }
    });
    // growth: public stock, own builds by hull, ship exchange, blueprints
    m.querySelectorAll<HTMLButtonElement>('[data-buyhull]').forEach(b => b.onclick = () => {
      const id = b.dataset.buyhull!; const hh = CONTENT.hulls[id];
      const pre = m.querySelector<HTMLSelectElement>(`[data-hpre="${id}"]`)?.value || undefined;
      const grp = m.querySelector<HTMLSelectElement>(`[data-hgrp2="${id}"]`)?.value || undefined;
      this.cmd({ c: 'buyShip', station: s.id, classId: hh.classId, loadoutId: '', hull: id, preset: pre, group: grp });
    });
    m.querySelectorAll<HTMLElement>('[data-ghull]').forEach(b => b.onclick = () => { this.gy.hull = b.dataset.ghull!; this.gy.preset = null; this.gy.fit = []; this.renderModal(true); });
    const gpre = m.querySelector<HTMLSelectElement>('[data-gpre]'); if (gpre) gpre.onchange = () => { this.gy.preset = gpre.value; this.renderModal(true); };
    m.querySelectorAll<HTMLButtonElement>('[data-gfit]').forEach(b => b.onclick = () => { const k = b.dataset.gfit!; const i = this.gy.fit.indexOf(k); if (i >= 0) this.gy.fit.splice(i, 1); else this.gy.fit.push(k); this.renderModal(true); });
    m.querySelectorAll<HTMLButtonElement>('[data-gbuild]').forEach(b => b.onclick = async () => {
      const id = b.dataset.gbuild!; const hh = CONTENT.hulls[id];
      const pre = m.querySelector<HTMLSelectElement>('[data-gpre]')?.value || undefined;
      const grp = m.querySelector<HTMLSelectElement>('[data-ggrp]')?.value || undefined;
      const variant = pre ? CONTENT.presets[pre]?.variant : undefined;
      if (await this.cmd({ c: 'buildShip', station: s.id, classId: hh.classId, loadoutId: '', hull: id, variant, preset: pre, fit: [...this.gy.fit], group: grp })) { sfx.play('confirm', null, 0.3); this.toast('건조 등록', 'good'); }
    });
    m.querySelectorAll<HTMLButtonElement>('[data-buylist]').forEach(b => b.onclick = async () => {
      const l = b.dataset.buylist!; const grp = m.querySelector<HTMLSelectElement>(`[data-lgrp="${l}"]`)?.value || undefined;
      if (await this.cmd({ c: 'buyShipListing', station: s.id, listing: l, group: grp })) this.toast('함선 인수 완료', 'good');
    });
    m.querySelectorAll<HTMLButtonElement>('[data-delist]').forEach(b => b.onclick = () => this.cmd({ c: 'delistShip', station: s.id, listing: b.dataset.delist! }));
    m.querySelectorAll<HTMLButtonElement>('[data-listship]').forEach(b => b.onclick = async () => {
      const id = b.dataset.listship!; const price = Number(m.querySelector<HTMLInputElement>(`[data-lprice="${id}"]`)?.value ?? 0);
      if (!confirm(`${this.st.ships[id]?.name ?? ''}을(를) ${fmt(price)} cr에 매물로 내놓을까요? 팔리기 전까지 출항할 수 없습니다.`)) return;
      if (await this.cmd({ c: 'listShip', ship: id, price })) this.toast('매물 등록', 'info');
    });
    m.querySelectorAll<HTMLButtonElement>('[data-buybp]').forEach(b => b.onclick = async () => { if (await this.cmd({ c: 'buyBlueprint', station: s.id, blueprint: b.dataset.buybp! })) sfx.play('confirm', null, 0.3); });
    m.querySelectorAll<HTMLButtonElement>('[data-asmbp]').forEach(b => b.onclick = () => this.cmd({ c: 'assembleBlueprint', station: s.id, blueprint: b.dataset.asmbp! }));
    m.querySelectorAll<HTMLButtonElement>('[data-bop]').forEach(b => b.onclick = async () => {
      const [op, build] = b.dataset.bop!.split(':');
      if (op === 'cancel' && !confirm('건조를 취소할까요? 기공 전이면 공임 전액 환불, 기공 후에는 남은 공정만큼만 환불되고 투입된 부품은 회수할 수 없습니다.')) return;
      await this.cmd({ c: 'buildOp', station: s.id, build, op: op as 'pause' });
    });
    // research
    m.querySelectorAll<HTMLElement>('[data-rfield]').forEach(b => b.onclick = () => { ui.rField = b.dataset.rfield!; this.renderModal(true); });
    m.querySelectorAll<HTMLElement>('[data-tsel]').forEach(b => b.onclick = () => { ui.tSel = b.dataset.tsel!; this.renderModal(true); });
    m.querySelectorAll<HTMLButtonElement>('[data-tres]').forEach(b => b.onclick = () => this.cmd({ c: 'research', station: s.id, tech: b.dataset.tres! }));
    m.querySelectorAll<HTMLButtonElement>('[data-tsalv]').forEach(b => b.onclick = () => this.cmd({ c: 'research', station: s.id, tech: b.dataset.tsalv!, source: 'salvage' }));
    m.querySelectorAll<HTMLButtonElement>('[data-tcopy]').forEach(b => b.onclick = () => this.cmd({ c: 'research', station: s.id, tech: b.dataset.tcopy!, source: 'copy' }));
    m.querySelectorAll<HTMLButtonElement>('[data-tlearn]').forEach(b => b.onclick = () => this.cmd({ c: 'learnBlueprint', station: s.id, tech: b.dataset.tlearn! }));
    m.querySelectorAll<HTMLButtonElement>('[data-rop]').forEach(b => b.onclick = async () => {
      const [op, project] = b.dataset.rop!.split(':');
      if (op === 'cancel' && !confirm('연구를 취소할까요? 시작 전이면 비용 전액 환불, 시작 후에는 남은 진행분만큼만 환불되고 소모된 재료는 회수할 수 없습니다.')) return;
      await this.cmd({ c: 'researchOp', project, op: op as 'pause' });
    });
    m.querySelectorAll<HTMLButtonElement>('[data-dofit]').forEach(b => b.onclick = () => { const [sid, k] = b.dataset.dofit!.split(':'); const sh = this.st.ships[sid]; this.cmd({ c: 'fitShip', ship: sid, fit: [...(sh?.fit ?? []), k] }); });
    m.querySelectorAll<HTMLButtonElement>('[data-unfit]').forEach(b => b.onclick = () => { const [sid, i] = b.dataset.unfit!.split(':'); const f = [...(this.st.ships[sid]?.fit ?? [])]; f.splice(Number(i), 1); this.cmd({ c: 'fitShip', ship: sid, fit: f }); });
    m.querySelectorAll<HTMLButtonElement>('[data-delist]').forEach(b => b.onclick = () => this.cmd({ c: 'delist', station: s.id, listing: b.dataset.delist! }));
    m.querySelectorAll<HTMLButtonElement>('[data-buyl]').forEach(b => b.onclick = () => { const [l, n] = b.dataset.buyl!.split(':'); this.cmd({ c: 'buyListing', station: s.id, listing: l, qty: Number(n) }); });
    const lb = m.querySelector<HTMLButtonElement>('[data-list]');
    if (lb) lb.onclick = () => this.cmd({ c: 'list', station: s.id, item: m.querySelector<HTMLSelectElement>('[data-lit]')!.value, qty: Number(m.querySelector<HTMLInputElement>('[data-lq]')!.value), price: Number(m.querySelector<HTMLInputElement>('[data-lp]')!.value) });
    m.querySelectorAll<HTMLButtonElement>('[data-oop]').forEach(b => b.onclick = async () => {
      const [op, order] = b.dataset.oop!.split(':');
      if (op === 'cancel' && !confirm('생산 주문을 취소할까요? 이미 시작된 배치는 끝까지 생산됩니다 (투입된 재료는 돌아오지 않음).')) return;
      await this.cmd({ c: 'prodOp', station: s.id, order, op: op as 'pause' });
    });
    m.querySelectorAll<HTMLButtonElement>('[data-repair]').forEach(b => b.onclick = () => this.cmd({ c: 'repair', ship: b.dataset.repair! }));
    m.querySelectorAll<HTMLButtonElement>('[data-openfit]').forEach(b => b.onclick = () => this.openFitting(b.dataset.openfit!));
    m.querySelectorAll<HTMLSelectElement>('[data-refit]').forEach(sel => sel.onchange = () => { if (sel.value) this.cmd({ c: 'refit', ship: sel.dataset.refit!, loadoutId: sel.value }); });
    m.querySelectorAll<HTMLButtonElement>('[data-hire]').forEach(b => b.onclick = () => this.cmd({ c: 'hire', commander: b.dataset.hire! }));
    m.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach(b => b.onclick = () => this.cmd({ c: 'accept', contract: b.dataset.accept! }));
    m.querySelectorAll<HTMLButtonElement>('[data-module]').forEach(b => b.onclick = async () => {
      const kind = b.dataset.module!;
      const before = new Set(s.modules.map(x => x.id));
      if (await this.cmd({ c: 'queueModule', station: s.id, kind })) {
        sfx.play('confirm', null, 0.3);
        // follow the new plan in the detail panel once a snapshot has it
        const follow = (n: number) => {
          const np = this.st.stations[s.id]?.modules.find(x => x.kind === kind && !x.built && !before.has(x.id));
          if (np?.id) { this.bSel = { kind, plan: np.id }; this.renderModal(true); } else if (n > 0) setTimeout(() => follow(n - 1), 250);
        };
        follow(12);
      }
    });
    m.querySelectorAll<HTMLElement>('[data-bpick]').forEach(b => b.onclick = () => { this.bSel = { kind: b.dataset.bpick! }; this.renderModal(true); });
    m.querySelectorAll<HTMLElement>('[data-bplan]').forEach(b => b.onclick = e => {
      if ((e.target as HTMLElement).closest('button')) return;
      const pm = s.modules.find(x => x.id === b.dataset.bplan); if (pm) { this.bSel = { kind: pm.kind, plan: pm.id }; this.renderModal(true); }
    });
    m.querySelectorAll<HTMLButtonElement>('[data-pop]').forEach(b => b.onclick = async () => {
      const [op, plan] = b.dataset.pop!.split(':');
      if (op === 'cancel' && !confirm('이 건설 계획을 취소할까요? 예약 자재는 창고로 돌아가고, 이미 투입된 자재는 회수할 수 없습니다.')) return;
      if (await this.cmd({ c: 'planOp', station: s.id, plan, op: op as 'pause' })) this.renderModal(true);
    });
  }

  private marketHtml(s: Station): string {
    const v3 = growthOn(this.st);
    const price = (r: Res, side: 'sell' | 'buy') => priceOf(s.market?.[r], side, v3);
    const funds = v3 && s.public && s.fundsMax ? `<div class="bdr small">정거장 구매 예산 <b class="money">${fmt(s.funds ?? 0)}</b> / ${fmt(s.fundsMax)} cr <span class="dim">— 플레이어에게 물건을 사는 데 쓰는 돈입니다. 시간당 15%씩 회복되고, 플레이어가 이곳에서 산 금액의 일부가 돌아옵니다. 예산이 떨어지면 남은 화물은 창고에 보관됩니다.</span></div>` : '';
    let into = '';
    if (v3 && s.public) {
      const docked = Object.values(this.st.ships).filter(x => x.owner === this.me && x.task.k === 'docked' && (x.task as any).station === s.id && econOf(x).cargo > 0);
      into = storageGrowthHtml(this.st, s, this.me).split('<details')[0] + (docked.length ? `<div class="yrow small">구매품 받을 곳 <select data-buyinto data-keep><option value="">공용 창고 (이 정거장)</option>${docked.map(x => `<option value="${x.id}">${esc(x.name)} 화물칸 (여유 ${fmt(econOf(x).cargo - cargoSum(x.cargo))})</option>`).join('')}</select> <span class="dim">— 화물칸으로 사면 창고 한도와 상관없이 바로 싣고 떠날 수 있습니다</span></div>` : '');
    }
    return funds + into + marketPanel(this.st, s, this.me, this.ind, price);
  }

  private yardHtml(s: Station): string {
    const co = this.st.companies[this.me];
    const own = s.owner === this.me;
    const classes = own ? ['corvette', 'destroyer', 'cruiser', 'battleship', 'miner', 'hauler', 'constructor'] : s.services.shipyard;
    const groups = this.myGroups();
    const store = s.storage[this.me];
    return `<div class="yard">${classes.map(id => {
      const c = SHIP_CLASSES[id]; const e = ECON[id];
      const price = own ? Math.round(e.price * 0.5) : e.price;
      const locked = !own && co.rep < e.rep;
      const canAlloy = !own || qty(store, 'alloy') >= e.alloy;
      return `<div class="ycard${locked ? ' locked' : ''}"><div class="yn"><b>${c.name} ${c.type}</b><span class="money">${fmt(price)} cr${own ? ` + 합금 ${e.alloy}` : ''}</span></div>
        <div class="dim">${esc(c.desc)}</div>
        <div class="ys">내구 ${c.hp} · 순항 ${e.cruise} ${e.cargo ? `· 화물 ${e.cargo}` : ''}${e.mine ? ` · 채굴 ${e.mine}/s` : ''}</div>
        ${locked ? `<div class="warn">연합 평판 ${e.rep} 필요 (현재 ${co.rep}) — 해적 토벌과 계약으로 평판을 올리세요</div>` : `
        <div class="yrow"><select data-lo="${id}" data-keep>${c.loadouts.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
        <select data-grp="${id}" data-keep><option value="">새 편대</option>${groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
        <button class="btn go" data-buyship="${id}" ${co.credits < price || !canAlloy ? 'disabled' : ''}>구매</button></div>
        ${co.credits < price ? `<div class="warn small">자금 부족 — ${fmt(price - co.credits)} cr 더 필요</div>` : !canAlloy ? `<div class="warn small">합금 부족 — 이 정거장 창고 ${fmt(qty(store, 'alloy'))}/${e.alloy}</div>` : ''}`}</div>`;
    }).join('')}</div>`;
  }

  /** one-line description of a V2 fitting: variant, weapons ×n, modules */
  private fitSummary(x: WShip): string {
    const f = x.fitting!; const n: Record<string, number> = {};
    for (const k of Object.values(f.hp)) n[k] = (n[k] ?? 0) + 1;
    const w = Object.entries(n).map(([k, c]) => `${esc(EQUIPMENT[k]?.name ?? k)}${c > 1 ? ` ×${c}` : ''}`).join(', ');
    const m = Object.values(f.bay).map(k => esc(EQUIPMENT[k]?.name ?? k)).join(', ');
    const bad = checkFitting(x.variant!, f).errors.length;
    return `<b>${esc(CONTENT.variants[x.variant!]?.name ?? '')}</b> <span class="dim">· ${w || '무장 없음'}${m ? ` · 모듈: ${m}` : ''}</span>${bad ? ' <span class="warn">⚠ 규칙 위반 장비</span>' : ''}`;
  }

  private dockHtml(s: Station): string {
    const ships = Object.values(this.st.ships).filter(x => x.owner === this.me && x.task.k === 'docked' && (x.task as any).station === s.id);
    const own = s.owner === this.me;
    const canRepair = s.services.repair || (own && s.modules.some(m => m.kind === 'repair' && m.built));
    const canRefit = s.services.refit || (own && s.modules.some(m => (m.kind === 'fitting' || m.kind.startsWith('yard_')) && m.built));
    const store = s.storage[this.me] ?? {};
    if (!ships.length) return `<div class="dim">이 정거장에 정박한 자사 함선이 없습니다. 편대를 선택하고 정거장을 우클릭하면 정박합니다.</div>`;
    return `<table class="gt"><tr><th>함선</th><th>선체</th><th>무장</th><th></th></tr>${ships.map(x => {
      const c = SHIP_CLASSES[x.classId];
      const cost = Math.round((1 - x.hp) * econOf(x).price * 0.3);
      return `<tr><td><b>${esc(x.name)}</b> <span class="dim">${c.type}</span></td><td><span style="color:${hpCol(x.hp)}">${Math.round(x.hp * 100)}%</span></td>
        <td>${x.fitting ? `${this.fitSummary(x)} ${canRefit ? `<button class="btn go" data-openfit="${x.id}">피팅</button>` : '<span class="dim small">(피팅 시설 없음)</span>'}` : canRefit && c.loadouts.length > 1 ? `<select data-refit="${x.id}"><option value="">${esc(getLoadout(x.classId, x.loadoutId).name)} (${own ? '창고의 무장 장비로 교체' : `개조 ${fmt(econOf(x).price * 0.15)} cr`})</option>${c.loadouts.filter(l => l.id !== x.loadoutId).map(l => `<option value="${l.id}">→ ${esc(l.name)}</option>`).join('')}</select>` : esc(getLoadout(x.classId, x.loadoutId).name)}</td>
        <td>${x.hp < 0.999 && canRepair ? `<button class="btn" data-repair="${x.id}">수리 ${fmt(cost)} cr</button>` : ''}</td></tr>
        ${canRefit && !x.fitting ? `<tr class="fitrow"><td colspan="4">${fitHtml(this.st, x, store)}</td></tr>` : ''}`;
    }).join('')}</table>${own && s.modules.some(m => m.kind === 'repair' && m.built) ? '<div class="dim small">정비소: 이곳에 정박한 자사 함선은 무료로 천천히 수리됩니다.</div>' : ''}`;
  }

  private recruitHtml(s: Station): string {
    const pool = Object.values(this.st.commanders).filter(c => !c.owner && c.stationId === s.id);
    if (!pool.length) return '<div class="dim">지금은 영입 가능한 지휘관이 없습니다. 잠시 후 다시 확인하세요.</div>';
    return `<div class="yard">${pool.map(c => `<div class="ycard"><div class="yn"><span><span class="portrait" style="background:${c.color};width:34px;height:34px;font-size:13px;margin-right:8px">${esc(c.name.replace(/\s/g, '').slice(0, 2))}</span><b>${esc(c.rank)} ${esc(c.name)}</b></span><span class="money">${fmt(c.hireCost)} cr</span></div>
      <div class="traits"><span>판단력</span><div class="bar"><i style="width:${c.skill * 100}%"></i></div><span>공격성</span><div class="bar"><i style="width:${c.aggression * 100}%;background:var(--warn)"></i></div><span>규율</span><div class="bar"><i style="width:${c.discipline * 100}%;background:var(--good)"></i></div></div>
      <div class="dim">${esc(c.bio)}</div><div class="cmdspec">${SPECIALTY_TEXT[c.specialty]}</div>
      <button class="btn go" data-hire="${c.id}">영입</button></div>`).join('')}</div>`;
  }

  private contractsHtml(s: Station): string {
    const ks = Object.values(this.st.contracts).filter(k => k.stationId === s.id && !k.done);
    if (!ks.length) return '<div class="dim">게시된 계약이 없습니다.</div>';
    return `<div class="yard">${ks.map(k => `<div class="ycard${k.takenBy && k.takenBy !== this.me ? ' locked' : ''}"><div class="yn"><b>${esc(k.title)}</b><span class="money">${fmt(k.reward)} cr · 평판 +${k.rep}</span></div>
      <div class="dim">${esc(k.desc)}</div>
      <div class="ys">${k.kind === 'delivery' ? `진행 ${Math.round(k.progress)}/${k.amount} · ` : ''}${Math.max(0, Math.round((k.expires - this.st.time) / 60))}분 남음</div>
      ${k.takenBy === this.me ? '<div class="good">수주함 — 진행 중</div>' : k.takenBy ? `<div class="warn">${esc(this.st.companies[k.takenBy]?.name ?? '')} 수주</div>` : `<button class="btn go" data-accept="${k.id}">수주</button>`}</div>`).join('')}</div>
      <div class="dim small">납품 계약: 해당 정거장에 자원을 하역하면 자동으로 납품됩니다. 현상금: 해당 해적 무리 격멸 전투에 참여하면 완수됩니다.</div>`;
  }

  /** facility picked in the build tab's detail panel: a module kind (new plan) or a plan id */
  private bSel: { kind: string; plan?: string } | null = null;

  private buildHtml(s: Station): string {
    const store = s.storage[this.me] ?? {};
    const co = this.st.companies[this.me];
    const plans = planList(s);
    const built = s.modules.filter(m => m.built);
    const reservedTot: Record<string, number> = {};
    for (const m of plans) for (const [r, n] of Object.entries(m.reserved ?? {})) if (n > 0.01) reservedTot[r] = (reservedTot[r] ?? 0) + n;
    const shortQ = queueShortfall(s);
    const cons = Object.values(this.st.groups).filter(g => g.owner === this.me && g.op.k === 'build' && (g.op as any).station === s.id);
    const lst = (c: Record<string, number>) => Object.entries(c).map(([k, n]) => `${iname(k)} ${fmt(n)}`).join(' · ');
    const count = (k: string) => built.filter(m => m.kind === k).length;
    // ── summary ──
    let html = `<div class="bstore"><div><b>시설</b> ${built.length}개 가동 · 계획 ${plans.length} · 슬롯 ${s.modules.length}/${MAX_MODULES}${cons.length ? ` · 공작선 ${cons.length}개 편대 투입` : ''}${count('core') ? ' · 자체 건설반' : ''}</div>
      ${Object.keys(reservedTot).length ? `<div class="dim small">건설 예약됨: ${lst(reservedTot)}</div>` : ''}
      ${Object.keys(shortQ).length ? `<div class="small"><span class="warn">대기열 부족분</span>: ${lst(shortQ)} — 이 정거장 창고로 운송하세요 (수송선 '자동 보급'도 건설 부족분을 실어 옵니다)</div>` : ''}</div>`;
    // ── construction queue ──
    html += `<h3>건설 진행 · 대기열 (${plans.length})</h3>`;
    html += plans.length ? `<div class="bq">${plans.map((m, i) => {
      const md = MODULES[m.kind]; const ps = planState(s, m);
      const mats = matsOf(m.kind).map(r => {
        const have = (m.used?.[r] ?? 0) + (m.reserved?.[r] ?? 0), miss = missing(m, r);
        return `${iname(r)} ${fmt(have)}/${fmt(md.mats[r])}${miss > 0.5 ? ` <span class="warn">${fmt(miss)} 부족</span>` : ''}`;
      }).join(' · ');
      const sel = this.bSel?.plan === m.id;
      return `<div class="bqrow ps-${ps}${sel ? ' sel' : ''}" data-bplan="${m.id}"><span class="bqn">${i + 1}</span>
        <div class="bqm"><div><b>${md.name}</b> <span class="pst">${PLAN_STATE_NAME[ps]}${ps === 'building' ? ` ${Math.round(m.progress * 100)}%` : ''}</span></div>
        <div class="bar"><i style="width:${Math.round(m.progress * 100)}%"></i></div><div class="small">${mats}</div></div>
        <div class="bqa"><button class="btn mini" data-pop="up:${m.id}" title="위로" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn mini" data-pop="down:${m.id}" title="아래로" ${i === plans.length - 1 ? 'disabled' : ''}>▼</button>
        ${m.paused ? `<button class="btn mini" data-pop="resume:${m.id}">▶ 재개</button>` : `<button class="btn mini" data-pop="pause:${m.id}">⏸ 정지</button>`}
        ${m.kind === 'core' ? '' : `<button class="btn mini warnb" data-pop="cancel:${m.id}">✕ 취소</button>`}</div></div>`;
    }).join('')}</div>` : '<div class="dim small">진행 중인 건설이 없습니다.</div>';
    // ── owned + buildable by category ──
    const planned = (k: string) => s.modules.filter(m => m.kind === k).length;
    const buildable = (md: ModuleDef) => md.kind !== 'core' && (!md.growth || growthOn(this.st)) && (md.max === undefined || planned(md.kind) < md.max);
    html += `<div class="bcols"><div class="bcat">${FAC_CATS.map(c => {
      const kinds = [...new Set(built.filter(m => MODULES[m.kind]?.cat === c).map(m => m.kind))];
      const can = Object.values(MODULES).filter(md => md.cat === c && buildable(md));
      if (!kinds.length && !can.length) return '';
      return `<div class="bcg"><div class="bch">${c}</div>
        ${kinds.map(k => `<div class="bfac own"><b>${MODULES[k].name}</b>${count(k) > 1 ? ` ×${count(k)}` : ''} <span class="good">가동 중</span></div>`).join('')}
        ${can.map(md => {
          const req = !md.requires || s.modules.some(m => m.kind === md.requires);
          const tech = !md.tech || co.tech?.includes(md.tech);
          return `<div class="bfac pick${this.bSel?.kind === md.kind && !this.bSel.plan ? ' sel' : ''}${req && tech ? '' : ' locked'}" data-bpick="${md.kind}"><b>${md.name}</b>${planned(md.kind) ? ` <span class="dim">(+${planned(md.kind)})</span>` : ''} <span class="money">${fmt(md.credits)} cr</span><div class="dim small">${lst(md.mats)}${tech ? '' : ` · <span class="warn">연구: ${esc(TECHS[md.tech!]?.name ?? '')}</span>`}</div></div>`;
        }).join('')}</div>`;
    }).join('')}</div><div class="bdet">${this.buildDetail(s)}</div></div>
      <div class="dim small">건설 자재는 <b>이 정거장 창고</b>에서만 쓰입니다 (다른 정거장 창고는 운송 필요, 함선 화물은 하역 후 반영). 계획에 예약된 자재는 판매·생산·운송에 쓸 수 없습니다. 같은 시설을 여러 개 지으면 처리량(라인)이 늘어납니다.</div>`;
    return html;
  }

  /** detail panel: the selected facility or plan — cost, held / reserved / available / short, time, unlocks */
  private buildDetail(s: Station): string {
    const sel = this.bSel;
    if (!sel) return '<div class="dim" style="padding:12px">왼쪽에서 시설이나 대기열 항목을 선택하면 상세 정보가 표시됩니다.</div>';
    const md = MODULES[sel.kind]; if (!md) return '';
    // a single-instance facility that has just been planned: follow its plan
    if (!sel.plan && md.max === 1) {
      const pm = s.modules.find(m => m.kind === sel.kind && !m.built);
      if (pm?.id) { this.bSel = { kind: sel.kind, plan: pm.id }; return this.buildDetail(s); }
    }
    const co = this.st.companies[this.me];
    const store = s.storage[this.me] ?? {};
    const plan = sel.plan ? s.modules.find(m => m.id === sel.plan && !m.built) : undefined;
    if (sel.plan && !plan) { const done = s.modules.find(m => m.id === sel.plan); return `<div class="bdh"><b>${md.name}</b></div><div class="${done ? 'good' : 'dim'}">${done ? '완공되었습니다.' : '취소된 계획입니다.'}</div>`; }
    const cons = Object.values(this.st.groups).filter(g => g.owner === this.me && g.op.k === 'build' && (g.op as any).station === s.id);
    const crew = s.modules.some(m => m.kind === 'core' && m.built) && md.kind !== 'core';
    const rate = (crew ? STATION_CREW_RATE : 0) + cons.reduce((a, g) => a + (g.commanderId ? 0.8 + (this.st.commanders[g.commanderId]?.skill ?? 0.5) * 0.5 : 1), 0);
    const left = md.work * (1 - (plan?.progress ?? 0));
    const tStr = rate > 0 ? `약 ${fmtT(left / rate)}${cons.length ? ` (공작선 ${cons.length}개 편대${crew ? ' + 자체 건설반' : ''})` : ' (자체 건설반만 — 공작선을 투입하면 더 빠름)'}` : '공작선 필요 (도킹 허브는 공작선만 건설 가능)';
    const ahead = queueShortfall(s);
    const rows = Object.entries(md.mats).map(([r, need]) => {
      const name = iname(r); const have = qty(store, r);
      if (plan) {
        const used = plan.used?.[r] ?? 0, res = plan.reserved?.[r] ?? 0, miss = missing(plan, r);
        return `<tr><td>${name}</td><td class="n">${fmt(need)}</td><td class="n">${fmt(used + res)}</td><td class="n">${fmt(res)}</td><td class="n">${fmt(have)}</td><td class="n">${miss > 0.5 ? `<span class="warn">${fmt(miss)} 부족</span>` : '<span class="good">충분</span>'}</td></tr>`;
      }
      const avail = Math.max(0, have - (ahead[r] ?? 0));
      const miss = Math.max(0, need - avail);
      return `<tr><td>${name}</td><td class="n">${fmt(need)}</td><td class="n">${fmt(have)}</td><td class="n">${fmt(avail)}${(ahead[r] ?? 0) > 0.5 ? `<div class="dim small">앞선 계획 ${fmt(ahead[r])} 우선</div>` : ''}</td><td class="n">${miss > 0.5 ? `<span class="warn">${fmt(miss)} 부족</span>` : '<span class="good">충분</span>'}</td></tr>`;
    }).join('');
    const ps = plan ? planState(s, plan) : null;
    const req = !md.requires || s.modules.some(m => m.kind === md.requires);
    const tech = !md.tech || co.tech?.includes(md.tech);
    const slots = s.modules.length < MAX_MODULES;
    const crShort = Math.max(0, md.credits - co.credits);
    const extra = [md.power > 0 ? `전력 +${md.power}` : md.power < 0 ? `전력 소모 ${-md.power}` : '', md.lines ? `라인 ${md.lines}` : '', md.storage ? `창고 +${fmt(md.storage)}` : '', md.max ? `정거장당 최대 ${md.max}` : '여러 개 건설 가능'].filter(Boolean).join(' · ');
    let act = '';
    if (!plan) {
      const why = !tech ? `연구 필요: ${esc(TECHS[md.tech!]?.name ?? md.tech!)}` : !req ? `${MODULES[md.requires!].name}이(가) 먼저 필요합니다` : !slots ? `시설 슬롯이 가득 찼습니다 (${MAX_MODULES})` : crShort > 0 ? `자금 부족 — ${fmt(crShort)} cr 더 필요` : '';
      act = `${why ? `<div class="warn">${why}</div>` : ''}<button class="btn go" data-module="${md.kind}" ${why ? 'disabled' : ''}>건설 계획 등록</button>
        <div class="dim small">자재가 부족해도 등록할 수 있습니다. 자재가 이 정거장 창고에 들어오면 자동으로 예약되고, 모두 확보되면 착공합니다.</div>`;
    } else act = `<div class="bqa">${plan.paused ? `<button class="btn" data-pop="resume:${plan.id}">▶ 재개</button>` : `<button class="btn" data-pop="pause:${plan.id}">⏸ 일시 정지</button>`}${plan.kind === 'core' ? '' : `<button class="btn warnb" data-pop="cancel:${plan.id}">✕ 계획 취소</button>`}</div>
      <div class="dim small">일시 정지: 예약 자재는 유지, 작업·추가 확보 중단 · 취소: 예약 자재는 창고로 반환, 투입된 자재는 회수 불가, 크레딧은 남은 공정 비율만큼 환불${plan.progress <= 0 ? ' (착공 전이라 전액)' : ` (현재 ${fmt((plan.paid ?? 0) * (1 - plan.progress))} cr)`}</div>`;
    return `<div class="bdh"><b>${md.name} 건설</b> <span class="dim">· ${md.cat}</span>${ps ? ` <span class="pst ps-${ps}">${PLAN_STATE_NAME[ps]}${ps === 'building' ? ` ${Math.round(plan!.progress * 100)}%` : ''}</span>` : ''}</div>
      <div class="dim">${esc(md.desc)}</div>
      <div class="bdr small">${extra}</div>
      <div class="bdr">비용 <b class="money">${fmt(md.credits)} cr</b>${plan ? ' (등록 시 지불됨)' : ` — 보유 ${fmt(co.credits)} cr ${crShort > 0 ? `<span class="warn">${fmt(crShort)} 부족</span>` : '<span class="good">충분</span>'}`}</div>
      <table class="gt bmat"><tr><th>자재</th><th>필요</th>${plan ? '<th>확보</th><th>예약</th><th>창고 가용</th>' : '<th>창고</th><th>가용</th>'}<th>상태</th></tr>${rows}</table>
      <div class="bdr">예상 건설 시간: ${tStr}</div>
      <div class="bdr">완공 시 해금: <b>${esc(md.unlocks)}</b></div>${act}`;
  }

  // ============================================================== overlay

  private drawOverlay() {
    const ctx = this.ctx, W = innerWidth, H = innerHeight;
    ctx.clearRect(0, 0, W, H);
    if (!this.v.active) return;
    const st = this.st, v = this.v, p = new THREE.Vector3();
    const camD = v.rig.camera.position.distanceTo(v.rig.focus);
    const far = camD > 3500;
    this.labels = [];
    ctx.font = '600 11px "Noto Sans KR", sans-serif';
    const label = (x: number, y: number, text: string, color: string, bg = 'rgba(4,12,20,0.7)', sub?: string) => {
      const tw = Math.max(ctx.measureText(text).width, sub ? ctx.measureText(sub).width * 0.9 : 0);
      let ly = y;
      for (let k = 0; k < 6; k++) { const hit = this.labels.find(r => x - tw / 2 - 5 < r.x1 && x + tw / 2 + 5 > r.x0 && ly - 11 < r.y1 && ly + (sub ? 16 : 5) > r.y0); if (!hit) break; ly = hit.y0 - (sub ? 18 : 6); }
      const hh = sub ? 27 : 16;
      ctx.fillStyle = bg; ctx.fillRect(x - tw / 2 - 5, ly - 11, tw + 10, hh);
      ctx.fillStyle = color; ctx.fillRect(x - tw / 2 - 5, ly - 11, 2, hh);
      ctx.fillText(text, x - ctx.measureText(text).width / 2, ly + 1);
      if (sub) { ctx.font = '10px "Noto Sans KR", sans-serif'; ctx.fillStyle = '#9ab'; ctx.fillText(sub, x - ctx.measureText(sub).width / 2, ly + 13); ctx.font = '600 11px "Noto Sans KR", sans-serif'; }
      this.labels.push({ x0: x - tw / 2 - 5, x1: x + tw / 2 + 5, y0: ly - 11, y1: ly - 11 + hh });
    };
    // planets and gates
    for (const pl of v.sys?.planets ?? []) {
      if (!v.project({ x: pl.pos.x, y: pl.pos.y + pl.size, z: pl.pos.z }, p)) continue;
      ctx.fillStyle = 'rgba(200,220,240,.75)'; ctx.font = '600 12px "Noto Sans KR", sans-serif';
      ctx.fillText(pl.name, p.x - ctx.measureText(pl.name).width / 2, p.y - 8);
      ctx.font = '600 11px "Noto Sans KR", sans-serif';
    }
    if (v.sys && v.project(v.sys.origin, p) && camD > 20000) { ctx.fillStyle = 'rgba(255,230,190,.8)'; const t = `☀ ${v.sys.star.name}`; ctx.fillText(t, p.x - ctx.measureText(t).width / 2, p.y - 30); }
    for (const gt of v.sys?.gates ?? []) {
      if (!v.project(gt.pos, p)) continue;
      const dest = st.systems[gt.to];
      label(p.x, p.y - 24, `⟁ ${dest?.name ?? ''}`, secBand(dest ? effSec(dest) : 50).color, 'rgba(4,16,30,0.8)', dest ? `${secBand(effSec(dest)).name} · 치안 ${Math.round(effSec(dest))}` : undefined);
    }
    // stations
    for (const s of Object.values(st.stations)) {
      if (!v.project(s.pos, p)) continue;
      const co = st.companies[s.owner];
      label(p.x, p.y - 26, `${s.public ? '◎' : '⬢'} ${s.name}`, co?.color ?? '#9cf', 'rgba(4,12,20,0.75)', s.public ? undefined : `${co?.name ?? ''} · 모듈 ${s.modules.filter(m => m.built).length}/${s.modules.length}`);
    }
    for (const f of Object.values(st.fields)) {
      if (!v.project(f.pos, p)) continue;
      const frac = f.amount / f.max;
      label(p.x, p.y, `${f.salvage ? '✱' : '◇'} ${f.name}`, RES_COLOR[f.res], 'rgba(4,12,20,0.55)', `${RES_NAME[f.res]} ${fmt(f.amount)} ${f.danger > 1 ? '· 위험 ' + '▲'.repeat(f.danger) : ''}`);
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(p.x - 24, p.y + 18, 48, 3);
      ctx.fillStyle = RES_COLOR[f.res]; ctx.fillRect(p.x - 24, p.y + 18, 48 * frac, 3);
    }
    for (const l of Object.values(st.lairs)) {
      if (!v.project(l.pos, p)) continue;
      label(p.x, p.y - 22, `☠ ${l.name}`, l.alive ? '#ff5040' : '#666', 'rgba(30,4,4,0.7)', l.alive ? `요새 ${Math.round(l.hp * 100)}%` : '파괴됨');
    }
    // battles
    for (const e of Object.values(st.engagements)) {
      if (e.done || !v.project(e.pos, p)) continue;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
      ctx.strokeStyle = `rgba(255,90,60,${0.5 + pulse * 0.5})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 18 + pulse * 6, 0, Math.PI * 2); ctx.stroke();
      label(p.x, p.y - 34, `⚔ 교전 중 ${e.sides[0].includes(this.me) ? '— 클릭하여 지휘' : ''}`, '#ff6040', 'rgba(40,6,4,0.85)');
    }
    // ships (icons when far)
    for (const s of Object.values(st.ships)) {
      if (s.state === 'battle') continue;
      const sv = v.ships.get(s.id); if (!sv || !v.project(sv.pos, p)) continue;
      const co = st.companies[s.owner];
      const selected = this.group && s.groupId === this.group;
      const mil = econOf(s).military;
      if (far || selected || s.owner === 'pirates') {
        ctx.fillStyle = co?.color ?? '#fff';
        ctx.strokeStyle = selected ? '#fff' : co?.color ?? '#fff';
        const r = selected ? 4.5 : 3;
        if (mil) { ctx.beginPath(); ctx.moveTo(p.x, p.y - r - 1); ctx.lineTo(p.x + r, p.y + r); ctx.lineTo(p.x - r, p.y + r); ctx.closePath(); }
        else { ctx.beginPath(); ctx.rect(p.x - r * 0.8, p.y - r * 0.8, r * 1.6, r * 1.6); }
        if (s.owner === 'pirates' || selected) ctx.fill(); else ctx.stroke();
        if (selected) { ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke(); }
      }
    }
    // groups: own (with order lines), other players, pirates
    for (const g of Object.values(st.groups)) {
      const c = this.center(g); if (!c || !v.project(c, p)) continue;
      const co = st.companies[g.owner]; if (!co) continue;
      const x = p.x, y = p.y;
      if (g.owner === this.me) {
        const sel = this.group === g.id;
        if (sel || !far) this.drawOpLine(g, c, x, y, sel);
        label(x, y + 22, `${g.name}`, co.color, sel ? 'rgba(20,50,70,0.85)' : 'rgba(4,12,20,0.6)', g.status);
      } else if (co.kind === 'pirate') {
        label(x, y + 20, `☠ ${g.name} (${g.shipIds.length})`, '#ff5040', 'rgba(40,6,4,0.75)');
      } else if (co.kind === 'player') {
        label(x, y + 20, `${co.name}: ${g.name}`, co.color, 'rgba(4,12,20,0.5)');
      } else if (!far) label(x, y + 20, g.name, co.color, 'rgba(4,12,20,0.4)');
    }
    if (this.mode) { ctx.strokeStyle = 'rgba(255,179,71,0.9)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(this.pointer.x, this.pointer.y, 12, 0, Math.PI * 2); ctx.stroke(); }
  }

  private drawOpLine(g: WGroup, c: V, x: number, y: number, sel: boolean) {
    const st = this.st, v = this.v, p = new THREE.Vector3();
    const op = g.override || !g.parentId ? g.op : null;
    if (!op) return;
    let to: V | null = null; let to2: V | null = null;
    switch (op.k) {
      case 'move': to = op.to; break;
      case 'dock': to = st.stations[op.station]?.pos ?? null; break;
      case 'mine': to = st.fields[op.field]?.pos ?? null; to2 = st.stations[op.deliver]?.pos ?? null; break;
      case 'haul': to = st.stations[op.from]?.pos ?? null; to2 = st.stations[op.to]?.pos ?? null; break;
      case 'patrol': to = op.at; break;
      case 'escort': { const t = st.groups[op.group]; to = t ? this.center(t) : null; break; }
      case 'attack': to = op.lair ? st.lairs[op.lair]?.pos ?? null : op.group && st.groups[op.group] ? this.center(st.groups[op.group]) : null; break;
      case 'build': to = st.stations[op.station]?.pos ?? null; break;
      case 'found': to = op.at; break;
    }
    if (!to) return;
    const col: Record<string, string> = { mine: '#e0a060', haul: '#9fc8e8', attack: '#ff6a55', escort: '#7dffb0', patrol: '#6ab8ff', build: '#40c8ff', found: '#40c8ff' };
    const ctx = this.ctx;
    ctx.strokeStyle = col[op.k] ?? '#6ab8ff'; ctx.globalAlpha = sel ? 0.85 : 0.35; ctx.lineWidth = sel ? 1.5 : 1;
    ctx.setLineDash([6, 6]); ctx.lineDashOffset = -performance.now() / 60;
    ctx.beginPath(); ctx.moveTo(x, y);
    if (v.project(to, p)) { ctx.lineTo(p.x, p.y); if (to2 && v.project(to2, new THREE.Vector3())) { const q = new THREE.Vector3(); v.project(to2, q); ctx.moveTo(p.x, p.y); ctx.setLineDash([2, 5]); ctx.lineTo(q.x, q.y); } }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    if (op.k === 'patrol' && sel && v.project(op.at, p)) {
      const d = v.rig.camera.position.distanceTo(new THREE.Vector3(op.at.x, op.at.y, op.at.z));
      ctx.strokeStyle = 'rgba(106,184,255,.5)'; ctx.beginPath(); ctx.ellipse(p.x, p.y, op.radius / d * innerHeight, op.radius / d * innerHeight * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
    }
    void c;
  }

  private tooltip() {
    const tip = document.getElementById('tooltip')!;
    if (this.pointer.down >= 0) { tip.classList.add('hidden'); return; }
    const pk = this.v.pick(this.pointer.x, this.pointer.y);
    const st = this.st;
    if (!pk) {
      // empty space: local security under the cursor (only when it matters for a decision)
      // empty space with the security map on: the exact local security under the cursor
      const pt = this.v.showSecurity && this.pointer.over ? this.v.screenToPlane(this.pointer.x, this.pointer.y, 0) : null;
      const sys = pt && this.v.sys;
      if (!pt || !sys || !this.v.inView(pt) || Math.hypot(pt.x - sys.origin.x, pt.z - sys.origin.z) > sys.radius * 1.02) { tip.classList.add('hidden'); return; }
      tip.innerHTML = this.secCursor(pt);
      tip.style.left = `${this.pointer.x + 14}px`; tip.style.top = `${this.pointer.y + 12}px`;
      tip.classList.remove('hidden');
      return;
    }
    let html = '';
    if (pk.kind === 'ship') { const s = st.ships[pk.id]; const co = st.companies[s.owner]; html = `<b style="color:${co?.color}">${esc(s.name)}</b> <span class="dim">${SHIP_CLASSES[s.classId].type} · ${esc(co?.name ?? '')}</span><br>선체 ${Math.round(s.hp * 100)}% · ${esc(st.groups[s.groupId]?.status ?? '')}`; }
    else if (pk.kind === 'station') { const s = st.stations[pk.id]; html = `<b>${esc(s.name)}</b><br><span class="dim">클릭: 정보 · 우클릭: 정박</span>`; }
    else if (pk.kind === 'field') { const f = st.fields[pk.id]; html = `<b>${esc(f.name)}</b> ${RES_NAME[f.res]} ${fmt(f.amount)}<br><span class="dim">우클릭: 선택 편대 채굴</span>`; }
    else if (pk.kind === 'lair') html = `<b>☠ ${esc(st.lairs[pk.id].name)}</b>`;
    else if (pk.kind === 'battle') html = '<b>⚔ 교전 중</b><br><span class="dim">클릭하여 전투 화면</span>';
    else if (pk.kind === 'gate') { const gt = this.v.sys?.gates.find(g => g.id === pk.id); html = `<b>⟁ ${esc(gt?.name ?? '')}</b><br><span class="dim">우클릭: 선택 편대 점프</span>`; }
    else if (pk.kind === 'planet') { const pl = this.v.sys?.planets.find(x => x.id === pk.id); html = `<b>${esc(pl?.name ?? '')}</b>`; }
    tip.innerHTML = html;
    tip.style.left = `${this.pointer.x + 14}px`; tip.style.top = `${this.pointer.y + 12}px`;
    tip.classList.remove('hidden');
  }
}
