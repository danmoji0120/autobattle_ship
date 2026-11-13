// Fitting V2 screen (growth P2): edit a docked ship's hardpoint weapons, bay modules and structural
// variant as a draft, see exactly what changes (items from / to storage, purchases, fees, power and
// mass, combat numbers), then apply it as one server command. The server re-checks everything; this
// screen only previews with the same rule functions (src/content/rules.ts, src/world/fitting.ts).
//
// Rendered with morph() so typing in the search box or an open dropdown survives live updates; all
// clicks go through one delegated listener.
import { fitServiceUnit } from '../../world/econChain';
import { econOf, growthOn } from '../../world/hullops';
import * as THREE from 'three';
import type { WorldView } from '../../server/protocol';
import type { WShip, Station } from '../../world/types';
import type { Cmd } from '../../world/sim';
import { qty } from '../../world/types';
import { CONTENT, variantLayout, presetsOfHull, variantsOfHull, weaponRole, contentAvail } from '../../content/registry';
import { hpAccepts, bayAccepts, weaponType, TYPE_NAME, MOUNT_NAME, BAY_NAME, arcOf } from '../../content/rules';
import type { HardpointDef, InternalSlotDef } from '../../content/schema';
import { checkFitting, fittingItems, itemDelta, shipLoadout, shipLoadoutKey, bayModules, type ShipFitting } from '../../world/fitting';
import { EQUIPMENT, fitFx, itemPrice, TECHS } from '../../world/industry';
import { regionalMarketRequired, regionalOn } from '../../world/regional';
import { priceOf } from '../../world/market';
import { WEAPONS, type WeaponDef } from '../../sim/data/weapons';
import { SHIP_CLASSES } from '../../sim/data/ships';
import { ECON } from '../../world/data';
import { buildShip } from '../../render/shipMesh';
import { morph } from '../../ui/morph';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => (Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString();
const sgn = (n: number, d = 0) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(Number(n.toFixed(d))).toLocaleString();
const pct = (m: number) => sgn(Math.round((m - 1) * 100)) + '%';

interface Draft { variant: string; hp: Record<string, string>; bay: Record<string, string> }
type Slot = { kind: 'hp'; id: string } | { kind: 'bay'; id: string };

/** sustained damage per second of one weapon (salvo / reload), the same numbers the engine uses */
export const weaponDps = (w: WeaponDef) => w.damage * w.salvo / w.reload;

const TYPE_COL: Record<string, string> = { ballistic: '#ffcf7a', energy: '#9fd6ff', missile: '#ff9f6b', universal: '#d7b8ff', pd: '#7dffb0' };

export class FittingScreen {
  el: HTMLElement;
  private draft: Draft;
  private baseKey = '';
  private undo: Draft[] = [];
  private sel: Slot | null = null;
  private q = '';
  private filter = 'fit'; // fit = compatible with the selected slot · all · weapon · module
  private sort: 'name' | 'mass' | 'power' | 'dps' | 'range' | 'have' = 'name';
  private buy = false;
  private presetName = '';
  private busy = false;
  private msg: { t: string; warn: boolean } | null = null;
  // preview
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  private model: THREE.Object3D | null = null;
  private markers = new THREE.Group();
  private modelKey = '';
  private yaw = 0.7; private pitch = 0.42; private drag: { x: number; y: number } | null = null; private auto = true;
  private raf = 0;

  constructor(private host: HTMLElement, private getState: () => WorldView | null, private me: string, private shipId: string,
    private send: (c: Cmd) => Promise<boolean>, private onClose: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'modal fitmodal';
    this.el.onclick = e => { if (e.target === this.el) this.close(); };
    host.appendChild(this.el);
    const s = this.ship!;
    this.draft = this.fromShip(s);
    this.baseKey = this.keyOf(this.draft);
    this.el.addEventListener('click', e => this.onClick(e));
    this.el.addEventListener('input', e => this.onInput(e));
    this.el.addEventListener('change', e => this.onInput(e));
    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1a2230, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(300, 400, 200); this.scene.add(sun);
    this.scene.add(this.markers);
    this.update(true);
    const loop = () => { this.raf = requestAnimationFrame(loop); this.draw(); };
    this.raf = requestAnimationFrame(loop);
  }

  private get st() { return this.getState(); }
  private get ship(): WShip | undefined { return this.st?.ships[this.shipId]; }
  private get station(): Station | undefined { const s = this.ship; return s && s.task.k === 'docked' ? this.st!.stations[(s.task as any).station] : undefined; }
  private fromShip(s: WShip): Draft { return { variant: s.variant!, hp: { ...s.fitting!.hp }, bay: { ...s.fitting!.bay } }; }
  private keyOf(d: Draft) { return JSON.stringify([d.variant, Object.entries(d.hp).sort(), Object.entries(d.bay).sort()]); }
  private get dirty() { const s = this.ship; return !!s?.fitting && this.keyOf(this.draft) !== this.keyOf(this.fromShip(s)); }

  close() {
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose(); this.renderer = null;
    this.el.remove(); this.onClose();
  }

  private edit(fn: (d: Draft) => void) {
    this.undo.push(structuredClone(this.draft)); if (this.undo.length > 50) this.undo.shift();
    fn(this.draft); this.msg = null; this.update(true);
  }

  // ------------------------------------------------------------------ derived numbers

  private facility() {
    const st = this.station; if (!st) return { ownFit: false, pub: false };
    const ownFit = st.owner === this.me && st.modules.some(m => m.built && (m.kind === 'fitting' || m.kind.startsWith('yard_')));
    return { ownFit, pub: !!(st.public && st.services.refit) };
  }

  /** what applying the draft does: item moves, purchases, fee, and whether the server would accept */
  private plan() {
    const s = this.ship!, st = this.station, co = this.st!.companies[this.me];
    const rep = checkFitting(this.draft.variant, this.draft);
    const delta = itemDelta(fittingItems(s.fitting), fittingItems(this.draft));
    const store = st?.storage[this.me] ?? {};
    const { ownFit, pub } = this.facility();
    const take: [string, number][] = [], back: [string, number][] = [], short: [string, number][] = [];
    for (const [k, n] of Object.entries(delta)) {
      if (n < 0) { back.push([k, -n]); continue; }
      take.push([k, n]);
      const miss = n - Math.floor(qty(store, k) + 1e-9); if (miss > 0) short.push([k, miss]);
    }
    const locked = short.filter(([k]) => EQUIPMENT[k]?.tech && !co.tech?.includes(EQUIPMENT[k].tech!));
    const marketShort = short.filter(([k, n]) => {
      if (!regionalMarketRequired(this.st, k)) return false;
      const m = st?.market && Object.hasOwn(st.market, k) ? st.market[k] : undefined;
      const price = priceOf(m, 'buy', true);
      return !m || !Number.isFinite(m.stock) || m.stock < n || !Number.isFinite(price) || price <= 0;
    });
    const buyCost = Math.round(short.reduce((a, [k, n]) => a + (regionalMarketRequired(this.st, k) ? 0 : n * fitServiceUnit(this.st ?? undefined, k, st?.market?.[k] ? priceOf(st.market[k], 'buy', true) : undefined)), 0))
      + short.reduce((a, [k, n]) => a + (regionalMarketRequired(this.st, k) ? n * priceOf(st?.market?.[k], 'buy', true) : 0), 0);
    const changed = Object.keys(delta).length;
    const varFee = this.draft.variant !== s.variant && !ownFit ? Math.round(econOf(s).price * 0.15) : 0;
    const fee = ownFit ? 0 : (changed ? 400 + changed * 300 : 0) + varFee;
    const block = !st ? '정박 중이 아님' : !ownFit && !pub ? '이 정거장에는 피팅 시설이 없음'
      : rep.errors.length ? rep.errors[0]
      : short.length && (!pub || !this.buy) ? `보관함에 없는 장비 ${short.reduce((a, x) => a + x[1], 0)}개${pub ? ' — "부족분 구매"를 켜면 이 정거장에서 삽니다' : ' — 자사 시설은 장비를 판매하지 않음'}`
      : locked.length ? `${EQUIPMENT[locked[0][0]].name}: 연구 필요 (${TECHS[EQUIPMENT[locked[0][0]].tech!]?.name ?? ''})`
      : marketShort.length ? `${EQUIPMENT[marketShort[0][0]]?.name ?? marketShort[0][0]}: 시장 재고 부족 — 플레이어 거래소 또는 실제 재고가 있는 시장 이용`
      : co.credits < fee + (this.buy ? buyCost : 0) ? '자금 부족'
      : !changed && this.draft.variant === s.variant ? '변경 사항 없음' : null;
    return { rep, take, back, short, marketShort, buyCost: this.buy && pub ? buyCost : 0, fullBuy: buyCost, fee, block, ownFit, pub };
  }

  /** combat summary of a fitting (what the engine will build) */
  private stats(d: Draft) {
    const s = this.ship!;
    const lo = shipLoadout({ classId: s.classId, loadoutId: s.loadoutId, variant: d.variant, fitting: { hp: d.hp, bay: d.bay } });
    const fx = fitFx(bayModules(d.variant, { hp: d.hp, bay: d.bay }), this.st!.companies[this.me]?.tech);
    const cls = SHIP_CLASSES[s.classId];
    let dps = 0, pd = 0, range = 0, missile = 0;
    for (const m of lo.mounts) { const w = WEAPONS[m.weapon]; if (w.kind === 'pd') { pd++; continue; } dps += weaponDps(w); range = Math.max(range, w.range); if (w.kind !== 'shell') missile++; }
    return {
      dps, pd, range: range * fx.rangeMul, missile, guns: lo.mounts.length,
      hp: cls.hp * (lo.hpMul ?? 1) * fx.hpMul, armor: cls.armor.front * (lo.armorMul ?? 1) * fx.armorMul, speed: cls.maxSpeed * (lo.speedMul ?? 1) * fx.speedMul,
      acc: fx.accMul, evasion: fx.evasion, reload: fx.reloadMul,
    };
  }

  // ------------------------------------------------------------------ render

  update(force = false) {
    const s = this.ship;
    if (!s || !s.fitting || s.owner !== this.me) { this.close(); return; }
    // the ship changed under us (applied, or refitted elsewhere): follow it unless the user is editing
    const bk = this.keyOf(this.fromShip(s));
    if (bk !== this.baseKey) { if (!this.dirtySince(this.baseKey)) this.draft = this.fromShip(s); this.baseKey = bk; force = true; }
    if (!force && this.el.childElementCount) { this.renderLive(); return; }
    this.render();
  }
  private dirtySince(k: string) { return this.keyOf(this.draft) !== k; }
  private lastLive = '';
  private renderLive() {
    // storage counts and credits tick while the screen is open
    const st = this.station; const co = this.st!.companies[this.me];
    const k = JSON.stringify([st?.storage[this.me], Math.round(co.credits), co.tech, st?.id]);
    if (k !== this.lastLive) { this.lastLive = k; this.render(); }
  }

  private render() {
    const s = this.ship!, st = this.station, co = this.st!.companies[this.me];
    const lay = variantLayout(this.draft.variant)!;
    const hull = lay.hull, cls = SHIP_CLASSES[s.classId];
    const p = this.plan();
    const now = this.stats(this.fromShip(s)), nxt = this.stats(this.draft);
    const store = st?.storage[this.me] ?? {};
    const cmp = (a: number, b: number, d = 0, inv = false) => { const x = b - a; if (Math.abs(x) < 1e-6) return ''; const good = inv ? x < 0 : x > 0; return ` <span class="${good ? 'up' : 'dn'}">${sgn(x, d)}</span>`; };
    const bar = (v: number, cap: number, label: string) => {
      const f = cap > 0 ? v / cap : 0;
      return `<div class="fbar${f > 1 ? ' over' : f > 0.9 ? ' near' : ''}"><div class="fbl"><span>${label}</span><b>${fmt(v)} / ${fmt(cap)}</b></div><div class="fbt"><i style="width:${Math.min(100, f * 100)}%"></i></div></div>`;
    };
    const selId = this.sel?.id;
    const hpRow = (h: HardpointDef) => {
      const eq = this.draft.hp[h.id]; const cur = s.fitting!.hp[h.id];
      const bad = p.rep.bad[h.id];
      const changed = (eq ?? '') !== (cur ?? '') ? ' chg' : '';
      return `<button class="fslot${selId === h.id ? ' on' : ''}${bad ? ' bad' : ''}${changed}" data-fsel="hp:${h.id}" title="${esc(bad ?? '')}">
        <span class="fsz" style="border-color:${TYPE_COL[h.type]}">${h.size}</span>
        <span class="fsm"><b>${eq ? esc(EQUIPMENT[eq]?.name ?? eq) : '<i class="dim">비어 있음</i>'}</b><small>${h.id} · ${TYPE_NAME[h.type]} · ${MOUNT_NAME[h.mount]} · 사각 ${eq ? arcOf(h, eq) : h.arc}°</small></span>
        ${eq ? `<span class="fx" data-fclr="hp:${h.id}" title="비우기">✕</span>` : ''}</button>`;
    };
    const bayRow = (b: InternalSlotDef) => {
      const eq = this.draft.bay[b.id]; const cur = s.fitting!.bay[b.id]; const bad = p.rep.bad[b.id];
      const changed = (eq ?? '') !== (cur ?? '') ? ' chg' : '';
      return `<button class="fslot${selId === b.id ? ' on' : ''}${bad ? ' bad' : ''}${changed}" data-fsel="bay:${b.id}" title="${esc(bad ?? '')}">
        <span class="fsz bay">${b.size}</span>
        <span class="fsm"><b>${eq ? esc(EQUIPMENT[eq]?.name ?? eq) : '<i class="dim">비어 있음</i>'}</b><small>${b.id} · ${BAY_NAME[b.kind]} 베이</small></span>
        ${eq ? `<span class="fx" data-fclr="bay:${b.id}" title="비우기">✕</span>` : ''}</button>`;
    };
    const hullPresets = presetsOfHull(hull.id).filter(x => contentAvail(x.id, this.st!.contentV));
    const myPresets = (co.fitPresets ?? []).filter(x => x.hull === hull.id);
    const variants = variantsOfHull(hull.id).filter(v => v.id === s.variant || contentAvail(v.id, this.st!.contentV));
    const items = (n: [string, number][]) => n.map(([k, c]) => `${esc(EQUIPMENT[k]?.name ?? k)}${c > 1 ? ` ×${c}` : ''}`).join(', ');

    morph(this.el, `<div class="panel fbox">
      <div class="shdr"><div><div class="stitle">${esc(s.name)} <span class="dim" style="font-size:14px">${esc(hull.name)} ${esc(cls.type)} · ${esc(CONTENT.variants[this.draft.variant]?.name ?? '')}</span></div>
        <div class="dim">${st ? `${esc(st.name)} 정박 · ${p.ownFit ? '자사 피팅 시설 (수수료 없음, 보관함 장비만 사용)' : p.pub ? '공용 개조 서비스 (수수료, 부족분 구매 가능)' : '피팅 시설 없음'}` : '정박 중이 아님 — 피팅은 정박 중에만 바꿀 수 있습니다'}</div></div>
        <div class="money">${fmt(co.credits)} cr</div><button class="btn" data-fclose>✕</button></div>
      <div class="fgrid">
        <section class="fcol fleft">
          <div class="fprev" data-fprev><canvas data-fcanvas></canvas><div class="fhint">드래그: 회전 · 점: 하드포인트 (클릭해 선택)</div></div>
          ${bar(p.rep.power, p.rep.supply, '전력')}${bar(p.rep.mass, p.rep.cap, '적재 질량')}
          <table class="fstat">
            <tr><td>지속 화력</td><td>${fmt(nxt.dps)}/s${cmp(now.dps, nxt.dps, 1)}</td><td>최대 사거리</td><td>${fmt(nxt.range)}${cmp(now.range, nxt.range)}</td></tr>
            <tr><td>무장</td><td>${nxt.guns}문${cmp(now.guns, nxt.guns)}</td><td>방공</td><td>${nxt.pd}문${cmp(now.pd, nxt.pd)}</td></tr>
            <tr><td>내구</td><td>${fmt(nxt.hp)}${cmp(now.hp, nxt.hp)}</td><td>전면 장갑</td><td>${fmt(nxt.armor)}${cmp(now.armor, nxt.armor, 1)}</td></tr>
            <tr><td>전투 속도</td><td>${fmt(nxt.speed)}${cmp(now.speed, nxt.speed, 1)}</td><td>명중·회피</td><td>${pct(nxt.acc)} · ${Math.round(nxt.evasion * 100)}%</td></tr>
          </table>
          <div class="frow"><label class="dim">구조 변형</label><select data-fvar data-keep>${variants.map(v => `<option value="${v.id}"${v.id === this.draft.variant ? ' selected' : ''}${v.blueprint !== 'common' && v.id !== s.variant ? ' disabled' : ''}>${esc(v.name)}${v.mods ? ` (${[v.mods.hpMul && `내구 ${pct(v.mods.hpMul)}`, v.mods.armorMul && `장갑 ${pct(v.mods.armorMul)}`, v.mods.speedMul && `속도 ${pct(v.mods.speedMul)}`].filter(Boolean).join(' ')})` : ''}</option>`).join('')}</select></div>
        </section>
        <section class="fcol fmid">
          <h3>하드포인트 <span class="dim">${lay.hardpoints.filter(h => this.draft.hp[h.id]).length}/${lay.hardpoints.length}</span></h3>
          <div class="fslots">${lay.hardpoints.map(hpRow).join('')}</div>
          <h3>내부 베이 <span class="dim">${lay.internals.filter(b => this.draft.bay[b.id]).length}/${lay.internals.length}</span></h3>
          <div class="fslots">${lay.internals.length ? lay.internals.map(bayRow).join('') : '<div class="dim small">내부 베이가 없는 선체</div>'}</div>
          <h3>프리셋</h3>
          <div class="fpre">${hullPresets.map(x => `<button class="chip" data-fpre="h:${x.id}" title="${esc(x.desc)}">${esc(x.name)}</button>`).join('')}</div>
          <div class="fpre">${myPresets.map(x => `<span class="chip mine"><span data-fpre="c:${x.id}">${esc(x.name)}</span><i data-fdelp="${x.id}" title="삭제">✕</i></span>`).join('') || '<span class="dim small">저장한 회사 프리셋 없음</span>'}</div>
          <div class="frow"><input data-fpname placeholder="프리셋 이름" maxlength="24" value="${esc(this.presetName)}"><button class="btn" data-fsavep ${p.rep.errors.length ? 'disabled' : ''}>현재 초안 저장</button></div>
        </section>
        <section class="fcol fright">${this.browserHtml(lay, store, p)}</section>
      </div>
      <div class="ffoot">
        <div class="fchg">
          ${p.take.length || p.back.length ? `${p.take.length ? `<div><b class="dn">장착</b> ${items(p.take)} <span class="dim">(보관함에서)</span></div>` : ''}${p.back.length ? `<div><b class="up">해제</b> ${items(p.back)} <span class="dim">(보관함으로)</span></div>` : ''}${p.short.length ? `<div class="warn">부족 ${items(p.short)}${p.pub ? p.marketShort.length ? ' · 시장 재고 부족' : ` · 구매 시 ${fmt(p.fullBuy)} cr` : ''}</div>` : ''}` : '<div class="dim">변경 사항 없음 — 슬롯을 고르고 오른쪽 목록에서 장비를 선택하세요</div>'}
          ${this.msg ? `<div class="${this.msg.warn ? 'warn' : 'good'}">${esc(this.msg.t)}</div>` : p.block && this.dirty ? `<div class="warn">${esc(p.block)}</div>` : ''}
        </div>
        <div class="fact">
          ${p.pub ? `<label class="fbuy"><input type="checkbox" data-fbuy ${this.buy ? 'checked' : ''}> 부족분 구매 ${regionalOn(this.st) ? '(지역 고급 장비는 실제 시장 재고 사용)' : '(시가 ×1.2)'}</label>` : ''}
          <span class="money">${p.fee + p.buyCost ? `${fmt(p.fee + p.buyCost)} cr` : '무료'}</span>
          <button class="btn" data-fundo ${this.undo.length ? '' : 'disabled'}>되돌리기</button>
          <button class="btn" data-freset ${this.dirty ? '' : 'disabled'}>초기화</button>
          <button class="btn go" data-fapply ${p.block || this.busy ? 'disabled' : ''}>적용</button>
        </div>
      </div></div>`);
    const cv = this.el.querySelector<HTMLCanvasElement>('[data-fcanvas]')!;
    this.attachPreview(cv);
    this.syncModel();
  }

  private browserHtml(lay: NonNullable<ReturnType<typeof variantLayout>>, store: Record<string, number>, p: ReturnType<FittingScreen['plan']>) {
    const sel = this.sel;
    const hp = sel?.kind === 'hp' ? lay.hardpoints.find(h => h.id === sel.id) : undefined;
    const bay = sel?.kind === 'bay' ? lay.internals.find(b => b.id === sel.id) : undefined;
    const cur = hp ? this.draft.hp[hp.id] : bay ? this.draft.bay[bay.id] : undefined;
    const co = this.st!.companies[this.me];
    const q = this.q.trim().toLowerCase();
    const g = growthOn(this.st!);
    let list = Object.values(EQUIPMENT).filter(e => CONTENT.equipment[e.id] && (g || !e.growth) && !e.exclusive);
    if (this.filter === 'fit') list = list.filter(e => hp ? !hpAccepts(hp, e.id) : bay ? !bayAccepts(bay, e.id) : true);
    else if (this.filter === 'weapon') list = list.filter(e => e.kind === 'weapon');
    else if (this.filter === 'module') list = list.filter(e => e.kind === 'module');
    if (q) list = list.filter(e => e.name.toLowerCase().includes(q) || e.id.includes(q) || (e.weapon && WEAPONS[e.weapon].name.toLowerCase().includes(q)));
    const dps = (id: string) => { const w = EQUIPMENT[id]?.weapon; return w ? weaponDps(WEAPONS[w]) : 0; };
    const rng = (id: string) => { const w = EQUIPMENT[id]?.weapon; return w ? WEAPONS[w].range : 0; };
    const sp = (id: string) => CONTENT.equipment[id];
    const key: Record<string, (id: string) => number> = { mass: id => sp(id).mass, power: id => sp(id).power, dps: id => -dps(id), range: id => -rng(id), have: id => -qty(store, id) };
    list.sort((a, b) => this.sort === 'name' ? a.name.localeCompare(b.name, 'ko') : key[this.sort](a.id) - key[this.sort](b.id) || a.name.localeCompare(b.name, 'ko'));
    const d = (x: number, y: number | undefined, dd = 0, inv = false) => { if (y === undefined) return ''; const v = x - y; if (Math.abs(v) < 1e-6) return ''; return ` <span class="${(inv ? v < 0 : v > 0) ? 'up' : 'dn'}">${sgn(v, dd)}</span>`; };
    const c = cur ? sp(cur) : undefined;
    const row = (id: string) => {
      const e = EQUIPMENT[id], s = sp(id), w = e.weapon ? WEAPONS[e.weapon] : undefined;
      const why = hp ? hpAccepts(hp, id) : bay ? bayAccepts(bay, id) : null;
      const have = Math.floor(qty(store, id));
      const lock = e.tech && !co.tech?.includes(e.tech);
      const cw = cur && EQUIPMENT[cur]?.weapon ? WEAPONS[EQUIPMENT[cur].weapon!] : undefined;
      const stats = w
        ? `${famBadge(w)}화력 ${fmt(weaponDps(w))}/s${d(weaponDps(w), cur ? dps(cur) : undefined, 1)} · 사거리 ${fmt(w.range)}${d(w.range, cur ? rng(cur) : undefined)} · 관통 ${w.pen}${d(w.pen, cw?.pen)} · ${TYPE_NAME[weaponType(w.id)]}${g ? statBars(w) : ''}`
        : g && e.cfx ? `${esc(cfxText(e.cfx))}` : esc(e.desc);
      return `<div class="fitem${why ? ' no' : ''}${id === cur ? ' cur' : ''}" data-fpick="${id}" title="${esc(why ?? e.desc)}">
        <div class="fin"><b>${esc(e.name)}</b><span class="fsz sm">${s.size}</span>${id === cur ? '<span class="tag">장착 중</span>' : ''}${lock && !have ? '<span class="tag warn" title="보유하지 않은 이 장비를 구매·생산하려면 연구가 필요합니다">연구 필요</span>' : ''}<span class="fhave${have ? '' : ' none'}">보유 ${have}</span></div>
        <div class="fis">${stats}</div>
        <div class="fis dim">질량 ${s.mass}${d(s.mass, c?.mass, 0, true)} · 전력 ${s.power < 0 ? `공급 +${-s.power}` : s.power}${d(s.power, c?.power, 0, true)} · ${fmt(itemPrice(id))} cr${why ? ` · <span class="warn">${esc(why)}</span>` : ''}</div></div>`;
    };
    const title = hp ? `${hp.id} — ${hp.size} ${TYPE_NAME[hp.type]} ${MOUNT_NAME[hp.mount]}` : bay ? `${bay.id} — ${bay.size} ${BAY_NAME[bay.kind]} 베이` : '슬롯을 선택하세요';
    return `<h3>장비 <span class="dim">${esc(title)}</span></h3>
      <div class="frow"><input data-fq placeholder="장비 검색 (이름·종류)" value="${esc(this.q)}"></div>
      <div class="chips">${([['fit', '이 슬롯 호환'], ['all', '전체'], ['weapon', '무장'], ['module', '모듈']] as const).map(([v, l]) => `<button class="chip${this.filter === v ? ' on' : ''}" data-ffilt="${v}">${l}</button>`).join('')}</div>
      <div class="chips">${([['name', '이름'], ['dps', '화력'], ['range', '사거리'], ['mass', '질량'], ['power', '전력'], ['have', '보유']] as const).map(([v, l]) => `<button class="chip${this.sort === v ? ' on' : ''}" data-fsort="${v}">${l}순</button>`).join('')}</div>
      ${cur ? `<div class="dim small">현재 장착: <b>${esc(EQUIPMENT[cur]?.name ?? cur)}</b> — 아래 수치의 <span class="up">+</span>/<span class="dn">−</span>는 이 장비와의 차이</div>` : ''}
      <div class="flist">${list.length ? list.map(e => row(e.id)).join('') : '<div class="dim">조건에 맞는 장비가 없습니다</div>'}</div>
      ${p.pub ? '' : '<div class="dim small">자사 시설: 보관함에 있는 장비만 장착할 수 있습니다. 생산 탭에서 만들거나 거래소에서 구매하세요.</div>'}`;
  }

  // ------------------------------------------------------------------ input

  private onInput(e: Event) {
    const t = e.target as HTMLElement;
    if (t.matches('[data-fq]')) { this.q = (t as HTMLInputElement).value; this.render(); }
    else if (t.matches('[data-fpname]')) this.presetName = (t as HTMLInputElement).value;
    else if (t.matches('[data-fbuy]')) { this.buy = (t as HTMLInputElement).checked; this.render(); }
    else if (t.matches('[data-fvar]') && e.type === 'change') {
      const v = (t as HTMLSelectElement).value;
      this.edit(d => { d.variant = v; const lay = variantLayout(v)!; for (const k of Object.keys(d.hp)) if (!lay.hardpoints.some(h => h.id === k)) delete d.hp[k]; for (const k of Object.keys(d.bay)) if (!lay.internals.some(b => b.id === k)) delete d.bay[k]; });
    }
  }

  private async onClick(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-fclose],[data-fclr],[data-fsel],[data-fpick],[data-ffilt],[data-fsort],[data-fpre],[data-fdelp],[data-fsavep],[data-fundo],[data-freset],[data-fapply]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.fclose !== undefined) return this.close();
    if (ds.fclr) { e.stopPropagation(); const [k, id] = ds.fclr.split(':'); this.edit(d => { delete (k === 'hp' ? d.hp : d.bay)[id]; }); return; }
    if (ds.fsel) { const [k, id] = ds.fsel.split(':'); this.sel = { kind: k as 'hp', id }; this.filter = 'fit'; this.render(); return; }
    if (ds.fpick) {
      const id = ds.fpick; const sel = this.sel;
      if (!sel) { this.msg = { t: '먼저 왼쪽에서 하드포인트나 베이를 선택하세요', warn: true }; this.render(); return; }
      const lay = variantLayout(this.draft.variant)!;
      const why = sel.kind === 'hp' ? hpAccepts(lay.hardpoints.find(h => h.id === sel.id)!, id) : bayAccepts(lay.internals.find(b => b.id === sel.id)!, id);
      if (why) { this.msg = { t: why, warn: true }; this.render(); return; }
      this.edit(d => { (sel.kind === 'hp' ? d.hp : d.bay)[sel.id] = id; });
      return;
    }
    if (ds.ffilt) { this.filter = ds.ffilt; this.render(); return; }
    if (ds.fsort) { this.sort = ds.fsort as 'name'; this.render(); return; }
    if (ds.fpre) {
      const [k, id] = ds.fpre.split(':');
      if (k === 'h') { const p = CONTENT.presets[id]; if (p) this.edit(d => { d.variant = p.variant; d.hp = { ...p.weapons }; }); }
      else { const p = this.st!.companies[this.me].fitPresets?.find(x => x.id === id); if (p) this.edit(d => { d.variant = p.variant; d.hp = { ...p.hp }; d.bay = { ...p.bay }; }); }
      return;
    }
    if (ds.fdelp) { e.stopPropagation(); if (confirm('이 회사 프리셋을 삭제할까요?')) await this.send({ c: 'delPreset', id: ds.fdelp }); this.render(); return; }
    if (ds.fsavep !== undefined) {
      const ok = await this.send({ c: 'savePreset', name: this.presetName || '내 피팅', variant: this.draft.variant, hp: this.draft.hp, bay: this.draft.bay });
      if (ok) { this.msg = { t: `프리셋 "${this.presetName || '내 피팅'}" 저장됨`, warn: false }; this.presetName = ''; }
      this.render(); return;
    }
    if (ds.fundo !== undefined) { const d = this.undo.pop(); if (d) { this.draft = d; this.msg = null; this.render(); } return; }
    if (ds.freset !== undefined) { this.edit(d => Object.assign(d, this.fromShip(this.ship!))); return; }
    if (ds.fapply !== undefined) {
      this.busy = true; this.render();
      const ok = await this.send({ c: 'fit', ship: this.shipId, variant: this.draft.variant, hp: this.draft.hp, bay: this.draft.bay, buy: this.buy });
      this.busy = false;
      if (ok) { this.undo = []; this.msg = { t: '피팅 적용 완료 — 빠진 장비는 이 정거장 보관함으로 옮겨졌습니다', warn: false }; }
      this.render();
    }
  }

  // ------------------------------------------------------------------ 3D preview

  private attachPreview(cv: HTMLCanvasElement) {
    if (this.renderer?.domElement === cv) return;
    this.renderer?.dispose();
    this.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    cv.onpointerdown = e => { this.drag = { x: e.clientX, y: e.clientY }; this.auto = false; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => { if (!this.drag) return; this.yaw -= (e.clientX - this.drag.x) * 0.01; this.pitch = Math.max(-1.2, Math.min(1.3, this.pitch + (e.clientY - this.drag.y) * 0.01)); this.drag = { x: e.clientX, y: e.clientY }; };
    cv.onpointerup = e => {
      const moved = this.drag && Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 3; this.drag = null;
      if (moved) return;
      // click on a hardpoint marker selects that slot
      const r = cv.getBoundingClientRect();
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.cam);
      const hit = ray.intersectObjects(this.markers.children, false)[0];
      if (hit) { this.sel = { kind: 'hp', id: hit.object.userData.hp }; this.filter = 'fit'; this.render(); }
    };
  }

  private syncModel() {
    const s = this.ship!; const lay = variantLayout(this.draft.variant)!;
    const fake = { classId: s.classId, loadoutId: s.loadoutId, variant: this.draft.variant, fitting: { hp: this.draft.hp, bay: this.draft.bay } };
    const key = shipLoadoutKey(fake) + '|' + (this.sel?.id ?? '') + '|' + Object.keys(checkFitting(this.draft.variant, this.draft).bad).join();
    if (key === this.modelKey) return;
    this.modelKey = key;
    if (this.model) this.scene.remove(this.model);
    const m = buildShip(SHIP_CLASSES[s.classId], shipLoadout(fake), 0);
    this.model = m.root; this.scene.add(m.root);
    this.markers.clear();
    const bad = checkFitting(this.draft.variant, this.draft).bad;
    const L = SHIP_CLASSES[s.classId].length;
    for (const h of lay.hardpoints) {
      const on = this.sel?.kind === 'hp' && this.sel.id === h.id;
      const col = bad[h.id] ? 0xff5a48 : on ? 0xffffff : new THREE.Color(TYPE_COL[h.type]).getHex();
      const r = (h.size === 'L' ? 1.5 : h.size === 'M' ? 1.15 : 0.85) * Math.max(0.8, L / 40) * (on ? 1.7 : 1);
      const mk = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: this.draft.hp[h.id] ? 0.55 : 0.95, depthTest: false }));
      mk.position.set(h.pos[0], h.pos[1] + r * 0.6, h.pos[2]); mk.renderOrder = 5; mk.userData.hp = h.id;
      this.markers.add(mk);
    }
  }

  private draw() {
    const r = this.renderer; if (!r) return;
    const cv = r.domElement; const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * r.getPixelRatio()) || cv.height !== Math.round(h * r.getPixelRatio())) { r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }
    if (this.auto) this.yaw += 0.003;
    const L = SHIP_CLASSES[this.ship?.classId ?? 'cruiser']?.length ?? 60;
    const dist = L * 1.3 + 14;
    this.cam.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * dist, Math.sin(this.pitch) * dist, Math.cos(this.yaw) * Math.cos(this.pitch) * dist);
    this.cam.lookAt(0, 0, 0);
    r.render(this.scene, this.cam);
  }
}

