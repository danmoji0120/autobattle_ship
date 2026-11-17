import * as THREE from 'three';
import type { BattleSession } from '../game/session';
import type { Group, Ship, Order, SimEvent, RadioMsg, Team } from '../sim/types';
import { SPECIALTY_TEXT } from '../sim/data/commanders';
import { orderKey } from '../sim/ai/commander';
import { Perspective, REL_TEXT } from './perspective';
import { SHAKE_LEVELS, saveShakeLevel, type ShakeLevel } from '../render/camera';

type TargetMode = null | 'attack' | 'escort' | 'move' | 'flank_l' | 'flank_r';

const ORDER_TEXT: Record<string, string> = {
  engage: '자유 교전', attack: '공격', flank: '측면 우회', escort: '호위', move: '이동', hold: '사수', reserve: '예비대', retreat: '후퇴',
};
const ORDER_COLOR: Record<string, string> = {
  engage: '#9fc8e8', attack: '#ff6a55', flank: '#ffb347', escort: '#7dffb0', move: '#6ab8ff', hold: '#6ab8ff', reserve: '#8aa0b0', retreat: '#aaaaaa',
};

const h = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const r0 = (e: HTMLElement) => e;
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export interface HudOptions {
  replay: boolean;
  /** Local experiments may inspect either side; commanding still follows mayCommand(). */
  inspectAll?: boolean;
  /** spectating a battle you have no part in: side names replace "ally/enemy" */
  spectate?: { sides: string[] };
  /** P11: the viewer's side (null = spectator; default 0, or null when spectating) and the side names */
  me?: number | null;
  names?: string[];
  /** persistent world: which tactical groups this player may command */
  canCommand?: (g: Group) => boolean;
  /** persistent world: results screen returns to the strategic map */
  campaign?: { onReturn: () => void };
  /** where to attach the overlay canvas (defaults to document.body) */
  overlayParent?: HTMLElement;
  /** world speed control (single-player campaign) or none (multiplayer) */
  onSpeed?: ((v: number) => void) | 'none';
  onExit: () => void;
  onRestart: () => void;
  onReplay: () => void;
}

export class BattleHUD {
  private s: BattleSession;
  private root: HTMLElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private els: Record<string, HTMLElement> = {};
  selected: number | null = null;
  private hoverShip: Ship | null = null;
  private expanded = new Set<number>();
  private showShips = new Set<number>();
  private mode: TargetMode = null;
  private refreshT = 0;
  private radioEnemy = true;
  private resultShown = false;
  private resultTimer: ReturnType<typeof setTimeout> | null = null;
  private pointer = { x: 0, y: 0, down: -1, sx: 0, sy: 0, moved: false };
  private keys = new Set<string>();
  private opts: HudOptions;
  private disposers: (() => void)[] = [];
  private strengthLag = [1, 1];
  private p = new THREE.Vector3();
  private lastSel: number | null = -1;
  /** whose point of view: own / allied / neutral / hostile sides (or a spectator's neutral view) */
  readonly P: Perspective;
  private seenRoots = new Set<number>();

  constructor(root: HTMLElement, session: BattleSession, opts: HudOptions) {
    this.s = session; this.root = root; this.opts = opts;
    this.P = new Perspective(session.world, opts.me !== undefined ? opts.me : opts.spectate ? null : 0, opts.names ?? opts.spectate?.sides ?? []);
    this.overlay = document.createElement('canvas');
    this.overlay.id = 'overlay';
    (opts.overlayParent ?? document.body).appendChild(this.overlay);
    this.ctx = this.overlay.getContext('2d')!;
    this.build();
    if (opts.onSpeed === 'none') document.getElementById('speed')?.classList.add('hidden');
    const w = session.world;
    // expand every side's root by default so the main groups are visible
    for (const sd of w.sides) for (const r of sd.roots) { this.expanded.add(r); this.seenRoots.add(r); }
    this.selected = w.roots[this.P.me ?? 0] ?? w.roots[0];
    if (opts.canCommand) { const mine = w.groups.find(g => this.P.mine(g.team) && opts.canCommand!(g) && w.subtreeShips(g).length); this.selected = mine ? mine.id : this.selected; }
    this.bindInput();
    this.resize();
    session.onEvents = ev => this.onEvents(ev);
    session.onFrame = dt => this.frame(dt);
    this.refreshTree(); this.refreshCommand();
    const vs = w.sides.map((_, k) => this.P.name(k)).join(' vs ');
    if (opts.replay) this.banner('리플레이', opts.spectate || opts.names ? `${vs} — 서버 판정 그대로 재현합니다` : '기록된 명령으로 전투를 재현합니다', 'ally', 'REPLAY');
    else if (this.P.spectator) {
      this.banner('관전 중', `${vs} — 서버 전투를 실시간으로 재현합니다`, 'ally', 'LIVE');
      const tip = h('div', 'panel', `<b style="color:var(--cyan)">관전 모드</b> — 각 진영 지휘관이 스스로 싸웁니다. 어느 진영의 시점도 강제하지 않습니다.<br>
        <b>전술 지도</b> / <b>추적</b>(함선 더블클릭) / <b>시네마틱</b>(C) 시점 · 부대·함선을 클릭하면 상태를 볼 수 있습니다.<br>
        <span style="color:var(--dim)">관전을 끝내도 전투는 서버에서 계속됩니다 · 클릭하여 닫기</span>`);
      Object.assign(tip.style, { position: 'absolute', top: '118px', left: '50%', transform: 'translateX(-50%)', padding: '10px 16px', fontSize: '12.5px', lineHeight: '1.6', maxWidth: '560px', cursor: 'pointer', zIndex: '5' });
      tip.onclick = () => tip.remove();
      r0(this.root).appendChild(tip);
      setTimeout(() => tip.remove(), 12000);
    } else {
      const tip = h('div', 'panel', `<b style="color:var(--cyan)">지휘관들이 스스로 싸웁니다.</b> 지켜보다가 필요할 때 개입하세요.<br>
        부대 선택 → 아래 명령 버튼, 또는 <b>우클릭</b>(적=공격 · 아군=호위 · 빈곳=이동). ▸로 부대를 펼치면 하위 부대까지 지도에 표시됩니다.<br>
        <span style="color:var(--dim)">Tab: 시네마틱 감상 · Space: 일시정지(정지 중에도 명령 가능) · 클릭하여 닫기</span>`);
      Object.assign(tip.style, { position: 'absolute', top: '118px', left: '50%', transform: 'translateX(-50%)', padding: '10px 16px', fontSize: '12.5px', lineHeight: '1.6', maxWidth: '560px', cursor: 'pointer', zIndex: '5' });
      tip.onclick = () => tip.remove();
      r0(this.root).appendChild(tip);
      setTimeout(() => tip.remove(), 16000);
    }
  }

  dispose() {
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.disposers.forEach(d => d());
    this.overlay.remove();
    this.root.innerHTML = '';
  }

  // ------------------------------------------------------------------ build DOM

