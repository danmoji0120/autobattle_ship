import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SHIP_CLASSES, shipCost, getLoadout } from '../sim/data/ships';
import { WEAPONS } from '../sim/data/weapons';
import { COMMANDERS, SPECIALTY_TEXT, getCommander } from '../sim/data/commanders';
import { SCENARIOS, getScenario } from '../sim/data/scenarios';
import { fleetCost, defaultPlayerFleet, walk, PLAYER_BUDGET, INITIAL_ORDER_TEXT, validateFleet, type FleetSpec, type GroupSpec, type InitialOrder } from '../sim/fleet';
import { buildShip } from '../render/shipMesh';

const KEY = 'fleetcmd.fleet.v1';
const SKEY = 'fleetcmd.scenario.v1';
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function loadFleet(): FleetSpec {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const f = JSON.parse(raw); if (validateFleet(f)) return f; }
  } catch { /* ignore */ }
  return defaultPlayerFleet();
}
export function saveFleet(f: FleetSpec) { try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* ignore */ } }
export function loadScenarioId(): string { try { return localStorage.getItem(SKEY) ?? 'kestrel'; } catch { return 'kestrel'; } }

export interface SetupResult { fleet: FleetSpec; scenarioId: string }

export class SetupScreen {
  private root: HTMLElement;
  private fleet: FleetSpec;
  private scenarioId: string;
  private sel: GroupSpec;
  private catSel = { classId: 'battleship', loadoutId: 'std' };
  private preview: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; model: THREE.Object3D | null; raf: number } | null = null;
  private onStart: (r: SetupResult) => void;

  constructor(root: HTMLElement, onStart: (r: SetupResult) => void) {
    this.root = root; this.onStart = onStart;
    this.fleet = loadFleet();
    this.scenarioId = loadScenarioId();
    this.sel = this.fleet.root;
    this.render();
  }

  dispose() {
    if (this.preview) { cancelAnimationFrame(this.preview.raf); this.preview.renderer.dispose(); this.preview = null; }
    this.root.innerHTML = '';
  }

  private commit() { saveFleet(this.fleet); this.render(); }

  private render() {
    const f = this.fleet;
    const cost = fleetCost(f);
    const sc = getScenario(this.scenarioId);
    const used = new Map<string, string>();
    walk(f.root, g => { if (g.commanderId) used.set(g.commanderId, g.name); });
    const scroll = this.root.querySelector('#treeScroll')?.scrollTop ?? 0;
    this.root.innerHTML = `
    <div id="setup">
      <div class="shead">
        <div class="logo">FLEET COMMAND // 다중 계층 함대 지휘<big>함대 편성</big></div>
        <div class="scens">${SCENARIOS.map(s => `<div class="panel scen${s.id === this.scenarioId ? ' on' : ''}" data-scen="${s.id}"><span class="df">${'★'.repeat(s.difficulty)}</span><div class="nm">${esc(s.name)}</div><div class="st">${esc(s.subtitle)} · 적 ${countShips(s.enemy)}척</div></div>`).join('')}</div>
      </div>
      <div class="sbody">
        <div class="panel">
          <div class="ptitle"><span>함선 카탈로그</span><span>선택 부대에 추가</span></div>
          <canvas id="preview"></canvas>
          <div class="scroll">${Object.values(SHIP_CLASSES).map(c => this.catalogEntry(c.id)).join('')}</div>
        </div>
        <div class="panel">
          <div class="ptitle"><span>지휘 계통 — ${esc(f.name)}</span><span>부대를 선택하고 함선·지휘관을 배치</span></div>
          <div class="scroll" id="treeScroll" style="padding:8px 12px">${this.groupHtml(f.root, 0, null)}</div>
          <div class="legend">· <b>상급 지휘관에 위임</b>: 상위 지휘관이 상황을 보고 역할(정면 고정 / 측면 우회 / 호위)을 나눠 줍니다. 유능한 제독일수록 협공 타이밍이 정확합니다.<br>· 그 외 명령은 <b>직접 지휘</b>로, 전투 중 언제든 다시 위임할 수 있습니다.</div>
        </div>
        <div class="panel">
          <div class="ptitle"><span>지휘관</span><span>클릭: 선택 부대에 배치</span></div>
          <div class="scroll cmdpick">${COMMANDERS.filter(c => c.team === 0).map(c => `
            <div class="cmdopt${used.has(c.id) ? ' used' : ''}" data-cmd="${c.id}">
              <div class="portrait" style="background:${c.color}">${esc(c.name.replace(/\s/g, '').slice(0, 2))}</div>
              <div><div class="nm">${esc(c.name)} <small>${esc(c.rank)}${used.has(c.id) ? ` · ${esc(used.get(c.id)!)}` : ''}</small></div>
              <div class="tr">판단 ${bar(c.skill)} 공격 ${bar(c.aggression)} 규율 ${bar(c.discipline)}</div>
              <div class="bio">${esc(c.bio)}<br><span style="color:var(--warn)">${SPECIALTY_TEXT[c.specialty]}</span></div></div>
            </div>`).join('')}</div>
        </div>
      </div>
      <div class="sfoot">
        <div class="budget${cost > PLAYER_BUDGET ? ' over' : ''}">${cost} / ${PLAYER_BUDGET}<div style="font-size:10px;color:var(--dim);letter-spacing:.2em">함대 예산</div></div>
        <div class="brief"><b>${esc(sc.name)}</b> — ${esc(sc.brief)}<br><span style="color:var(--cyan)">전술 조언:</span> ${esc(sc.tip)}</div>
        <button class="btn" id="reset">기본 편성 복원</button>
        <button class="btn go" id="go" ${cost > PLAYER_BUDGET || countShips(f) === 0 ? 'disabled' : ''}>출격</button>
      </div>
    </div>`;
    const ts = this.root.querySelector('#treeScroll'); if (ts) ts.scrollTop = scroll;
    this.bind();
    this.setupPreview();
  }

  private catalogEntry(id: string): string {
    const c = SHIP_CLASSES[id];
    const on = this.catSel.classId === id;
    const lo = getLoadout(id, on ? this.catSel.loadoutId : c.loadouts[0].id);
    const arm = (c.armor.front + c.armor.side + c.armor.rear) / 3;
    const fire = lo.mounts.reduce((a, m) => { const w = WEAPONS[m.weapon]; return a + (w.kind === 'pd' ? 0 : w.damage * w.salvo / w.reload); }, 0);
    const pd = lo.mounts.filter(m => WEAPONS[m.weapon].kind === 'pd').length;
    return `<div class="cat${on ? ' on' : ''}" data-cat="${id}">
      <div class="nm">${c.name} ${c.type}<span>${shipCost(id, lo.id)}</span></div>
      <div class="ty">${roleText(c.role)} · 길이 ${c.length}m급</div>
      ${on ? `<div class="stats">
        <span>내구</span><div class="bar"><i style="width:${c.hp / 14000 * 100}%"></i></div>
        <span>장갑</span><div class="bar"><i style="width:${arm / 60 * 100}%"></i></div>
        <span>화력</span><div class="bar"><i style="width:${Math.min(100, fire / 450 * 100)}%"></i></div>
        <span>방공</span><div class="bar"><i style="width:${pd / 10 * 100}%"></i></div>
        <span>속도</span><div class="bar"><i style="width:${c.maxSpeed / 120 * 100}%"></i></div>
      </div>
      <div class="desc">${esc(c.desc)}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px">${c.loadouts.map(l => `<button class="btn mini${l.id === lo.id ? ' on' : ''}" data-lo="${l.id}" title="${esc(l.desc)}" style="padding:3px 8px;font-size:11.5px">${esc(l.name)}</button>`).join('')}</div>
      <div class="desc" style="color:var(--dim)">${esc(lo.desc)}<br>무장: ${weaponSummary(lo.mounts.map(m => m.weapon))}</div>
      <button class="btn" data-add="1" style="margin-top:8px;width:100%">+ ${esc(this.sel.name)}에 추가</button>` : ''}
    </div>`;
  }

  private groupHtml(g: GroupSpec, depth: number, parent: GroupSpec | null): string {
    const cmd = getCommander(g.commanderId);
    const isSel = g === this.sel;
    const orders: InitialOrder[] = parent ? ['auto', 'engage', 'flank_left', 'flank_right', 'escort', 'hold', 'reserve'] : ['engage', 'hold'];
    const id = pathOf(this.fleet.root, g);
    return `<div class="gnode${depth === 0 ? ' root' : ''}" data-g="${id}">
      <div class="ghead${isSel ? ' sel' : ''}" data-gsel="${id}">
        <input class="gname" data-gname="${id}" value="${esc(g.name)}" />
        <span class="portrait" style="width:22px;height:22px;font-size:10px;background:${cmd?.color ?? '#3a4a58'};margin:0;float:none">${cmd ? esc(cmd.name.replace(/\s/g, '').slice(0, 2)) : '—'}</span>
        <span style="font-size:12px;color:${cmd ? 'var(--text)' : 'var(--dim)'}">${cmd ? esc(cmd.rank + ' ' + cmd.name) : '선임 함장'}</span>
        <span class="sp"></span>
        <select data-gorder="${id}" title="초기 명령">${orders.map(o => `<option value="${o}"${g.order === o ? ' selected' : ''}>${INITIAL_ORDER_TEXT[o]}</option>`).join('')}</select>
        <select data-gret="${id}" title="자동 후퇴 기준">${[0, 0.25, 0.5].map(v => `<option value="${v}"${Math.abs(g.retreatAt - v) < 0.01 ? ' selected' : ''}>${v === 0 ? '후퇴 없음' : `전력 ${v * 100}% 후퇴`}</option>`).join('')}</select>
        <button class="btn mini" data-gadd="${id}" title="하위 부대 추가">+ 하위</button>
        ${cmd ? `<button class="btn mini" data-gcmdx="${id}" title="지휘관 해임">해임</button>` : ''}
        ${parent ? `<button class="btn mini danger" data-gdel="${id}" title="부대 해체 (함선은 상위로)">해체</button>` : ''}
      </div>
      ${g.ships.map((s, i) => {
        const c = SHIP_CLASSES[s.classId];
        return `<div class="srow"><span>${c.name} ${c.type}<span class="cl">${esc(getLoadout(s.classId, s.loadoutId).name)}</span></span>
          <select data-slo="${id}:${i}">${c.loadouts.map(l => `<option value="${l.id}"${l.id === s.loadoutId ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
          <select data-smv="${id}:${i}"><option value="">이동…</option>${allGroups(this.fleet.root).filter(x => x !== g).map(x => `<option value="${pathOf(this.fleet.root, x)}">${esc(x.name)}</option>`).join('')}</select>
          <span class="x" data-sdel="${id}:${i}" title="제거">✕</span></div>`;
      }).join('')}
      ${g.children.map(c => this.groupHtml(c, depth + 1, g)).join('')}
    </div>`;
  }

  private bind() {
    const r = this.root;
    const find = (p: string) => groupAt(this.fleet.root, p);
    r.querySelectorAll<HTMLElement>('[data-scen]').forEach(e => e.onclick = () => { this.scenarioId = e.dataset.scen!; try { localStorage.setItem(SKEY, this.scenarioId); } catch { /* */ } this.render(); });
    r.querySelectorAll<HTMLElement>('[data-cat]').forEach(e => e.onclick = ev => {
      const t = ev.target as HTMLElement;
      if (t.dataset.lo) { this.catSel.loadoutId = t.dataset.lo; this.render(); return; }
      if (t.dataset.add) { this.sel.ships.push({ classId: this.catSel.classId, loadoutId: this.catSel.loadoutId }); this.commit(); return; }
      if (this.catSel.classId !== e.dataset.cat) { this.catSel = { classId: e.dataset.cat!, loadoutId: SHIP_CLASSES[e.dataset.cat!].loadouts[0].id }; this.render(); }
    });
    r.querySelectorAll<HTMLElement>('[data-gsel]').forEach(e => e.onclick = ev => {
      if ((ev.target as HTMLElement).closest('select,button,input')) return;
      this.sel = find(e.dataset.gsel!); this.render();
    });
    r.querySelectorAll<HTMLInputElement>('[data-gname]').forEach(e => {
      e.onfocus = () => { this.sel = find(e.dataset.gname!); r.querySelectorAll('.ghead').forEach(x => x.classList.remove('sel')); e.closest('.ghead')!.classList.add('sel'); };
      e.onchange = () => { find(e.dataset.gname!).name = e.value.slice(0, 16) || '부대'; this.commit(); };
    });
    r.querySelectorAll<HTMLSelectElement>('[data-gorder]').forEach(e => e.onchange = () => { find(e.dataset.gorder!).order = e.value as InitialOrder; this.commit(); });
    r.querySelectorAll<HTMLSelectElement>('[data-gret]').forEach(e => e.onchange = () => { find(e.dataset.gret!).retreatAt = Number(e.value); this.commit(); });
    r.querySelectorAll<HTMLElement>('[data-gadd]').forEach(e => e.onclick = () => {
      const g = find(e.dataset.gadd!);
      const ng: GroupSpec = { name: `${g.children.length + 1}편대`, commanderId: null, order: 'auto', retreatAt: 0, ships: [], children: [] };
      g.children.push(ng); this.sel = ng; this.commit();
    });
    r.querySelectorAll<HTMLElement>('[data-gdel]').forEach(e => e.onclick = () => {
      const path = e.dataset.gdel!;
      const g = find(path);
      const parent = find(path.split('.').slice(0, -1).join('.'));
      parent.ships.push(...g.ships);
      parent.children.splice(parent.children.indexOf(g), 1, ...g.children);
      this.sel = parent; this.commit();
    });
    r.querySelectorAll<HTMLElement>('[data-gcmdx]').forEach(e => e.onclick = () => { find(e.dataset.gcmdx!).commanderId = null; this.commit(); });
    r.querySelectorAll<HTMLSelectElement>('[data-slo]').forEach(e => e.onchange = () => { const [p, i] = e.dataset.slo!.split(':'); find(p).ships[Number(i)].loadoutId = e.value; this.commit(); });
    r.querySelectorAll<HTMLSelectElement>('[data-smv]').forEach(e => e.onchange = () => {
      if (!e.value) return;
      const [p, i] = e.dataset.smv!.split(':');
      const from = find(p); const [s] = from.ships.splice(Number(i), 1);
      find(e.value).ships.push(s); this.commit();
    });
    r.querySelectorAll<HTMLElement>('[data-sdel]').forEach(e => e.onclick = () => { const [p, i] = e.dataset.sdel!.split(':'); find(p).ships.splice(Number(i), 1); this.commit(); });
    r.querySelectorAll<HTMLElement>('[data-cmd]').forEach(e => e.onclick = () => {
      const id = e.dataset.cmd!;
      walk(this.fleet.root, g => { if (g.commanderId === id) g.commanderId = null; });
      this.sel.commanderId = id; this.commit();
    });
    (r.querySelector('#reset') as HTMLButtonElement).onclick = () => { this.fleet = defaultPlayerFleet(); this.sel = this.fleet.root; this.commit(); };
    (r.querySelector('#go') as HTMLButtonElement).onclick = () => { saveFleet(this.fleet); this.onStart({ fleet: JSON.parse(JSON.stringify(this.fleet)), scenarioId: this.scenarioId }); };
  }

  private setupPreview(): void {
    const cv = this.root.querySelector('#preview') as HTMLCanvasElement | null;
    if (!cv) return;
    if (!this.preview) {
      const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      const pm = new THREE.PMREMGenerator(renderer);
      scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.5;
      const sun = new THREE.DirectionalLight(0xffe0c0, 2.5); sun.position.set(-3, 4, 2); scene.add(sun);
      const rim = new THREE.DirectionalLight(0x6090ff, 1.5); rim.position.set(3, 1, -4); scene.add(rim);
      scene.add(new THREE.AmbientLight(0x304050, 0.6));
      const cam = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
      this.preview = { renderer, scene, cam, model: null, raf: 0 };
      const loop = (t: number) => {
        const p = this.preview; if (!p) return;
        if (p.model) p.model.rotation.y = t * 0.0004;
        p.renderer.render(p.scene, p.cam);
        p.raf = requestAnimationFrame(loop);
      };
      this.preview.raf = requestAnimationFrame(loop);
    } else {
      // canvas element was re-created by render(): rebind
      const old = this.preview;
      cancelAnimationFrame(old.raf); old.renderer.dispose();
      this.preview = null;
      return this.setupPreview();
    }
    const p = this.preview;
    const w = cv.clientWidth || 320, hgt = cv.clientHeight || 190;
    p.renderer.setSize(w, hgt, false);
    p.cam.aspect = w / hgt; p.cam.updateProjectionMatrix();
    const cls = SHIP_CLASSES[this.catSel.classId];
    const m = buildShip(cls, getLoadout(cls.id, this.catSel.loadoutId), 0);
    for (const e of m.engines) e.plume.scale.z = e.base * 6;
    p.model = m.root;
    p.scene.add(m.root);
    const L = cls.length;
    const D = Math.max(L, 26);
    p.cam.position.set(D * 1.15, D * 0.5, D * 1.15);
    p.cam.lookAt(0, 0, 0);
  }
}

function bar(v: number) { return '▮'.repeat(Math.round(v * 5)) + '▯'.repeat(5 - Math.round(v * 5)); }
function roleText(r: string) { return r === 'line' ? '전열함' : r === 'escort' ? '호위함' : '습격함'; }
function weaponSummary(ws: string[]) {
  const m = new Map<string, number>();
  for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1);
  return [...m].map(([w, n]) => `${WEAPONS[w].name} ×${n}`).join(', ');
}
function countShips(f: FleetSpec) { let n = 0; walk(f.root, g => { n += g.ships.length; }); return n; }
function allGroups(root: GroupSpec): GroupSpec[] { const out: GroupSpec[] = []; walk(root, g => out.push(g)); return out; }
function pathOf(root: GroupSpec, target: GroupSpec): string {
  const rec = (g: GroupSpec, p: string): string | null => { if (g === target) return p; for (let i = 0; i < g.children.length; i++) { const r = rec(g.children[i], p ? `${p}.${i}` : `${i}`); if (r !== null) return r; } return null; };
  return rec(root, '') ?? '';
}
function groupAt(root: GroupSpec, path: string): GroupSpec {
  if (!path) return root;
  let g = root;
  for (const i of path.split('.')) g = g.children[Number(i)];
  return g;
}