// ── P5 weapon comparison helpers (growth worlds)
const FAMILY_NAME: Record<string, string> = { cannon: '함포', coil: '코일·레일', laser: '레이저', plasma: '플라즈마', particle: '입자', missile: '미사일', torpedo: '어뢰', pd: '방공' };
const ROLE_SHORT: Record<string, string> = { 'anti-small': '대소형', general: '범용', 'anti-capital': '대함', pd: '방공' };
const hexc = (n: number | undefined) => n === undefined ? '#9ab' : `#${n.toString(16).padStart(6, '0')}`;
function famBadge(w: import('../../sim/data/weapons').WeaponDef): string {
  if (!w.family) return '';
  const role = weaponRole(w.id);
  return `<span class="wfam" style="--wc:${hexc(w.vis?.color)}">${FAMILY_NAME[w.family] ?? w.family} ${w.tier ? 'T' + w.tier : ''}</span><span class="wrole wr-${role}">${ROLE_SHORT[role] ?? role}</span> `;
}
/** four bars on a common scale: reach, armour penetration, sustained fire, effect on shields */
function statBars(w: import('../../sim/data/weapons').WeaponDef): string {
  const bar = (label: string, v: number, max: number, cls = '') => `<span class="sb${cls}"><i>${label}</i><b style="width:${Math.max(4, Math.min(100, v / max * 100)).toFixed(0)}%"></b></span>`;
  return `<div class="sbars">${bar('사거리', w.range, 2400)}${bar('관통', w.pen, 125)}${bar('연사', 1 / Math.max(0.1, w.reload), 6)}${bar('대실드', (w.vsShield ?? 1), 1.6, (w.vsShield ?? 1) >= 1 ? ' good' : ' weak')}${bar('선회', w.turnSpeed, 400)}</div>`;
}
function cfxText(c: import('../../content/schema').CombatFx): string {
  const out: string[] = [];
  if (c.shield) out.push(`실드 내구의 ${Math.round(c.shield * 100)}% · 초당 ${((c.shieldRegen ?? 0) * 100).toFixed(1)}% 회복`);
  for (const [k, n] of [['hpMul', '내구'], ['armorMul', '장갑'], ['speedMul', '속도'], ['accMul', '명중'], ['pdMul', '요격']] as const) if (c[k]) out.push(`${n} ${c[k]! >= 1 ? '+' : ''}${Math.round((c[k]! - 1) * 100)}%`);
  if (c.evasion) out.push(`회피 +${Math.round(c.evasion * 100)}%`);
  return out.join(' · ') || '전력 공급';
}