  private build() {
    const r = this.root;
    r.innerHTML = '';
    const top = h('div', 'panel', '');
    top.id = 'topbar';
    top.innerHTML = `
      <div class="strength"><div class="lbl"><span id="sal">${esc(this.leftLabel())} 전력</span><b id="sa">100%</b></div><div class="bar"><em id="sae"></em><i id="sab"></i></div></div>
      <div id="clock">0:00<small>교전 시간</small></div>
      <div class="strength"><div class="lbl"><b id="se">100%</b><span id="sel">${esc(this.rightLabel())} 전력</span></div><div class="bar enemy"><em id="see"></em><i id="seb"></i></div></div>
      <div class="speedgrp" id="speed">
        <button class="btn" data-sp="0" title="일시정지 (Space)">❚❚</button>
        <button class="btn" data-sp="0.5">½×</button>
        <button class="btn on" data-sp="1">1×</button>
        <button class="btn" data-sp="2">2×</button>
        <button class="btn" data-sp="4">4×</button>
      </div>`;
    r.appendChild(top);
    const cam = h('div', 'panel', `
      <button class="btn on" data-cam="tactical" title="전술 지도 (Tab)">전술 지도</button>
      <button class="btn" data-cam="follow" title="선택 함선 추적 (F)">추적</button>
      <button class="btn" data-cam="director" title="자동 시네마틱 (C)">시네마틱</button>
      <label class="shakesel" title="화면 흔들림 (전술 지도에서는 흔들리지 않음)">흔들림 <select id="shakeSel">${SHAKE_LEVELS.map(l => `<option value="${l.id}">${l.name}</option>`).join('')}</select></label>
      <button class="btn" id="helpBtn" title="조작법">?</button>
      <button class="btn" id="muteBtn" title="소리">♪</button>`);
    cam.id = 'camgrp';
    r.appendChild(cam);
    const help = h('div', 'panel', `<b>좌클릭</b> 선택 · <b>우클릭</b> 상황 명령<br><b>우드래그</b> 회전 · <b>좌드래그/방향키</b> 이동 · <b>휠</b> 줌<br><b>더블클릭</b> 추적 · <b>Space</b> 정지 · <b>1-4</b> 배속 · <b>Tab</b> 시점<br><b>Q/E/A/R/G/M/H/B/T</b> 명령 단축키`);
    help.id = 'helpKeys';
    r.appendChild(help);

    const tree = h('div', 'panel');
    tree.id = 'tree';
    tree.innerHTML = `<div class="ptitle"><span>지휘 계통</span><span id="treeInfo"></span></div><div id="treeBody"></div>`;
    r.appendChild(tree);

    const cmd = h('div', 'panel');
    cmd.id = 'command';
    r.appendChild(cmd);

    const radio = h('div', 'panel');
    radio.id = 'radio';
    radio.innerHTML = `<div class="ptitle"><span>통신</span><label style="font-size:10px;letter-spacing:0;color:var(--dim);cursor:pointer"><input type="checkbox" id="radioEnemy" checked style="vertical-align:middle"> 적 감청</label></div><div id="radioBody"></div>`;
    r.appendChild(radio);

    const ban = h('div'); ban.id = 'banner'; r.appendChild(ban);
    const sub = h('div'); sub.id = 'subtitle'; r.appendChild(sub);
    const tip = h('div', 'hidden'); tip.id = 'tooltip'; r.appendChild(tip);
    const mh = h('div', 'panel hidden'); mh.id = 'modeHint'; r.appendChild(mh);
    // pointer-events: banners/subtitles should not block
    ban.style.pointerEvents = 'none'; sub.style.pointerEvents = 'none'; tip.style.pointerEvents = 'none'; mh.style.pointerEvents = 'none';

    for (const id of ['sa', 'sab', 'sae', 'se', 'seb', 'see', 'clock', 'treeBody', 'treeInfo', 'radioBody', 'banner', 'subtitle', 'tooltip', 'modeHint']) this.els[id] = document.getElementById(id)!;
    this.els.command = cmd;

    top.querySelectorAll<HTMLButtonElement>('[data-sp]').forEach(b => b.onclick = () => this.setSpeed(Number(b.dataset.sp)));
    cam.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach(b => b.onclick = () => this.setCam(b.dataset.cam as any));
    const shakeSel = cam.querySelector<HTMLSelectElement>('#shakeSel')!;
    shakeSel.value = this.s.view.rig.shakeLevel;
    shakeSel.onchange = () => { const l = shakeSel.value as ShakeLevel; this.s.view.rig.setShakeLevel(l); saveShakeLevel(l); shakeSel.blur(); };
    (document.getElementById('helpBtn') as HTMLButtonElement).onclick = () => help.classList.toggle('show');
    (document.getElementById('muteBtn') as HTMLButtonElement).onclick = (e) => {
      const a = this.s.view.audio as any;
      if (a?.setMuted) { a.setMuted(!a.muted); (e.currentTarget as HTMLElement).classList.toggle('on', a.muted); }
    };
    (document.getElementById('radioEnemy') as HTMLInputElement).onchange = e => {
      this.radioEnemy = (e.target as HTMLInputElement).checked;
      this.els.radioBody.querySelectorAll('.msg.enemy').forEach(m => m.classList.toggle('hidden', !this.radioEnemy));
    };
  }

  private setSpeed(sp: number) {
    if (typeof this.opts.onSpeed === 'function') { this.opts.onSpeed(sp === 0 ? 0 : sp); }
    if (this.opts.onSpeed === 'none') return;
    if (sp === 0) this.s.paused = !this.s.paused;
    else { this.s.paused = false; this.s.timeScale = sp; }
    this.root.querySelectorAll<HTMLButtonElement>('[data-sp]').forEach(b => {
      const v = Number(b.dataset.sp);
      b.classList.toggle('on', v === 0 ? this.s.paused : !this.s.paused && v === this.s.timeScale);
    });
  }

  private setCam(m: 'tactical' | 'follow' | 'director') {
    const rig = this.s.view.rig;
    if (m === 'follow') {
      const ship = this.focusShip();
      if (!ship) return;
      rig.follow = () => this.s.view.followTarget(ship.id) ?? this.nextFollow();
      rig.yaw = Math.atan2(-ship.fwd.x, -ship.fwd.z) + 0.6;
      rig.pitch = 0.45;
    }
    if (m === 'tactical' && rig.mode !== 'tactical') {
      // centre tactical view on what we were looking at
      rig.focus.copy(rig.mode === 'follow' ? rig.focus : this.battleCentre());
      rig.dist = 2400; rig.pitch = 0.95;
    }
    rig.setMode(m);
    this.root.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach(b => b.classList.toggle('on', b.dataset.cam === m));
  }

  private nextFollow() {
    const g = this.selected !== null ? this.s.world.groupById.get(this.selected) : null;
    const ships = g ? this.s.world.subtreeShips(g) : [];
    if (ships.length) { const id = ships[0].id; this.s.view.rig.follow = () => this.s.view.followTarget(id) ?? this.nextFollow(); return this.s.view.followTarget(id); }
    return null;
  }

  private focusShip(): Ship | null {
    const w = this.s.world;
    if (this.hoverShip && this.hoverShip.state === 'alive') return this.hoverShip;
    const g = this.selected !== null ? w.groupById.get(this.selected) : null;
    if (!g) return w.ships.find(s => s.team === (this.P.me ?? 0) && s.state === 'alive') ?? null;
    const ships = w.subtreeShips(g);
    return ships.sort((a, b) => b.value - a.value)[0] ?? null;
  }

  private battleCentre(): THREE.Vector3 {
    const w = this.s.world;
    const c = w.centroid(w.ships.filter(s => s.state === 'alive'));
    return new THREE.Vector3(c.x, 0, c.z);
  }

  // ------------------------------------------------------------------ input

