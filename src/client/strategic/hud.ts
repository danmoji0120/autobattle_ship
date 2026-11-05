import * as THREE from 'three';
import type { GameClient } from '../net';
import type { StrategicView, Pick } from './view';
import type { WGroup, WShip, Op, Station, Res, WorldEvent, V } from '../../world/types';
import { RES, cargoSum } from '../../world/types';
import type { WorldView } from '../../server/protocol';
import { SHIP_CLASSES, getLoadout } from '../../sim/data/ships';
import { SPECIALTY_TEXT } from '../../sim/data/commanders';
import { ECON, MODULES, MAX_MODULES, RES_NAME, RES_COLOR, MILESTONES, FOUND_COST } from '../../world/data';
import { sfx } from '../../audio/sfx';

type Mode = null | 'move' | 'dock' | 'mine' | 'haul_from' | 'haul_to' | 'patrol' | 'escort' | 'attack' | 'build' | 'found';
type Sel = { kind: 'group' | 'ship' | 'station' | 'field' | 'lair' | 'battle'; id: string } | null;

const h = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();
const fmtT = (t: number) => `${Math.floor(t / 3600) ? Math.floor(t / 3600) + ':' : ''}${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const hpCol = (f: number) => f > 0.6 ? 'var(--good)' : f > 0.3 ? 'var(--warn)' : 'var(--enemy)';

const OP_NAME: Record<string, string> = { idle: '대기', move: '이동', dock: '정박', mine: '채굴', haul: '운송', patrol: '순찰', escort: '호위', attack: '공격', build: '건설', found: '정거장 설립', raid: '약탈', trade: '교역', guard: '경비' };

export interface PmcHudOpts { onOpenBattle: (eng: string) => void; onExit: () => void }

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
  private pointer = { x: 0, y: 0, down: -1, sx: 0, sy: 0, moved: false };
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
    on(cv, 'pointermove', (e: PointerEvent) => {
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
      if (e.code === 'Escape') { if (this.modal) this.closeModal(); else if (this.mode) this.setMode(null); else this.select(null); }
      if (e.code === 'Space' && this.c.sp) { e.preventDefault(); this.c.setSpeed(this.c.speed > 0 ? 0 : 1); }
      if (this.c.sp && /^Digit[1-4]$/.test(e.code)) this.c.setSpeed([1, 2, 4, 8][Number(e.code.slice(5)) - 1]);
      const keyOps: Record<string, string> = { KeyM: 'move', KeyD: 'dock', KeyN: 'mine', KeyP: 'patrol', KeyG: 'escort', KeyA: 'attack', KeyI: 'idle', KeyT: 'release' };
      if (keyOps[e.code] && this.group) this.opButton(keyOps[e.code]);
      if (e.code === 'KeyH' && this.group) this.focusSelected();
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
    const hasMiner = this.subtree(g).some(s => ECON[s.classId].mine > 0);
    const pirate = this.pirateGroupAt(p);
    if (pirate) return void this.setOp({ k: 'attack', group: pirate });
    if (p?.kind === 'field') {
      if (hasMiner) return void this.setOp({ k: 'mine', field: p.id, deliver: this.bestDeliver(p.id), sell: true });
      const f = this.st.fields[p.id];
      return void this.setOp({ k: 'patrol', at: f.pos, radius: f.radius + 400 });
    }
    if (p?.kind === 'station') {
      const s = this.st.stations[p.id];
      if (s.owner === this.me && this.subtree(g).some(x => x.classId === 'constructor') && s.modules.some(m => !m.built)) return void this.setOp({ k: 'build', station: s.id });
      return void this.setOp({ k: 'dock', station: p.id });
    }
    if (p?.kind === 'lair') return void this.setOp({ k: 'attack', lair: p.id });
    if (p?.kind === 'ship') { const s = this.st.ships[p.id]; if (s.owner === this.me && s.groupId !== g.id) return void this.setOp({ k: 'escort', group: s.groupId }); }
    const c = this.center(g);
    const pt = this.v.screenToPlane(x, y, c?.y ?? 0);
    if (pt) this.setOp({ k: 'move', to: { x: pt.x, y: c?.y ?? 0, z: pt.z } });
  }

  private bestDeliver(fieldId: string): string {
    const f = this.st.fields[fieldId];
    let best = 'astra', bd = Infinity;
    for (const s of Object.values(this.st.stations)) {
      if (!(s.public && s.market) && !(s.owner === this.me && s.modules.some(m => m.kind === 'core' && m.built))) continue;
      const d = Math.hypot(s.pos.x - f.pos.x, s.pos.z - f.pos.z) * (s.owner === this.me ? 0.7 : 1);
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  }

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
      case 'mine': if (p?.kind === 'field') this.setOp({ k: 'mine', field: p.id, deliver: this.bestDeliver(p.id), sell: true }); else this.hint('소행성 지대를 클릭하세요'); return;
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

  private openHaulRes(from: string, to: string) {
    const res = (prompt('운송할 자원 (광석 / 합금 / 크리스탈)', '합금') ?? '').trim();
    const map: Record<string, Res> = { 광석: 'ore', 합금: 'alloy', 크리스탈: 'crystal', ore: 'ore', alloy: 'alloy', crystal: 'crystal' };
    if (map[res]) this.setOp({ k: 'haul', from, to, res: map[res] });
    this.setMode(null);
  }

  private hint(t: string) { const e = document.getElementById('modeHint')!; e.textContent = t; e.classList.remove('hidden'); }
  private setMode(m: Mode) {
    this.mode = m;
    const e = document.getElementById('modeHint')!;
    const txt: Record<string, string> = {
      move: '이동 지점 클릭', dock: '정박할 정거장 클릭', mine: '채굴할 소행성 지대 클릭 (하역지는 가장 가까운 정거장)', haul_from: '운송 출발 정거장 클릭',
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
      if (e.kind === 'radio' || e.kind === 'warn') sfx.play('radio', null, e.kind === 'warn' ? 0.45 : 0.18);
      if (e.kind === 'money' && /\+/.test(e.text)) sfx.play('confirm', null, 0.15);
    }
  }

  private addLog(e: WorldEvent, live: boolean) {
    const body = (this.parked?.querySelector('#logBody') as HTMLElement | null) ?? document.getElementById('logBody'); if (!body) return;
    const icon: Record<string, string> = { radio: '◉', info: 'ℹ', warn: '⚠', battle: '⚔', money: '¤', world: '◈', milestone: '★' };
    const el = h('div', `ev ev-${e.kind}`);
    el.innerHTML = `<span class="t">${fmtT(e.t)}</span><span class="ic">${icon[e.kind]}</span><div>${e.who ? `<div class="who" style="color:${e.color ?? 'var(--dim)'}">${esc(e.who)}</div>` : ''}<div class="tx">${esc(e.text)}</div></div>`;
    if (e.pos) el.onclick = () => { this.v.focusOn(e.pos!, Math.min(this.v.rig.dist, 3000)); if (e.kind === 'battle' && e.ref && this.st.engagements[e.ref] && !this.st.engagements[e.ref].done) this.opts.onOpenBattle(e.ref); else if (e.ref && this.st.groups[e.ref]?.owner === this.me) this.select({ kind: 'group', id: e.ref }); };
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
    if (this.refreshT <= 0) { this.refreshT = 0.4; this.refresh(false); }
    this.drawOverlay();
    this.tooltip();
  }

  refresh(force: boolean) {
    if (!this.c.state) return;
    this.renderTop();
    this.renderOrg();
    this.renderSel(force);
    this.renderGoals();
    if (this.modal && this.modalStation) this.renderModal(force);
  }

  private renderTop() {
    const co = this.st.companies[this.me];
    if (!co) return;
    const stores = Object.values(this.st.stations).reduce((a, s) => { const x = s.storage[this.me]; if (x) for (const r of RES) a[r] += x[r]; return a; }, { ore: 0, alloy: 0, crystal: 0 } as Record<Res, number>);
    const ships = Object.values(this.st.ships).filter(s => s.owner === this.me);
    const players = this.c.players.filter(p => p.id !== this.me);
    const el = document.getElementById('ptop')!;
    const spd = this.c.speed;
    el.innerHTML = `
      <div class="co"><span class="dot" style="background:${co.color}"></span><b>${esc(co.name)}</b><small>민간군사기업</small></div>
      <div class="kv"><span>자금</span><b class="money">${fmt(co.credits)} <small>cr</small></b></div>
      <div class="kv"><span>함선</span><b>${ships.length}</b></div>
      <div class="kv"><span>연합 평판</span><b>${co.rep}</b></div>
      ${RES.map(r => `<div class="kv"><span style="color:${RES_COLOR[r]}">${RES_NAME[r]}</span><b>${fmt(stores[r])}</b></div>`).join('')}
      <div class="kv"><span>성계 시각</span><b>${fmtT(this.st.time)}</b></div>
      ${this.c.sp ? `<div class="speedgrp">${[[0, '❚❚'], [1, '1×'], [2, '2×'], [4, '4×'], [8, '8×']].map(([v, l]) => `<button class="btn${spd === v ? ' on' : ''}" data-spd="${v}">${l}</button>`).join('')}</div>`
        : `<div class="kv"><span>접속 중</span><b>${this.c.players.filter(p => p.online).length}명</b></div>${players.map(p => `<span class="dot" title="${esc(p.name)}${p.online ? '' : ' (오프라인)'}" style="background:${p.color};opacity:${p.online ? 1 : 0.3}"></span>`).join('')}`}
      <button class="btn" id="menuBtn" title="메인 메뉴 (자동 저장됨)">☰</button>`;
    el.querySelectorAll<HTMLButtonElement>('[data-spd]').forEach(b => b.onclick = () => this.c.setSpeed(Number(b.dataset.spd)));
    (document.getElementById('menuBtn') as HTMLButtonElement).onclick = () => this.opts.onExit();
  }

  private orgKey = '';
  private renderOrg() {
    const groups = this.myGroups();
    const key = JSON.stringify(groups.map(g => [g.id, g.name, g.parentId, g.shipIds, g.status, g.commanderId, g.op.k, g.override, g.fleeing])) + [...this.expanded].join() + this.group + JSON.stringify(Object.values(this.st.ships).filter(s => s.owner === this.me).map(s => [Math.round(s.hp * 50), s.state, Math.round(cargoSum(s.cargo) / 10)]));
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
      row.innerHTML = `<span class="tog">${ships.length || g.childIds.length ? (open ? '▾' : '▸') : ''}</span>
        <span class="nm">${esc(g.name)}<span class="cmd">${cm ? esc(cm.name) + (cm.injuredUntil > this.st.time ? ' (부상)' : '') : ''}</span><br><span class="stt${g.fleeing ? ' warn' : ''}">${esc(g.status)}</span></span>
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
        const cap = ECON[s.classId].cargo;
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
    const selKey = JSON.stringify([s, this.group, this.mode, g?.op, g?.status, g?.commanderId, g?.parentId, g?.override, s?.kind === 'ship' ? this.st.ships[s.id] && [Math.round(this.st.ships[s.id].hp * 100), this.st.ships[s.id].state, Math.round(cargoSum(this.st.ships[s.id].cargo))] : 0, s?.kind === 'field' ? Math.round((this.st.fields[s.id]?.amount ?? 0) / 20) : 0, Math.round(this.st.companies[this.me]?.credits / 100)]);
    if (!force && selKey === this.lastSelKey) return;
    this.lastSelKey = selKey;
    if (!s && !g) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    let html = '';
    if (s && s.kind !== 'group' && !(s.kind === 'ship' && this.st.ships[s.id]?.owner === this.me)) html += this.infoHtml(s);
    if (g && g.owner === this.me) html += this.groupHtml(g);
    el.innerHTML = html;
    el.querySelectorAll<HTMLButtonElement>('[data-op]').forEach(b => b.onclick = () => this.opButton(b.dataset.op!));
    el.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(b => b.onclick = () => this.openStation(b.dataset.open!));
    el.querySelectorAll<HTMLButtonElement>('[data-battle]').forEach(b => b.onclick = () => this.opts.onOpenBattle(b.dataset.battle!));
    el.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach(b => b.onclick = () => this.setOp(JSON.parse(b.dataset.quick!)));
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
        ${x.public ? `<div class="svc">${x.market ? '시장 ' : ''}${x.services.repair ? '· 수리 ' : ''}${x.services.shipyard.length ? '· 조선소 ' : ''}${x.services.recruit ? '· 인재 ' : ''}${x.services.contracts ? '· 계약' : ''}</div>` : `<div class="svc">모듈 ${x.modules.filter(m => m.built).length}/${x.modules.length} 완공</div>`}
        ${store && (store.ore + store.alloy + store.crystal) > 0 ? `<div class="svc">자사 창고: ${RES.map(r => `${RES_NAME[r]} ${fmt(store[r])}`).join(' · ')}</div>` : ''}
        <button class="btn go" data-open="${x.id}">${own ? '정거장 관리' : '정거장 서비스'}</button></div>`;
    }
    if (s.kind === 'field') {
      const f = st.fields[s.id]; if (!f) return '';
      return `<div class="info"><div class="ih"><b>${esc(f.name)}</b> <span style="color:${RES_COLOR[f.res]}">${RES_NAME[f.res]}</span>${f.salvage ? ' <span class="tag">전투 잔해</span>' : ''}</div>
        <div class="bar2"><i style="width:${f.amount / f.max * 100}%;background:${RES_COLOR[f.res]}"></i></div>
        <div class="dim">매장량 ${fmt(f.amount)} / ${fmt(f.max)}${f.regen ? ` · 재생 ${f.regen}/s` : ` · ${Math.max(0, Math.round((f.expires - st.time) / 60))}분 후 소멸`} · 위험도 ${'▲'.repeat(f.danger)}</div>
        ${this.group ? `<button class="btn" data-quick='${JSON.stringify({ k: 'mine', field: f.id, deliver: this.bestDeliver(f.id), sell: true })}'>선택 편대 채굴 지시 (판매)</button><button class="btn" data-quick='${JSON.stringify({ k: 'mine', field: f.id, deliver: this.bestDeliver(f.id), sell: false })}'>채굴 후 창고 보관</button><button class="btn" data-quick='${JSON.stringify({ k: 'patrol', at: f.pos, radius: f.radius + 400 })}'>이 지역 순찰</button>` : '<div class="dim">편대를 선택하고 우클릭하면 채굴을 지시합니다.</div>'}</div>`;
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
    if (s.kind === 'battle') {
      const e = st.engagements[s.id]; if (!e) return '';
      return `<div class="info"><div class="ih"><b style="color:#ff9a7a">⚔ 교전 중</b></div><div class="dim">${e.sides.map(side => side.map(cid => esc(st.companies[cid]?.name ?? cid)).join(', ')).join(' vs ')}</div>
        <button class="btn go" data-battle="${e.id}">${e.sides[0].includes(this.me) ? '전투 지휘' : '전투 관전'}</button></div>`;
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
    const hasMiner = sub.some(s => ECON[s.classId].mine > 0), hasCargo = sub.some(s => ECON[s.classId].cargo > 0), hasCon = sub.some(s => s.classId === 'constructor'), hasMil = sub.some(s => ECON[s.classId].military);
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
        <div class="dim small">우클릭: 소행성 지대=채굴 · 정거장=정박 · 해적=공격 · 자사 함선=호위 · 빈 곳=이동. 지휘관의 판단력이 높을수록 해적을 일찍 감지하고 효율적으로 일한다.</div>
        ${selShip && selShip.owner === this.me ? this.shipDetail(selShip) : ''}
      </div></div>`;
  }

  private shipDetail(s: WShip): string {
    const groups = this.myGroups();
    const cap = ECON[s.classId].cargo;
    const docked = s.task.k === 'docked' ? this.st.stations[(s.task as any).station] : null;
    return `<div class="shipd"><b>${esc(s.name)}</b> <span class="dim">${SHIP_CLASSES[s.classId].name} ${SHIP_CLASSES[s.classId].type} · ${esc(getLoadout(s.classId, s.loadoutId).name)}</span>
      · 선체 <b style="color:${hpCol(s.hp)}">${Math.round(s.hp * 100)}%</b>${cap ? ` · 화물 ${RES.filter(r => s.cargo[r] > 0.5).map(r => `${RES_NAME[r]} ${Math.round(s.cargo[r])}`).join(', ') || '비어 있음'} / ${cap}` : ''}
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
    if (own && own.modules.some(m => !m.built) && !groups.some(g => g.op.k === 'build')) return `공작선 편대에 <b>건설</b> 명령을 내려 ${esc(own.name)} 공사를 진행하세요. 합금이 부족하면 시장에서 사서 <b>운송</b>하세요.`;
    if (own && own.modules.length === 1 && own.modules[0].built) return `${esc(own.name)}에 <b>정제소</b>를 지으면 광석을 합금으로 바꿔 건설·조선에 쓸 수 있습니다.`;
    if (co.rep >= 10 && !ships.some(x => x.classId === 'cruiser')) return '평판이 올랐습니다. 헬리오스 조선소에서 <b>순양함</b>을 살 수 있습니다.';
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
  private renderModal(force: boolean) {
    const s = this.st.stations[this.modalStation!];
    if (!s || !this.modal) return;
    const co = this.st.companies[this.me];
    const key = JSON.stringify([this.modalTab, Math.round(co.credits), s.storage[this.me], s.market, s.modules, Object.values(this.st.ships).filter(x => x.owner === this.me && x.task.k === 'docked' && (x.task as any).station === s.id).map(x => [x.id, x.hp, x.loadoutId]), Object.values(this.st.contracts).filter(k => k.stationId === s.id).map(k => [k.id, k.takenBy, k.done]), Object.values(this.st.commanders).filter(c => c.stationId === s.id && !c.owner).length]);
    if (!force && key === this.modalKey) return;
    this.modalKey = key;
    const own = s.owner === this.me;
    const tabs: [string, string, boolean][] = [
      ['market', '시장', !!s.market], ['yard', '조선소', s.services.shipyard.length > 0 || (own && s.modules.some(m => m.kind === 'shipyard' && m.built))],
      ['dock', '수리·개조', true], ['recruit', '인재', s.services.recruit], ['contracts', '계약', s.services.contracts || Object.values(this.st.contracts).some(k => k.stationId === s.id)],
      ['build', '건설·창고', own],
    ];
    const vis = tabs.filter(t => t[2]);
    if (!vis.some(t => t[0] === this.modalTab)) this.modalTab = vis[0][0];
    let body = '';
    switch (this.modalTab) {
      case 'market': body = this.marketHtml(s); break;
      case 'yard': body = this.yardHtml(s); break;
      case 'dock': body = this.dockHtml(s); break;
      case 'recruit': body = this.recruitHtml(s); break;
      case 'contracts': body = this.contractsHtml(s); break;
      case 'build': body = this.buildHtml(s); break;
    }
    this.modal.innerHTML = `<div class="panel sbox"><div class="shdr"><div><div class="stitle">${esc(s.name)}</div><div class="dim">${esc(s.desc)}</div></div><div class="money">${fmt(co.credits)} cr</div><button class="btn" data-close>✕</button></div>
      <div class="tabs">${vis.map(([k, l]) => `<button class="btn${k === this.modalTab ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div class="sbody2">${body}</div></div>`;
    const m = this.modal;
    m.querySelector<HTMLButtonElement>('[data-close]')!.onclick = () => this.closeModal();
    m.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = () => { this.modalTab = b.dataset.tab!; this.renderModal(true); });
    m.querySelectorAll<HTMLButtonElement>('[data-trade]').forEach(b => b.onclick = () => { const [kind, res, amt] = b.dataset.trade!.split(':'); this.cmd({ c: kind as 'sell' | 'buy', station: s.id, res: res as Res, amount: Number(amt) }); });
    m.querySelectorAll<HTMLButtonElement>('[data-buyship]').forEach(b => b.onclick = () => {
      const cls = b.dataset.buyship!;
      const lo = (m.querySelector(`[data-lo="${cls}"]`) as HTMLSelectElement)?.value ?? SHIP_CLASSES[cls].loadouts[0].id;
      const grp = (m.querySelector(`[data-grp="${cls}"]`) as HTMLSelectElement)?.value || undefined;
      this.cmd({ c: 'buyShip', station: s.id, classId: cls, loadoutId: lo, group: grp });
    });
    m.querySelectorAll<HTMLButtonElement>('[data-repair]').forEach(b => b.onclick = () => this.cmd({ c: 'repair', ship: b.dataset.repair! }));
    m.querySelectorAll<HTMLSelectElement>('[data-refit]').forEach(sel => sel.onchange = () => { if (sel.value) this.cmd({ c: 'refit', ship: sel.dataset.refit!, loadoutId: sel.value }); });
    m.querySelectorAll<HTMLButtonElement>('[data-hire]').forEach(b => b.onclick = () => this.cmd({ c: 'hire', commander: b.dataset.hire! }));
    m.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach(b => b.onclick = () => this.cmd({ c: 'accept', contract: b.dataset.accept! }));
    m.querySelectorAll<HTMLButtonElement>('[data-module]').forEach(b => b.onclick = () => this.cmd({ c: 'queueModule', station: s.id, kind: b.dataset.module! }));
  }

  private marketHtml(s: Station): string {
    const store = s.storage[this.me] ?? { ore: 0, alloy: 0, crystal: 0 };
    const price = (r: Res, side: 'sell' | 'buy') => { const m = s.market![r]; const p = m.base * Math.max(0.45, Math.min(1.7, 1.45 - 0.55 * m.stock / m.target)); return side === 'sell' ? p : p * 1.18; };
    return `<table class="gt"><tr><th>자원</th><th>시장 재고</th><th>자사 창고</th><th>매입가 (팔 때)</th><th>판매가 (살 때)</th><th></th></tr>
      ${RES.filter(r => s.market![r]).map(r => {
        const m = s.market![r];
        const trend = m.stock < m.target * 0.6 ? '<span style="color:var(--good)">▲ 품귀</span>' : m.stock > m.target * 1.4 ? '<span style="color:var(--enemy)">▼ 과잉</span>' : '';
        return `<tr><td style="color:${RES_COLOR[r]}"><b>${RES_NAME[r]}</b></td><td class="n">${fmt(m.stock)} ${trend}</td><td class="n">${fmt(store[r])}</td><td class="n">${price(r, 'sell').toFixed(1)}</td><td class="n">${price(r, 'buy').toFixed(1)}</td>
          <td><button class="btn mini" data-trade="sell:${r}:100" ${store[r] < 1 ? 'disabled' : ''}>100 판매</button><button class="btn mini" data-trade="sell:${r}:${Math.floor(store[r])}" ${store[r] < 1 ? 'disabled' : ''}>전량 판매</button><button class="btn mini" data-trade="buy:${r}:100">100 구매</button></td></tr>`;
      }).join('')}</table>
      <div class="dim small">채굴 편대에 "판매" 하역지를 지정하면 자동으로 이곳에 팔립니다. 많이 팔수록 가격이 떨어지고, 시간이 지나면 회복됩니다. 구매한 자원은 이 정거장 창고에 보관되며, 운송 명령으로 옮길 수 있습니다.</div>`;
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
      const canAlloy = !own || (store?.alloy ?? 0) >= e.alloy;
      return `<div class="ycard${locked ? ' locked' : ''}"><div class="yn"><b>${c.name} ${c.type}</b><span class="money">${fmt(price)} cr${own ? ` + 합금 ${e.alloy}` : ''}</span></div>
        <div class="dim">${esc(c.desc)}</div>
        <div class="ys">내구 ${c.hp} · 순항 ${e.cruise} ${e.cargo ? `· 화물 ${e.cargo}` : ''}${e.mine ? ` · 채굴 ${e.mine}/s` : ''}</div>
        ${locked ? `<div class="warn">연합 평판 ${e.rep} 필요 (현재 ${co.rep}) — 해적 토벌과 계약으로 평판을 올리세요</div>` : `
        <div class="yrow"><select data-lo="${id}">${c.loadouts.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
        <select data-grp="${id}"><option value="">새 편대</option>${groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
        <button class="btn go" data-buyship="${id}" ${co.credits < price || !canAlloy ? 'disabled' : ''}>구매</button></div>`}</div>`;
    }).join('')}</div>`;
  }

  private dockHtml(s: Station): string {
    const ships = Object.values(this.st.ships).filter(x => x.owner === this.me && x.task.k === 'docked' && (x.task as any).station === s.id);
    const own = s.owner === this.me;
    const canRepair = s.services.repair || (own && s.modules.some(m => m.kind === 'repair' && m.built));
    const canRefit = s.services.refit || (own && s.modules.some(m => m.kind === 'shipyard' && m.built));
    if (!ships.length) return `<div class="dim">이 정거장에 정박한 자사 함선이 없습니다. 편대를 선택하고 정거장을 우클릭하면 정박합니다.</div>`;
    return `<table class="gt"><tr><th>함선</th><th>선체</th><th>무장</th><th></th></tr>${ships.map(x => {
      const c = SHIP_CLASSES[x.classId];
      const cost = Math.round((1 - x.hp) * ECON[x.classId].price * 0.3);
      return `<tr><td><b>${esc(x.name)}</b> <span class="dim">${c.type}</span></td><td><span style="color:${hpCol(x.hp)}">${Math.round(x.hp * 100)}%</span></td>
        <td>${canRefit && c.loadouts.length > 1 ? `<select data-refit="${x.id}"><option value="">${esc(getLoadout(x.classId, x.loadoutId).name)} (개조 ${fmt(ECON[x.classId].price * 0.15)} cr)</option>${c.loadouts.filter(l => l.id !== x.loadoutId).map(l => `<option value="${l.id}">→ ${esc(l.name)}</option>`).join('')}</select>` : esc(getLoadout(x.classId, x.loadoutId).name)}</td>
        <td>${x.hp < 0.999 && canRepair ? `<button class="btn" data-repair="${x.id}">수리 ${fmt(cost)} cr</button>` : ''}</td></tr>`;
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

  private buildHtml(s: Station): string {
    const store = s.storage[this.me] ?? { ore: 0, alloy: 0, crystal: 0 };
    const co = this.st.companies[this.me];
    const builtKinds = new Set(s.modules.map(m => m.kind));
    const hasCon = Object.values(this.st.ships).some(x => x.owner === this.me && x.classId === 'constructor');
    return `<div class="svc">창고: ${RES.map(r => `<span style="color:${RES_COLOR[r]}">${RES_NAME[r]}</span> ${fmt(store[r])}`).join(' · ')}</div>
      <table class="gt"><tr><th>모듈</th><th>상태</th></tr>${s.modules.map(m => `<tr><td><b>${MODULES[m.kind].name}</b></td><td>${m.built ? '<span class="good">가동 중</span>' : `건설 ${Math.round(m.progress * 100)}%`}</td></tr>`).join('')}</table>
      <h3>새 모듈 (${s.modules.length}/${MAX_MODULES})</h3>
      <div class="yard">${Object.values(MODULES).filter(md => md.kind !== 'core' && (!builtKinds.has(md.kind) || md.kind === 'defense' || md.kind === 'depot')).map(md => {
        const req = !md.requires || s.modules.some(m => m.kind === md.requires);
        return `<div class="ycard${req ? '' : ' locked'}"><div class="yn"><b>${md.name}</b><span class="money">${fmt(md.credits)} cr</span></div><div class="dim">${esc(md.desc)}</div>
          <div class="ys">자재: 합금 ${md.alloy}${md.crystal ? ` · 크리스탈 ${md.crystal}` : ''} (건설 중 창고에서 소모) · 작업 ${md.work}초</div>
          <button class="btn go" data-module="${md.kind}" ${co.credits < md.credits || !req || s.modules.length >= MAX_MODULES ? 'disabled' : ''}>건설 예약</button></div>`;
      }).join('')}</div>
      <div class="dim small">건설에는 공작선이 필요합니다${hasCon ? '' : ' (현재 보유하지 않음 — 아스트라 자유항 조선소에서 구매)'}. 공작선 편대에 "건설" 명령을 내리세요. 합금은 시장에서 구매 후 "운송" 명령으로 옮기거나, 정제소 모듈로 광석에서 생산합니다.</div>`;
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
      const mil = ECON[s.classId].military;
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
    if (!pk) { tip.classList.add('hidden'); return; }
    const st = this.st;
    let html = '';
    if (pk.kind === 'ship') { const s = st.ships[pk.id]; const co = st.companies[s.owner]; html = `<b style="color:${co?.color}">${esc(s.name)}</b> <span class="dim">${SHIP_CLASSES[s.classId].type} · ${esc(co?.name ?? '')}</span><br>선체 ${Math.round(s.hp * 100)}% · ${esc(st.groups[s.groupId]?.status ?? '')}`; }
    else if (pk.kind === 'station') { const s = st.stations[pk.id]; html = `<b>${esc(s.name)}</b><br><span class="dim">클릭: 정보 · 우클릭: 정박</span>`; }
    else if (pk.kind === 'field') { const f = st.fields[pk.id]; html = `<b>${esc(f.name)}</b> ${RES_NAME[f.res]} ${fmt(f.amount)}<br><span class="dim">우클릭: 선택 편대 채굴</span>`; }
    else if (pk.kind === 'lair') html = `<b>☠ ${esc(st.lairs[pk.id].name)}</b>`;
    else if (pk.kind === 'battle') html = '<b>⚔ 교전 중</b><br><span class="dim">클릭하여 전투 화면</span>';
    tip.innerHTML = html;
    tip.style.left = `${this.pointer.x + 14}px`; tip.style.top = `${this.pointer.y + 12}px`;
    tip.classList.remove('hidden');
  }
}