  private bindInput() {
    const cv = this.s.view.renderer.domElement;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: K, fn: (e: any) => void, o?: any) => { el.addEventListener(ev, fn, o); this.disposers.push(() => el.removeEventListener(ev, fn, o)); };
    on(cv, 'contextmenu', (e: Event) => e.preventDefault());
    on(cv, 'pointerdown', (e: PointerEvent) => {
      this.pointer.down = e.button; this.pointer.sx = e.clientX; this.pointer.sy = e.clientY; this.pointer.moved = false;
      cv.setPointerCapture(e.pointerId);
    });
    on(cv, 'pointermove', (e: PointerEvent) => {
      const dx = e.clientX - this.pointer.x, dy = e.clientY - this.pointer.y;
      this.pointer.x = e.clientX; this.pointer.y = e.clientY;
      if (this.pointer.down >= 0) {
        if (Math.hypot(e.clientX - this.pointer.sx, e.clientY - this.pointer.sy) > 5) this.pointer.moved = true;
        if (!this.pointer.moved) return;
        const rig = this.s.view.rig;
        if (this.pointer.down === 2 || (this.pointer.down === 0 && rig.mode !== 'tactical')) rig.orbit(dx, dy);
        else if (this.pointer.down === 0 || this.pointer.down === 1) { if (rig.mode === 'tactical') rig.pan(dx, dy); }
      }
    });
    on(cv, 'pointerup', (e: PointerEvent) => {
      const btn = this.pointer.down;
      this.pointer.down = -1;
      if (this.pointer.moved) return;
      if (btn === 0) this.leftClick(e.clientX, e.clientY, e.shiftKey);
      else if (btn === 2) this.rightClick(e.clientX, e.clientY, e.shiftKey);
    });
    on(cv, 'dblclick', (e: MouseEvent) => {
      const ship = this.s.view.pickShip(e.clientX, e.clientY, innerWidth, innerHeight);
      if (ship) { this.hoverShip = ship; this.setCam('follow'); }
    });
    on(cv, 'wheel', (e: WheelEvent) => { e.preventDefault(); this.s.view.rig.zoom(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    on(window, 'resize', () => this.resize());
    on(window, 'keydown', (e: KeyboardEvent) => {
      const tg = (e.target as HTMLElement)?.tagName; if (tg === 'INPUT' || tg === 'SELECT') return;
      this.keys.add(e.code);
      const k = e.code;
      if (k === 'Space') { e.preventDefault(); this.setSpeed(0); }
      else if (k === 'Digit1') this.setSpeed(0.5); else if (k === 'Digit2') this.setSpeed(1); else if (k === 'Digit3') this.setSpeed(2); else if (k === 'Digit4') this.setSpeed(4);
      else if (k === 'Tab') { e.preventDefault(); this.setCam(this.s.view.rig.mode === 'tactical' ? 'director' : 'tactical'); }
      else if (k === 'KeyF') this.setCam('follow');
      else if (k === 'KeyC') this.setCam('director');
      else if (k === 'Escape') { if (this.mode) this.setMode(null); else if (this.s.view.rig.mode !== 'tactical') this.setCam('tactical'); }
      else if (!this.opts.replay) {
        const map: Record<string, () => void> = {
          KeyE: () => this.orderBtn('engage'), KeyA: () => this.orderBtn('attack'), KeyQ: () => this.orderBtn('flank_l'), KeyR: () => this.orderBtn('flank_r'),
          KeyG: () => this.orderBtn('escort'), KeyM: () => this.orderBtn('move'), KeyH: () => this.orderBtn('hold'), KeyB: () => this.orderBtn('retreat'), KeyT: () => this.orderBtn('release'),
        };
        map[k]?.();
      }
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
  }

  private resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    this.overlay.width = innerWidth * dpr; this.overlay.height = innerHeight * dpr;
    this.overlay.style.width = innerWidth + 'px'; this.overlay.style.height = innerHeight + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.s.view.resize(innerWidth, innerHeight);
  }

  private pickUnit(x: number, y: number): { ship: Ship | null; group: Group | null } {
    const ship = this.s.view.pickShip(x, y, innerWidth, innerHeight, 22);
    if (ship) return { ship, group: this.s.world.groupById.get(ship.groupId)! };
    // group labels
    let best: Group | null = null, bd = 34;
    for (const u of this.unitsDrawn) { const d = Math.hypot(u.x - x, u.y - y); if (d < bd) { bd = d; best = u.g; } }
    return { ship: null, group: best };
  }

  private leftClick(x: number, y: number, shift: boolean) {
    const { ship, group } = this.pickUnit(x, y);
    if (this.mode) { this.applyTarget(x, y, ship, group, shift); return; }
    if (group && this.inspectable(group.team)) { this.select(group.id); if (ship) this.hoverShip = ship; }
    else if (ship) { this.hoverShip = ship; }
  }

  private rightClick(x: number, y: number, shift: boolean) {
    if (this.opts.replay) return;
    if (this.mode) { this.setMode(null); return; }
    const g = this.selGroup();
    if (!g || !this.mayCommand(g)) return;
    const { ship, group } = this.pickUnit(x, y);
    if (group && this.P.foe(group.team)) this.issue(g, { type: 'attack', targetGroup: group.id, targetShip: shift && ship ? ship.id : undefined });
    else if (group && this.P.friend(group.team) && group.id !== g.id) this.issue(g, { type: 'escort', guardGroup: group.id });
    else if (group && !this.P.friend(group.team)) { this.hint(`${this.P.label(group.team)} — 적대 관계가 아니면 공격할 수 없습니다`); return; }
    else {
      const c = this.s.world.groupCenter(g);
      const p = this.s.view.screenToPlane(x, y, innerWidth, innerHeight, c.y);
      if (p) this.issue(g, { type: 'move', point: { x: p.x, y: c.y, z: p.z } });
    }
  }

  private applyTarget(x: number, y: number, ship: Ship | null, group: Group | null, shift: boolean) {
    const g = this.selGroup();
    if (!g) { this.setMode(null); return; }
    const m = this.mode;
    if (m === 'attack') {
      if (group && this.P.foe(group.team)) this.issue(g, { type: 'attack', targetGroup: group.id, targetShip: shift && ship ? ship.id : undefined });
      else return this.hint(group && !this.P.friend(group.team) ? `${this.P.label(group.team)} — 중립 진영은 공격할 수 없습니다` : '적대 진영의 함선이나 부대를 클릭하세요');
    } else if (m === 'escort') {
      if (group && this.P.friend(group.team) && group.id !== g.id && !this.s.world.isAncestor(g, group)) this.issue(g, { type: 'escort', guardGroup: group.id });
      else return this.hint('호위할 아군·동맹 부대를 클릭하세요');
    } else if (m === 'move') {
      const c = this.s.world.groupCenter(g);
      const p = this.s.view.screenToPlane(x, y, innerWidth, innerHeight, c.y);
      if (p) this.issue(g, { type: 'move', point: { x: p.x, y: c.y, z: p.z } });
    } else if (m === 'flank_l' || m === 'flank_r') {
      const side = m === 'flank_l' ? 1 : -1;
      this.issue(g, { type: 'flank', side, targetGroup: group && this.P.foe(group.team) ? group.id : undefined });
    }
    this.setMode(null);
  }

  private hint(t: string) { const e = this.els.modeHint; e.textContent = t; e.classList.remove('hidden'); }

  private setMode(m: TargetMode) {
    this.mode = m;
    const e = this.els.modeHint;
    const txt: Record<string, string> = {
      attack: '공격 목표 선택 — 적 함선/부대 클릭 (Shift: 특정 함선 집중) · 우클릭/Esc 취소',
      escort: '호위 대상 선택 — 아군 부대 클릭', move: '이동 지점 선택 — 지도 클릭',
      flank_l: '좌측 우회 목표 — 적 부대 클릭 (빈 곳: 지휘관 판단)', flank_r: '우측 우회 목표 — 적 부대 클릭 (빈 곳: 지휘관 판단)',
    };
    if (m) { e.textContent = txt[m]; e.classList.remove('hidden'); this.s.view.renderer.domElement.style.cursor = 'crosshair'; }
    else { e.classList.add('hidden'); this.s.view.renderer.domElement.style.cursor = ''; }
    this.refreshCommand();
  }

  private mayCommand(g: Group): boolean { return this.P.mine(g.team) && !this.opts.replay && (!this.opts.canCommand || this.opts.canCommand(g)); }
  /** may this group's details be shown (selection)? own and allied sides; everything for spectators and labs */
  private inspectable(team: number) { return !!this.opts.inspectAll || this.P.spectator || this.P.friend(team); }
  private leftLabel() { return this.P.me === null ? this.P.name(0) : this.isClassic() ? '아군' : this.P.name(this.P.me); }
  private rightLabel() { return this.P.me === null ? (this.s.world.sides.length > 2 ? '그 외 진영' : this.P.name(1)) : this.isClassic() ? '적' : '적대 진영'; }
  /** the classic two-side battle seen from side 0 (single-player, legacy worlds): labels stay as they were */
  private isClassic() { return this.P.me === 0 && this.s.world.sides.length === 2 && !this.s.world.dynamic && !this.opts.names; }
  /** remaining strength of a set of sides, weighted by what they brought */
  private valueOf(ks: number[]) { const w = this.s.world; let v = 0, t = 0; for (const k of ks) { const iv = w.initialValue[k] ?? 0; v += w.teamValueFrac(k) * iv; t += iv; } return t > 0 ? v / t : 0; }

  private selGroup(): Group | null { return this.selected !== null ? this.s.world.groupById.get(this.selected) ?? null : null; }

  select(id: number) {
    this.selected = id;
    const g = this.selGroup();
    if (g) { let p = g.parentId; while (p !== null) { this.expanded.add(p); p = this.s.world.groupById.get(p)!.parentId; } }
    this.refreshTree(); this.refreshCommand();
  }

  private issue(g: Group, o: Order) {
    this.s.issueOrder(g.id, o);
    this.s.view.audio?.play('confirm', null, 0.6);
    setTimeout(() => { this.refreshTree(); this.refreshCommand(); }, 60);
  }

  private orderBtn(kind: string) {
    if (this.opts.replay) return;
    const g = this.selGroup();
    if (!g || !this.mayCommand(g)) return;
    this.s.view.audio?.play('click', null, 0.4);
    switch (kind) {
      case 'engage': this.issue(g, { type: 'engage' }); break;
      case 'hold': this.issue(g, { type: 'hold' }); break;
      case 'retreat': this.issue(g, { type: 'retreat' }); break;
      case 'release': if (g.playerOverride && g.parentId !== null && !g.ai.routed) { this.s.issueOrder(g.id, null, { release: true }); setTimeout(() => this.refreshCommand(), 60); } break;
      case 'attack': case 'escort': case 'move': case 'flank_l': case 'flank_r': this.setMode(this.mode === kind ? null : kind as TargetMode); break;
    }
  }

  // ------------------------------------------------------------------ events

  private onEvents(ev: SimEvent[]) {
    for (const e of ev) {
      if (e.t === 'radio') this.addRadio(e.msg);
      else if (e.t === 'highlight') {
        if (e.h.score >= 4) this.banner(e.h.title, e.h.text, this.P.spectator || this.P.friend(e.h.team) ? 'ally' : 'lose');
      } else if (e.t === 'end') this.resultTimer = setTimeout(() => this.showResult(), 3500);
    }
    const w = this.s.world;
    if (w.firstContact >= 0 && !(this as any)._contact) { (this as any)._contact = true; this.banner('교전 개시', '적 함대와 접촉했습니다', 'ally', 'ENGAGE'); }
  }

  private addRadio(m: RadioMsg) {
    const body = this.els.radioBody;
    const other = this.P.spectator ? m.team !== 0 : !this.P.friend(m.team);
    const el = h('div', `msg p${m.priority}${other ? ' enemy' : ''}`);
    if (other && !this.radioEnemy) el.classList.add('hidden');
    const tag = this.s.world.sides.length > 2 || this.s.world.dynamic ? `<span style="color:${this.P.color(m.team)};margin-left:6px;font-size:10.5px">${esc(this.P.label(m.team))}</span>` : '';
    el.innerHTML = `<div class="stripe" style="background:${m.color}"></div><div><div class="who"><span class="t">${fmtTime(m.time)}</span><span>${esc(m.who)}</span>${tag}</div><div class="tx">${esc(m.text)}</div></div>`;
    el.onclick = () => {
      const rig = this.s.view.rig;
      if (m.pos) { if (rig.mode !== 'tactical') this.setCam('tactical'); rig.focus.set(m.pos.x, 0, m.pos.z); rig.dist = Math.min(rig.dist, 1600); }
      if (this.inspectable(m.team)) this.select(m.groupId);
    };
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.appendChild(el);
    while (body.children.length > 120) body.firstChild!.remove();
    if (atBottom) body.scrollTop = body.scrollHeight;
    const ours = this.P.spectator ? m.team === 0 : this.P.mine(m.team);
    if (ours && (m.priority >= 2 || m.groupId === this.selected)) {
      const sub = this.els.subtitle;
      sub.innerHTML = '';
      const d = h('div', '', `<span class="w" style="color:${m.color}">${esc(m.who)}</span>${esc(m.text)}`);
      sub.appendChild(d);
    }
    if (ours) this.s.view.audio?.play('radio', null, m.priority >= 2 ? 0.5 : 0.25);
  }

  private banner(title: string, sub: string, kind: 'ally' | 'lose', k = '') {
    const b = this.els.banner;
    b.innerHTML = '';
    const d = h('div', `ban ${kind}`, `${k ? `<div class="k">${k}</div>` : ''}<div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div>`);
    b.appendChild(d);
  }

  // ------------------------------------------------------------------ per frame

  private unitsDrawn: { g: Group; x: number; y: number }[] = [];

  private frame(dt: number) {
    const w = this.s.world;
    // keyboard pan
    const rig = this.s.view.rig;
    if (rig.mode === 'tactical') {
      const sp = 700 * dt;
      if (this.keys.has('ArrowUp') || this.keys.has('KeyW')) rig.pan(0, sp);
      if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) rig.pan(0, -sp);
      if (this.keys.has('ArrowLeft')) rig.pan(sp, 0);
      if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) rig.pan(-sp, 0);
    }
    this.refreshT -= dt;
    if (this.refreshT <= 0) { this.refreshT = 0.3; this.refreshTree(); this.refreshCommand(true); this.refreshTop(); }
    this.drawOverlay();
    this.updateTooltip();
  }

  private refreshTop() {
    const w = this.s.world;
    const me = this.P.me;
    const left = me === null ? [0] : [me];
    const right = me === null ? w.sides.map((_, k) => k).filter(k => k !== 0) : w.sides.map((_, k) => k).filter(k => this.P.foe(k));
    const a = this.isClassic() ? w.teamValueFrac(0) : this.valueOf(left), e = this.isClassic() ? w.teamValueFrac(1) : right.length ? this.valueOf(right) : 0;
    this.els.sa.textContent = `${Math.round(a * 100)}%`; this.els.se.textContent = `${Math.round(e * 100)}%`;
    this.els.sab.style.width = `${a * 100}%`; this.els.seb.style.width = `${e * 100}%`;
    this.strengthLag[0] = Math.max(a, this.strengthLag[0] - 0.01); this.strengthLag[1] = Math.max(e, this.strengthLag[1] - 0.01);
    this.els.sae.style.width = `${this.strengthLag[0] * 100}%`; this.els.see.style.width = `${this.strengthLag[1] * 100}%`;
    this.els.clock.innerHTML = `${fmtTime(w.time)}<small>${this.s.paused ? '일시정지' : w.outcome ? '전투 종료' : '교전 시간'}</small>`;
    this.refreshSides();
  }

  /** P11: one row per side — name, relation to the viewer, strength, status (shown once there are more
   *  than two sides or anything dynamic happened) */
  private sidesKey = '';
  private refreshSides() {
    const w = this.s.world;
    let el = this.els.sides;
    if (!(w.sides.length > 2 || w.dynamic)) { el?.classList.add('hidden'); return; }
    if (!el) {
      el = this.els.sides = h('div', 'panel', '');
      el.id = 'sides';
      Object.assign(el.style, { position: 'absolute', top: '104px', left: '50%', transform: 'translateX(-50%)', padding: '6px 10px', fontSize: '11.5px', display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: 'min(760px, calc(100vw - 32px))', zIndex: '4' });
      this.root.appendChild(el);
    }
    el.classList.remove('hidden');
    const OUT: Record<string, string> = { victor: '승리', survived: '생존', withdrawn: '철수', routed: '패주', destroyed: '전멸' };
    const html = this.P.order().map(k => {
      const sd = w.sides[k];
      const kind = this.P.kind(k);
      return `<span style="white-space:nowrap${sd.out ? ';opacity:.45' : ''}"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${this.P.color(k)};margin-right:5px"></i><b style="color:${this.P.color(k)}">${esc(this.P.name(k))}</b>${kind ? ` <span style="color:var(--dim)">${REL_TEXT[kind]}</span>` : ''} <span style="font-family:var(--mono)">${sd.out ? OUT[sd.out] ?? sd.out : Math.round(w.teamValueFrac(k) * 100) + '%'}</span></span>`;
    }).join('');
    if (html !== this.sidesKey) { this.sidesKey = html; el.innerHTML = html; }
    const sal = document.getElementById('sal'), sel = document.getElementById('sel');
    if (sal) sal.textContent = `${this.leftLabel()} 전력`;
    if (sel) sel.textContent = `${this.rightLabel()} 전력`;
  }

  // ------------------------------------------------------------------ tree

  private refreshTree() {
    const w = this.s.world;
    const body = this.els.treeBody;
    const scroll = body.scrollTop;
    body.innerHTML = '';
    const addGroup = (g: Group, depth: number) => {
      const ships = w.subtreeShips(g);
      const all = w.subtreeShips(g, true);
      const alive = ships.length;
      const hpf = w.groupHpFrac(g);
      const hasKids = g.childIds.length > 0 || g.shipIds.length > 0;
      const open = this.expanded.has(g.id);
      const row = h('div', `node${this.selected === g.id ? ' sel' : ''}${alive === 0 ? ' dead' : ''}${(this.P.spectator ? g.team !== 0 : !this.P.friend(g.team)) ? ' enemyn' : ''}`);
      row.style.paddingLeft = `${6 + depth * 14}px`;
      if (depth === 0 && (w.sides.length > 2 || w.dynamic)) row.style.borderLeft = `3px solid ${this.P.color(g.team)}`;
      const o = g.order;
      const ot = ORDER_TEXT[o.type] + (o.type === 'flank' ? (o.side > 0 ? '(좌)' : '(우)') : '');
      const ordCls = o.type === 'retreat' ? 'ord rt' : g.playerOverride && g.parentId !== null && this.P.mine(g.team) ? 'ord ov' : 'ord';
      const phase = o.type === 'flank' && g.ai.phase !== 'none' ? ` · ${{ transit: '이동', staging: '대기', strike: '돌입', none: '' }[g.ai.phase]}` : '';
      row.innerHTML = `<span class="tog">${hasKids ? (open ? '▾' : '▸') : ''}</span>
        <span class="nm">${esc(g.name)}<span class="cmd">${g.hasCommander ? esc(g.commander.name) : ''}</span></span>
        <span class="meta">${alive}/${all.length}<span class="hp"><i style="width:${Math.round(hpf * 100)}%;background:${hpf > 0.6 ? 'var(--good)' : hpf > 0.3 ? 'var(--warn)' : 'var(--enemy)'}"></i></span>${this.P.mine(g.team) || this.P.spectator ? `<span class="${ordCls}" title="${g.playerOverride && g.parentId !== null ? '직접 지휘 중' : '상급 지휘관 재량'}">${ot}${phase}</span>` : ''}</span>`;
      row.querySelector('.tog')!.addEventListener('click', ev => { ev.stopPropagation(); if (open) this.expanded.delete(g.id); else this.expanded.add(g.id); this.refreshTree(); });
      row.onclick = () => {
        if (this.mode && this.mode !== 'escort' && this.P.foe(g.team)) { this.applyTarget(0, 0, null, g, false); return; }
        if (this.mode === 'escort' && this.P.friend(g.team)) { this.applyTarget(0, 0, null, g, false); return; }
        if (this.inspectable(g.team)) this.select(g.id);
        const c = w.groupCenter(g);
        if (alive) { const rig = this.s.view.rig; if (rig.mode === 'tactical') rig.focus.set(c.x, 0, c.z); }
      };
      row.ondblclick = () => { if (this.inspectable(g.team)) { this.select(g.id); this.setCam('follow'); } };
      body.appendChild(row);
      if (!open) return;
      for (const id of g.childIds) addGroup(w.groupById.get(id)!, depth + 1);
      if (g.shipIds.length) {
        for (const id of g.shipIds) {
          const s = w.shipById.get(id)!;
          const sr = h('div', `shiprow${s.state !== 'alive' ? ' dead' : ''}`);
          sr.style.paddingLeft = `${26 + depth * 14}px`;
          const f = Math.max(0, s.hp / s.maxHp);
          const st = s.state === 'escaped' ? ' (이탈)' : s.crit.fire > 0 ? ' 🔥' : '';
          sr.innerHTML = `<span>${esc(s.name)} <span style="opacity:.6">${s.cls.type}</span>${st}</span><span class="hp"><i style="width:${f * 100}%;background:${f > 0.6 ? 'var(--good)' : f > 0.3 ? 'var(--warn)' : 'var(--enemy)'}"></i></span>`;
          sr.onclick = () => { if (s.state !== 'alive') return; if (this.mode) { this.applyTarget(0, 0, s, w.groupById.get(s.groupId)!, true); return; } this.hoverShip = s; const rig = this.s.view.rig; if (rig.mode === 'tactical') rig.focus.set(s.pos.x, 0, s.pos.z); };
          sr.ondblclick = () => { if (s.state === 'alive') { this.hoverShip = s; this.setCam('follow'); } };
          body.appendChild(sr);
        }
      }
    };
    // reinforcements bring new roots: show them expanded like the starting fleets
    for (const sd of w.sides) for (const r of sd.roots) if (!this.seenRoots.has(r)) { this.seenRoots.add(r); this.expanded.add(r); }
    if (w.sides.length === 2 && !w.dynamic && !this.opts.names) {
      addGroup(w.groupById.get(w.roots[0])!, 0);
      body.appendChild(h('div', 'treesep', this.P.spectator ? this.P.name(1) : '적 함대 (탐지)'));
      addGroup(w.groupById.get(w.roots[1])!, 0);
    } else {
      for (const k of this.P.order()) {
        const kind = this.P.kind(k);
        const sep = h('div', 'treesep');
        sep.textContent = `${this.P.name(k)}${kind ? ' · ' + REL_TEXT[kind] : ''}${w.sides[k].out ? ' (이탈)' : ''}`;
        sep.style.color = this.P.color(k);
        body.appendChild(sep);
        for (const r of w.sides[k].roots) { const g = w.groupById.get(r); if (g) addGroup(g, 0); }
      }
    }
    body.scrollTop = scroll;
    this.els.treeInfo.textContent = `${w.ships.filter(s => s.team === (this.P.me ?? 0) && s.state === 'alive').length}척`;
  }

  // ------------------------------------------------------------------ command panel

  private cmdKey = '';
  private refreshCommand(soft = false) {
    const g = this.selGroup();
    const el = this.els.command;
    const w = this.s.world;
    if (!g) { el.innerHTML = ''; return; }
    const ships = w.subtreeShips(g);
    const key = `${g.id}:${orderKey(g.order)}:${g.playerOverride}:${this.mode}:${g.retreatAt}:${ships.length}:${g.ai.phase}`;
    if (soft && key === this.cmdKey) { this.updateStatusLine(g); return; }
    this.cmdKey = key;
    const c = g.commander;
    const initials = c.name.replace(/\s/g, '').slice(0, 2);
    const o = g.order;
    const isPlayer = this.mayCommand(g);
    const btn = (k: string, label: string, key: string, on: boolean, extra = '') => `<button class="btn${on ? ' on' : ''} ${extra}" data-o="${k}" ${isPlayer && ships.length ? '' : 'disabled'}>${label}<span class="key">${key}</span></button>`;
    const delegated = !g.playerOverride || g.parentId === null;
    el.innerHTML = `
      <div class="cmdcard">
        <div class="portrait" style="background:${c.color}">${esc(initials)}</div>
        <div class="cmdname">${esc(c.name)}</div>
        <div class="cmdrank">${esc(c.rank || '임시 지휘')} · ${esc(g.name)}</div>
        <div class="traits">
          <span>판단력</span><div class="bar"><i style="width:${c.skill * 100}%"></i></div>
          <span>공격성</span><div class="bar"><i style="width:${c.aggression * 100}%;background:var(--warn)"></i></div>
          <span>규율</span><div class="bar"><i style="width:${c.discipline * 100}%;background:var(--good)"></i></div>
        </div>
        <div class="cmdspec">${SPECIALTY_TEXT[c.specialty]}</div>
      </div>
      <div class="orders">
        <div class="gstatus" id="gstat"></div>
        <div class="row">
          ${btn('engage', '자유 교전', 'E', o.type === 'engage')}
          ${btn('attack', '공격', 'A', this.mode === 'attack' || o.type === 'attack')}
          ${btn('flank_l', '좌측 우회', 'Q', this.mode === 'flank_l' || (o.type === 'flank' && o.side > 0))}
          ${btn('flank_r', '우측 우회', 'R', this.mode === 'flank_r' || (o.type === 'flank' && o.side < 0))}
          ${btn('escort', '호위', 'G', this.mode === 'escort' || o.type === 'escort')}
        </div>
        <div class="row">
          ${btn('move', '이동', 'M', this.mode === 'move' || o.type === 'move')}
          ${btn('hold', '현위치 사수', 'H', o.type === 'hold')}
          ${btn('retreat', '후퇴', 'B', o.type === 'retreat', 'danger')}
          ${g.parentId !== null ? `<button class="btn${delegated ? ' on' : ''}" data-o="release" ${isPlayer && g.playerOverride && !g.ai.routed ? '' : 'disabled'} title="상급 지휘관에게 지휘권을 돌려줍니다">${delegated ? '상급 지휘관 재량' : '지휘권 위임'}<span class="key">T</span></button>` : ''}
        </div>
        <div class="row rtgrp">위험 시 자동 후퇴:
          ${[0, 0.25, 0.5].map(v => `<button class="btn${Math.abs(g.retreatAt - v) < 0.01 ? ' on' : ''}" data-rt="${v}" ${isPlayer ? '' : 'disabled'}>${v === 0 ? '없음' : `전력 ${v * 100}%`}</button>`).join('')}
        </div>
        <div class="hint" id="ghint"></div>
      </div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-o]').forEach(b => b.onclick = () => this.orderBtn(b.dataset.o!));
    el.querySelectorAll<HTMLButtonElement>('[data-rt]').forEach(b => b.onclick = () => { this.s.issueOrder(g.id, null, { retreatAt: Number(b.dataset.rt) }); setTimeout(() => this.refreshCommand(), 60); });
    this.updateStatusLine(g);
  }

  private updateStatusLine(g: Group) {
    const w = this.s.world;
    const st = document.getElementById('gstat');
    const hint = document.getElementById('ghint');
    if (!st || !hint) return;
    const ships = w.subtreeShips(g);
    const T = g.ai.mainTarget >= 0 ? w.groupById.get(g.ai.mainTarget) : null;
    const o = g.order;
    let doing = ORDER_TEXT[o.type];
    if (o.type === 'flank') doing += ` ${o.side > 0 ? '좌측' : '우측'} — ${{ transit: '우회 기동 중', staging: '돌입 신호 대기', strike: '측면 돌입!', none: '준비' }[g.ai.phase]}`;
    if (o.type === 'escort') doing += ` — ${w.groupById.get(o.guardGroup)?.name ?? ''}`;
    if (g.ai.kiting) doing += ' (거리 유지 후퇴 사격)';
    st.innerHTML = `<span>함선 <b>${ships.length}</b> · 전력 <b>${Math.round(w.groupHpFrac(g) * 100)}%</b> · 격침 <b>${g.stats.kills}</b></span><span>${esc(doing)}${T && o.type !== 'retreat' ? ` → <b style="color:#ff9a8a">${esc(T.name)}</b>` : ''}</span>`;
    hint.textContent = g.playerOverride && g.parentId !== null && this.P.mine(g.team) && !g.ai.routed ? '⚑ 직접 지휘 중 — 상위 지휘관의 명령을 받지 않습니다' : g.childIds.length ? '하위 부대들은 이 지휘관의 판단에 따라 역할을 나눠 맡습니다' : '';
  }

  // ------------------------------------------------------------------ overlay

  private drawOverlay() {
    const ctx = this.ctx;
    const W = innerWidth, H = innerHeight;
    ctx.clearRect(0, 0, W, H);
    const w = this.s.world, v = this.s.view;
    const tactical = v.rig.mode === 'tactical';
    if (v.rig.mode === 'director' || this.resultShown) { this.unitsDrawn = []; return; }
    const sel = this.selGroup();
    const selShips = new Set(sel ? w.subtreeShips(sel).map(s => s.id) : []);
    const p = this.p;
    // ship markers
    for (const s of w.ships) {
      if (s.state !== 'alive') continue;
      const view = v.views.get(s.id);
      if (!view || view.gone) continue;
      if (!v.project(view.wpos, p, W, H)) continue;
      const isSel = selShips.has(s.id);
      if (!tactical && !isSel && s !== this.hoverShip) continue;
      const dist = view.wpos.distanceTo(v.rig.camera.position);
      const px = Math.max(4, Math.min(40, s.cls.length * 900 / dist * 0.6));
      const classic = this.isClassic() || (this.P.spectator && w.sides.length === 2 && !w.dynamic);
      const col = classic ? (s.team === 0 ? (isSel ? '#bff0ff' : 'rgba(95,212,255,0.85)') : 'rgba(255,90,72,0.9)') : isSel ? '#e6fbff' : this.P.color(s.team);
      ctx.strokeStyle = col; ctx.lineWidth = isSel ? 1.6 : 1;
      const r = px * 0.6 + 3;
      const shape = this.P.spectator ? (s.team === 0 ? 'b' : 'd') : this.P.friend(s.team) ? 'b' : this.P.foe(s.team) ? 'd' : 'o';
      if (shape === 'o') { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke(); }
      else if (shape === 'b') {
        // brackets
        const k = r * 0.45;
        ctx.beginPath();
        ctx.moveTo(p.x - r, p.y - r + k); ctx.lineTo(p.x - r, p.y - r); ctx.lineTo(p.x - r + k, p.y - r);
        ctx.moveTo(p.x + r - k, p.y - r); ctx.lineTo(p.x + r, p.y - r); ctx.lineTo(p.x + r, p.y - r + k);
        ctx.moveTo(p.x + r, p.y + r - k); ctx.lineTo(p.x + r, p.y + r); ctx.lineTo(p.x + r - k, p.y + r);
        ctx.moveTo(p.x - r + k, p.y + r); ctx.lineTo(p.x - r, p.y + r); ctx.lineTo(p.x - r, p.y + r - k);
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x + r, p.y); ctx.lineTo(p.x, p.y + r); ctx.lineTo(p.x - r, p.y); ctx.closePath(); ctx.stroke();
      }
      if (tactical && s.role !== 'raider') {
        // class glyph dot
        ctx.fillStyle = col; ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }
      const hpf = s.hp / s.maxHp;
      if (isSel || hpf < 0.995 && (tactical || s === this.hoverShip)) {
        const bw = Math.max(16, r * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(p.x - bw / 2, p.y + r + 3, bw, 3);
        ctx.fillStyle = hpf > 0.6 ? '#7dffb0' : hpf > 0.3 ? '#ffb347' : '#ff5a48';
        ctx.fillRect(p.x - bw / 2, p.y + r + 3, bw * hpf, 3);
      }
      if (s.crit.fire > 0 || s.crit.engine > 0) { ctx.fillStyle = '#ffb347'; ctx.font = '10px sans-serif'; ctx.fillText(s.crit.fire > 0 ? '▲' : '◆', p.x + r + 2, p.y - r); }
    }
    // group units according to tree expansion
    this.unitsDrawn = [];
    const units: Group[] = [];
    const collect = (g: Group) => {
      if (!w.subtreeShips(g).length) return;
      if (this.expanded.has(g.id) && g.childIds.length) {
        for (const c of g.childIds) collect(w.groupById.get(c)!);
        if (w.directShips(g).length) units.push(g);
      } else units.push(g);
    };
    for (const sd of w.sides) for (const r of sd.roots) { const g = w.groupById.get(r); if (g) collect(g); }
    ctx.font = '600 11.5px "Noto Sans KR", sans-serif';
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const g of units) {
      const ships = g.childIds.length && this.expanded.has(g.id) ? w.directShips(g) : w.subtreeShips(g);
      if (!ships.length) continue;
      const c = w.centroid(ships);
      if (!v.project(c, p, W, H)) continue;
      const x = p.x, y = p.y;
      this.unitsDrawn.push({ g, x, y });
      const isSel = sel && (g.id === sel.id || w.isAncestor(sel, g));
      // order line
      const ourLine = this.P.spectator ? g.team === 0 : this.P.mine(g.team);
      if (ourLine && (tactical || isSel)) this.drawOrderLine(g, c, x, y, !!isSel);
      if (!tactical && !isSel) continue;
      const friendly = this.P.spectator ? g.team === 0 : this.P.friend(g.team);
      const classicG = this.isClassic() || (this.P.spectator && w.sides.length === 2 && !w.dynamic);
      const col = classicG ? (g.team === 0 ? (isSel ? '#e6fbff' : '#8fdcff') : '#ff9a8a') : isSel ? '#e6fbff' : this.P.color(g.team);
      // label plate
      const label = friendly || (this.P.spectator && !classicG) ? `${g.name}${g.hasCommander ? ' · ' + g.commander.name : ''}` : g.name;
      const tw = ctx.measureText(label).width;
      let ly = y - 34;
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find(r => x - tw / 2 - 6 < r.x1 && x + tw / 2 + 6 > r.x0 && ly - 12 < r.y1 && ly + 10 > r.y0);
        if (!hit) break;
        ly = hit.y0 - 11;
      }
      placed.push({ x0: x - tw / 2 - 6, x1: x + tw / 2 + 6, y0: ly - 12, y1: ly + 10 });
      ctx.fillStyle = friendly ? 'rgba(6,20,32,0.72)' : 'rgba(32,8,6,0.65)';
      ctx.fillRect(x - tw / 2 - 6, ly - 12, tw + 12, 17);
      ctx.fillStyle = ourLine && g.playerOverride && g.parentId !== null ? '#ffb347' : classicG ? (g.team === 0 ? '#5fd4ff' : '#ff5a48') : this.P.color(g.team);
      ctx.fillRect(x - tw / 2 - 6, ly - 12, 2, 17);
      ctx.fillStyle = col; ctx.fillText(label, x - tw / 2, ly);
      ctx.strokeStyle = friendly ? 'rgba(95,212,255,0.35)' : 'rgba(255,90,72,0.35)';
      ctx.beginPath(); ctx.moveTo(x, ly + 5); ctx.lineTo(x, y - 8); ctx.stroke();
      // role glyph + hp
      const hpf = w.groupHpFrac(g);
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x - 18, ly + 7, 36, 3);
      ctx.fillStyle = hpf > 0.6 ? '#7dffb0' : hpf > 0.3 ? '#ffb347' : '#ff5a48'; ctx.fillRect(x - 18, ly + 7, 36 * hpf, 3);
      if (ourLine && g.order.type === 'flank' && g.ai.phase === 'staging') { ctx.fillStyle = '#ffb347'; ctx.fillText('대기', x + tw / 2 + 10, ly); }
    }
    if (this.mode) {
      ctx.strokeStyle = 'rgba(255,179,71,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(this.pointer.x, this.pointer.y, 14, 0, Math.PI * 2); ctx.stroke();
    }
  }

  private drawOrderLine(g: Group, c: { x: number; y: number; z: number }, x: number, y: number, isSel: boolean) {
    const ctx = this.ctx, w = this.s.world, v = this.s.view, p = new THREE.Vector3();
    const o = g.order;
    let to: { x: number; y: number; z: number } | null = null;
    let via: { x: number; y: number; z: number } | null = null;
    if (o.type === 'attack') to = w.groupCenter(w.groupById.get(o.targetGroup)!);
    else if (o.type === 'escort') { const gg = w.groupById.get(o.guardGroup); if (gg) to = w.groupCenter(gg); }
    else if (o.type === 'move') to = o.point;
    else if (o.type === 'hold' && o.point) to = o.point;
    else if (o.type === 'flank') { via = g.ai.waypoint; const T = g.ai.mainTarget >= 0 ? w.groupById.get(g.ai.mainTarget) : null; if (T) to = w.groupCenter(T); if (g.ai.phase === 'strike') via = null; }
    else if (o.type === 'engage' && g.ai.mainTarget >= 0 && g.childIds.length === 0) { const T = w.groupById.get(g.ai.mainTarget); if (T && w.subtreeShips(T).length) to = w.groupCenter(T); }
    if (!to) return;
    if (o.type === 'attack' && w.subtreeShips(w.groupById.get(o.targetGroup)!).length === 0) return;
    ctx.strokeStyle = ORDER_COLOR[o.type]; ctx.globalAlpha = isSel ? 0.9 : 0.4; ctx.lineWidth = isSel ? 1.6 : 1;
    ctx.setLineDash(o.type === 'engage' ? [2, 6] : [7, 5]);
    ctx.lineDashOffset = -performance.now() / 60;
    ctx.beginPath(); ctx.moveTo(x, y);
    if (via && v.project(via, p, innerWidth, innerHeight)) { ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.moveTo(p.x, p.y); ctx.setLineDash([2, 5]); }
    if (v.project(to, p, innerWidth, innerHeight)) {
      ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.setLineDash([]);
      if (o.type === 'move' || o.type === 'hold') { ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke(); }
      else { const a = Math.atan2(p.y - y, p.x - x); ctx.beginPath(); ctx.moveTo(p.x - Math.cos(a - 0.4) * 10, p.y - Math.sin(a - 0.4) * 10); ctx.lineTo(p.x, p.y); ctx.lineTo(p.x - Math.cos(a + 0.4) * 10, p.y - Math.sin(a + 0.4) * 10); ctx.stroke(); }
    } else ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    void c;
  }

  private updateTooltip() {
    const tip = this.els.tooltip;
    if (this.pointer.down >= 0) { tip.classList.add('hidden'); return; }
    const s = this.s.view.pickShip(this.pointer.x, this.pointer.y, innerWidth, innerHeight, 16);
    if (!s) { tip.classList.add('hidden'); return; }
    const g = this.s.world.groupById.get(s.groupId)!;
    const cls = this.s.view.friendly(s.team) ? s.cls.name : s.cls.enemyName;
    const multi = this.s.world.sides.length > 2 || this.s.world.dynamic;
    const crit = [s.crit.engine > 0 ? '기관 손상' : '', s.crit.fire > 0 ? '화재' : '', s.crit.bridge > 0 ? '함교 피격' : ''].filter(Boolean).join(', ');
    tip.innerHTML = `<b style="color:${multi ? this.P.color(s.team) : this.s.view.friendly(s.team) ? 'var(--ally)' : 'var(--enemy)'}">${esc(s.name)}</b> <span style="color:var(--dim)">${cls} ${s.cls.type} · ${esc(s.loadout.name)}</span>${multi ? `<br><span style="color:${this.P.color(s.team)}">${esc(this.P.label(s.team))}</span>` : ''}<br>
      내구 ${Math.max(0, Math.round(s.hp))}/${Math.round(s.maxHp)} · ${esc(g.name)}${crit ? `<br><span style="color:var(--warn)">${crit}</span>` : ''}
      ${this.inspectable(s.team) ? `<br><span style="color:var(--dim)">피해 ${Math.round(s.stats.dmgDealt)} · 격침 ${s.stats.kills} · 요격 ${s.stats.intercepts}</span>` : ''}`;
    tip.style.left = `${this.pointer.x + 16}px`; tip.style.top = `${this.pointer.y + 12}px`;
    tip.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ results

  showResult() {
    if (this.resultShown) return;
    this.resultShown = true;
    const w = this.s.world;
    const o = w.outcome!;
    const me = this.P.me;
    const myStatus = me !== null ? o.sides?.[me]?.status : undefined;
    const win = me !== null && (o.winner === me || myStatus === 'victor');
    const multi = w.sides.length > 2 || w.dynamic;
    const modal = h('div', 'modal');
    const highlights = w.highlights.slice().sort((a, b) => b.score - a.score).slice(0, 6).sort((a, b) => a.time - b.time);
    const mine = w.ships.filter(s => s.team === (me ?? 0));
    const mvp = mine.slice().sort((a, b) => (b.stats.dmgDealt + b.stats.killValue * 12 + b.stats.intercepts * 40) - (a.stats.dmgDealt + a.stats.killValue * 12 + a.stats.intercepts * 40))[0];
    const topGroups = w.groups.filter(g => g.team === (me ?? 0) && (g.depth === 1 || (g.depth === 2)));
    const lost = (g: Group) => w.subtreeShips(g, true).filter(s => s.state === 'dead' || s.state === 'dying').length;
    const evalLine = (g: Group): string => {
      const all = w.subtreeShips(g, true);
      const killV = g.stats.killValue, lostV = all.filter(s => s.state === 'dead' || s.state === 'dying').reduce((a, s) => a + s.value, 0);
      const ratio = (killV + 1) / (lostV + 60);
      const grade = ratio > 3 ? 'S' : ratio > 1.6 ? 'A' : ratio > 0.8 ? 'B' : ratio > 0.4 ? 'C' : 'D';
      const c = g.commander;
      let comment = '';
      if (g.stats.kills >= 3) comment = '결정적인 활약.';
      else if (lostV === 0 && all.length) comment = '함선을 하나도 잃지 않았다.';
      else if (lostV >= g.initialValue * 0.8) comment = '거의 괴멸했다.';
      const intercepts = all.reduce((a, s) => a + s.stats.intercepts, 0);
      if (intercepts > 30) comment += ` 미사일·어뢰 ${intercepts}발 요격.`;
      const torp = all.reduce((a, s) => a + s.stats.torpHits, 0);
      if (torp > 2) comment += ` 어뢰 ${torp}발 명중.`;
      return `<tr><td><b>${esc(g.name)}</b><br><span style="color:var(--dim);font-size:11px">${esc(c.rank)} ${esc(c.name)}</span></td><td class="n">${g.stats.kills}</td><td class="n">${lost(g)}/${all.length}</td><td class="n">${Math.round(g.stats.dmgDealt / 100) / 10}k</td><td class="n" style="color:${grade === 'S' || grade === 'A' ? 'var(--good)' : grade === 'D' ? 'var(--enemy)' : 'var(--text)'}">${grade}</td><td style="font-size:11.5px;color:var(--dim)">${comment}</td></tr>`;
    };
    const survivors = mine.filter(s => s.state === 'alive' || s.state === 'escaped').length;
    const foeSide = (k: number) => me === null ? k !== 0 : this.P.foe(k);
    const enemyLost = w.ships.filter(s => foeSide(s.team) && (s.state === 'dead' || s.state === 'dying')).length;
    const enemyTotal = w.ships.filter(s => foeSide(s.team)).length;
    const OUT: Record<string, string> = { victor: '승리', survived: '생존', withdrawn: '철수', routed: '패주', destroyed: '전멸' };
    // P11: every side's result, the same for everybody; only the relation column depends on the viewer
    const sideTable = multi && o.sides ? `<h3>진영별 결과</h3><table class="gt"><tr><th>진영</th><th>관계</th><th>결과</th><th>생존</th><th>손실</th><th>이탈</th></tr>${this.P.order().map(k => {
      const r = o.sides![k]; if (!r) return '';
      const kind = this.P.kind(k);
      return `<tr><td><b style="color:${this.P.color(k)}">${esc(this.P.name(k))}</b></td><td>${kind ? REL_TEXT[kind] : '—'}</td><td>${OUT[r.status] ?? r.status}</td><td class="n">${r.alive}</td><td class="n">${r.lost}</td><td class="n">${r.escaped}</td></tr>`;
    }).join('')}</table>` : '';
    const myTitle = win ? '작전 성공' : myStatus === 'withdrawn' ? '철수 완료' : (myStatus === 'routed' || myStatus === 'destroyed' || (o.winner >= 0 && o.winner !== me)) ? '작전 실패' : multi ? '교전 종료' : '무승부';
    const spectTitle = o.winner >= 0 ? esc(this.P.name(o.winner)) + ' 승리' : multi ? esc(o.reason) : '무승부';
    const classic = !multi && me === 0 && !this.opts.names;
    modal.innerHTML = `<div class="panel result">
      ${me === null ? `<h1 class="win">${spectTitle}</h1>
      <div class="sub">${multi ? '' : esc(o.reason.replace(/^아군/, this.P.name(0)).replace(/^적 /, this.P.name(1) + ' ')) + ' · '}교전 시간 ${fmtTime(o.time)}${multi ? '' : ` · ${esc(this.P.name(0))} 생존 ${survivors}/${mine.length} · ${esc(this.P.name(1))} 격침 ${enemyLost}/${enemyTotal}`}</div>`
      : `<h1 class="${win ? 'win' : 'lose'}">${classic ? (o.winner === 0 ? '작전 성공' : o.winner === 1 ? '작전 실패' : '무승부') : myTitle}</h1>
      <div class="sub">${esc(o.reason)} · 교전 시간 ${fmtTime(o.time)} · ${classic ? '아군' : esc(this.P.name(me))} 생존 ${survivors}/${mine.length} · ${classic ? '적' : '적대 진영'} 격침 ${enemyLost}/${enemyTotal}</div>`}
      ${sideTable}
      <div class="cols">
        <div>
          <h3>전투 하이라이트</h3>
          ${highlights.map(hh => `<div class="hl${(me === null ? hh.team !== 0 : !this.P.friend(hh.team)) ? ' e' : ''}"><span class="tm">${fmtTime(hh.time)}</span><span class="ht">${esc(hh.title)}</span>${esc(hh.text)}</div>`).join('') || '<div class="eval">특별한 장면이 없었다.</div>'}
        </div>
        <div>
          <h3>최우수 함선</h3>
          ${mvp ? `<div class="mvp"><div><div class="badge">MVP</div><div class="nm">${esc(mvp.name)}</div><div style="color:var(--dim);font-size:12px">${mvp.cls.name} ${mvp.cls.type} · ${esc(mvp.loadout.name)} · ${esc(w.groupById.get(mvp.groupId)!.name)}</div></div>
            <div style="margin-left:auto;text-align:right;font-family:var(--mono);font-size:13px">피해 ${Math.round(mvp.stats.dmgDealt)}<br>격침 ${mvp.stats.kills} · 요격 ${mvp.stats.intercepts}<br>명중 ${mvp.stats.hits}/${mvp.stats.shots}</div></div>` : ''}
          <h3>지휘관 평가</h3>
          <table class="gt"><tr><th>부대</th><th>격침</th><th>손실</th><th>피해</th><th>평가</th><th></th></tr>${topGroups.map(evalLine).join('')}</table>
        </div>
      </div>
      <div class="acts">${this.opts.campaign ? `${this.opts.spectate ? '<button class="btn" data-a="replay">처음부터 다시 보기</button>' : ''}<button class="btn go" data-a="return">전략 지도로 복귀</button>` : `
        <button class="btn" data-a="replay">리플레이 보기</button>
        <button class="btn" data-a="restart">같은 조건으로 재도전</button>
        <button class="btn go" data-a="exit">함대 편성으로</button>`}
      </div>
    </div>`;
    this.root.appendChild(modal);
    const bind = (k: string, f: () => void) => { const b = modal.querySelector<HTMLButtonElement>(`[data-a="${k}"]`); if (b) b.onclick = f; };
    bind('replay', () => this.opts.onReplay()); bind('restart', () => this.opts.onRestart()); bind('exit', () => this.opts.onExit());
    bind('return', () => this.opts.campaign?.onReturn());
    this.s.view.audio?.play(me === null || win ? 'win' : 'lose', null, 0.8);
  }
}

export type { Team };
