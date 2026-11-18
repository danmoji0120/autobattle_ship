// DEV-1.1 copy of src/ui/setup.ts. The three-panel markup, tree and preview are kept
// separate from the game screen; only its local experiment data and actions differ.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SHIP_CLASSES } from '../sim/data/ships';
import { WEAPONS, isShipGun } from '../sim/data/weapons';
import { ACTING_CAPTAIN, COMMANDERS, SPECIALTY_TEXT, type CommanderDef, type Specialty } from '../sim/data/commanders';
import { INITIAL_ORDER_TEXT, type InitialOrder } from '../sim/fleet';
import { CONTENT, variantsOfHull } from '../content/registry';
import { shipLoadout } from '../world/fitting';
import { buildShip } from '../render/shipMesh';
import { allLabGroups, availableHulls, defaultShip, labShipCount, type LabConfig, type LabGroup, type LabShip } from './labModel';
import './labSetup.css';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const ORDERS: InitialOrder[] = ['auto', 'engage', 'flank_left', 'flank_right', 'escort', 'hold', 'reserve', 'retreat'];
const id = () => `lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export interface LabSetupActions { fit: (ship: LabShip, team: 0 | 1) => void; controls: () => void; changed: () => void }

export class LabSetupScreen {
  private team: 0 | 1 = 0;
  private sel: LabGroup;
  private catSel = { hull: 'battleship_mk1', variant: defaultShip('battleship_mk1', 'preview').variant };
  private search = '';
  private quantity = 1;
  private commanderEdit = false;
  private commanderCopy: CommanderDef | null = null;
  private notice = '';
  private rendering = false;
  private preview: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; model: THREE.Object3D | null; raf: number; environment: THREE.Texture; modelKey: string } | null = null;
  constructor(private root: HTMLElement, private config: LabConfig, private actions: LabSetupActions) {
    this.sel = config.sides[0].root;
    this.render();
  }
  dispose() { this.disposePreview(); this.root.innerHTML = ''; }
  private disposePreview() { if (this.preview) { cancelAnimationFrame(this.preview.raf); this.preview.environment.dispose(); this.preview.renderer.dispose(); this.preview.renderer.forceContextLoss(); this.preview = null; } }
  private get fleet() { return this.config.sides[this.team]; }
  private get total() { return labShipCount(this.config.sides[0]) + labShipCount(this.config.sides[1]); }
  private commit() { this.actions.changed(); this.render(); }
  refresh() { this.render(); }
  private render() {
    if (this.rendering) return;
    this.rendering = true;
    try {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) { active.onchange = null; active.oninput = null; }
    const f = this.fleet;
    const scroll = this.root.querySelector('#treeScroll')?.scrollTop ?? 0;
    const catScroll = this.root.querySelector('.lab-catalog')?.scrollTop ?? 0;
    const cmdScroll = this.root.querySelector('.cmdpick')?.scrollTop ?? 0;
    const canvas = this.preview?.renderer.domElement;
    canvas?.remove();
    this.root.innerHTML = `<div id="setup" class="lab-setup">
      <div class="shead"><div class="logo">FLEET COMMAND // 개발자 전투 실험실<big>함대 편성</big></div>
        <div class="scens lab-sides">${([0,1] as const).map(i => `<button class="panel scen${i === this.team ? ' on' : ''}" data-team="${i}"><span class="nm">${i ? 'RED' : 'BLUE'} 함대</span><span class="st"> ${labShipCount(this.config.sides[i])}척</span></button>`).join('')}</div></div>
      <div class="sbody">
        <div class="panel"><div class="ptitle"><span>함선 카탈로그</span><span>선택 부대에 추가</span></div>
          <canvas id="preview"></canvas><div class="lab-search"><input data-lab-search placeholder="이름 · 함급 · 크기 · 제조사 검색" aria-label="함선 검색" value="${esc(this.search)}"></div>
          <div class="scroll lab-catalog">${this.catalogHtml()}</div></div>
        <div class="panel"><div class="ptitle"><span>지휘 계통 — ${esc(f.name)}</span><span>부대를 선택하고 함선·지휘관을 배치</span></div>
          <div class="scroll" id="treeScroll" style="padding:8px 12px">${this.groupHtml(f.root, 0, null)}</div>
          <div class="legend">· <b>상급 지휘관에 위임</b>: 상위 지휘관이 상황을 보고 역할을 나눕니다.<br>· 함선과 지휘관은 각 진영에서 독립적으로 편집됩니다.</div></div>
        <div class="panel"><div class="ptitle"><span>지휘관</span><span>클릭: 선택 부대에 배치</span></div>
          <div class="scroll cmdpick">${this.commanderHtml()}</div></div>
      </div>
      <div class="sfoot"><div class="budget">${this.total} / 200<div style="font-size:10px;color:var(--dim);letter-spacing:.2em">전체 함선</div></div>
        <div class="brief"><b>${esc(this.sel.name)}</b> 선택됨 · 예산, 보유 장비, 연구 해금 제한 없음<br>${esc(this.notice || '피팅과 지휘 계층은 실험에만 사용됩니다.')}</div>
        <button class="btn" data-copy-team="0">BLUE → RED</button><button class="btn" data-copy-team="1">RED → BLUE</button><button class="btn" data-swap-team>진영 교환 ⇄</button>
        <button class="btn go" data-lab-controls>전투 준비</button></div></div>`;
    if (canvas) this.root.querySelector('#preview')?.replaceWith(canvas);
    const ts = this.root.querySelector('#treeScroll'); if (ts) ts.scrollTop = scroll;
    const cs = this.root.querySelector('.lab-catalog'); if (cs) cs.scrollTop = catScroll;
    const ds = this.root.querySelector('.cmdpick'); if (ds) ds.scrollTop = cmdScroll;
    this.bind(); this.setupPreview();
    } finally { this.rendering = false; }
  }
  private catalogHtml() {
    const q = this.search.trim().toLocaleLowerCase();
    return availableHulls().filter(h => `${h.id} ${h.name} ${h.maker ?? ''} ${h.size} ${h.classId} ${SHIP_CLASSES[h.classId].type}`.toLocaleLowerCase().includes(q)).map(h => this.catalogEntry(h.id)).join('') || '<div class="dim" style="padding:12px">검색 결과가 없습니다.</div>';
  }
  private catalogEntry(id: string): string {
    const hull = CONTENT.hulls[id], c = SHIP_CLASSES[hull.classId], on = this.catSel.hull === id;
    const variant = on ? this.catSel.variant : defaultShip(id, 'preview').variant;
    const draft = defaultShip(id, 'preview', variant), lo = shipLoadout({ classId: hull.classId, loadoutId: '', variant, fitting: draft.fitting });
    const arm = (c.armor.front + c.armor.side + c.armor.rear) / 3;
    const fire = lo.mounts.reduce((a, m) => { const w = WEAPONS[m.weapon]; return a + (isShipGun(w) ? w.damage * w.salvo / w.reload : 0); }, 0);   // P16: craft are not gun firepower
    const pd = lo.mounts.filter(m => WEAPONS[m.weapon].kind === 'pd').length;
    return `<div class="cat${on ? ' on' : ''}" data-cat="${esc(id)}"><div class="nm">${esc(hull.name)} <span>${esc(hull.size)}</span></div>
      <div class="ty">${esc(c.type)} · ${esc(hull.maker ?? '')} · 길이 ${c.length}m급 · ${esc(id)}</div>
      ${on ? `<div class="stats"><span>내구</span><div class="bar"><i style="width:${Math.min(100,c.hp / 14000 * 100)}%"></i></div><span>장갑</span><div class="bar"><i style="width:${Math.min(100,arm / 60 * 100)}%"></i></div><span>화력</span><div class="bar"><i style="width:${Math.min(100,fire / 450 * 100)}%"></i></div><span>방공</span><div class="bar"><i style="width:${Math.min(100,pd / 10 * 100)}%"></i></div><span>속도</span><div class="bar"><i style="width:${Math.min(100,c.maxSpeed / 120 * 100)}%"></i></div></div>
      <div class="desc">${esc(c.desc)}</div><div class="lab-variants">${variantsOfHull(id).map(v => `<button class="btn mini${v.id === variant ? ' on' : ''}" data-lo="${esc(v.id)}">${esc(v.name)}</button>`).join('')}</div>
      <div class="desc" style="color:var(--dim)">무장: ${weaponSummary(lo.mounts.map(m => m.weapon))}</div>
      <div class="lab-add"><button class="btn mini" data-add="1">+1</button><button class="btn mini" data-add="5">+5</button><button class="btn mini" data-add="10">+10</button><input type="number" min="1" max="200" data-add-count value="${this.quantity}" aria-label="추가 수량"><button class="btn mini" data-add="custom">추가</button></div><div class="desc">선택 부대: ${esc(this.sel.name)}</div>` : ''}</div>`;
  }
  private groupHtml(g: LabGroup, depth: number, parent: LabGroup | null): string {
    const cmd = g.commander, isSel = g === this.sel, path = pathOf(this.fleet.root, g);
    const destinations = allLabGroups(this.fleet.root).filter(x => x !== g && !allLabGroups(g).includes(x));
    return `<div class="gnode${depth === 0 ? ' root' : ''}" data-g="${esc(path)}"><div class="ghead${isSel ? ' sel' : ''}" data-gsel="${esc(path)}">
      <input class="gname" data-gname="${esc(path)}" value="${esc(g.name)}" maxlength="40" aria-label="부대 이름" />
      <span class="portrait" style="width:22px;height:22px;font-size:10px;background:${cmd?.color ?? '#3a4a58'};margin:0;float:none">${cmd ? esc(cmd.name.replace(/\s/g, '').slice(0,2)) : '—'}</span>
      <span style="font-size:12px;color:${cmd ? 'var(--text)' : 'var(--dim)'}">${cmd ? esc(cmd.rank + ' ' + cmd.name) : '선임 함장'}</span><span class="sp"></span>
      <select data-gorder="${esc(path)}" title="초기 명령">${ORDERS.map(o => `<option value="${o}"${g.order === o ? ' selected' : ''}>${INITIAL_ORDER_TEXT[o]}</option>`).join('')}</select>
      <select data-gret="${esc(path)}" title="자동 후퇴 기준">${[0,0.1,0.25,0.5,0.75].map(v => `<option value="${v}"${Math.abs(g.retreatAt-v)<.001?' selected':''}>${v === 0 ? '후퇴 없음' : `전력 ${v*100}% 후퇴`}</option>`).join('')}</select>
      <button class="btn mini" data-gadd="${esc(path)}" title="하위 부대 추가">+ 하위</button>${cmd ? `<button class="btn mini" data-gcmdx="${esc(path)}">해임</button>` : ''}
      ${parent ? `<select data-gmove="${esc(path)}" title="상급 부대 변경"><option value="">상급 변경…</option>${destinations.map(x => `<option value="@${esc(pathOf(this.fleet.root,x))}">${esc(x.name)}</option>`).join('')}</select><button class="btn mini danger" data-gdel="${esc(path)}">해체</button>` : ''}</div>
      ${g.ships.map((s,i) => { const h=CONTENT.hulls[s.hull]; return `<div class="srow lab-srow"><span>${esc(h?.name ?? s.hull)} <span class="cl">${esc(CONTENT.variants[s.variant]?.name ?? s.variant)}</span></span><label>× <input type="number" data-scount="${esc(path)}:${i}" min="1" max="200" value="${s.count}" aria-label="함선 수량"></label><button class="btn mini" data-sfit="${esc(path)}:${i}">피팅</button><button class="btn mini" data-sclone="${esc(path)}:${i}">복제</button><select data-smv="${esc(path)}:${i}" aria-label="부대 이동"><option value="">이동…</option>${allLabGroups(this.fleet.root).filter(x=>x!==g).map(x=>`<option value="@${esc(pathOf(this.fleet.root,x))}">${esc(x.name)}</option>`).join('')}</select><span class="x" data-sdel="${esc(path)}:${i}" title="제거" role="button" tabindex="0">✕</span></div>`; }).join('')}
      ${g.children.map(c => this.groupHtml(c, depth+1, g)).join('')}</div>`;
  }
  private commanderHtml() {
    const selected = this.sel.commander;
    const editor = this.commanderEdit && selected ? `<div class="cmdopt lab-cmd-edit"><div class="portrait" style="background:${selected.color}">${esc(selected.name.slice(0,2))}</div><div><div class="nm">지휘관 편집</div>
      <label>이름 <input data-cfield="name" value="${esc(selected.name)}" maxlength="40"></label>
      ${(['skill','aggression','discipline'] as const).map((k,i)=>`<label>${['판단력','공격성','규율'][i]} <input type="number" min="0" max="1" step="0.05" data-cfield="${k}" value="${selected[k]}"></label>`).join('')}
      <label>전문 분야 <select data-cfield="specialty">${Object.entries(SPECIALTY_TEXT).map(([k,v])=>`<option value="${k}"${selected.specialty===k?' selected':''}>${esc(v)}</option>`).join('')}</select></label><button class="btn mini" data-cdone>완료</button></div></div>` : '';
    return `<div class="lab-cmd-actions"><button class="btn mini" data-cnew>커스텀 생성</button>${selected ? '<button class="btn mini" data-cedit>선택 지휘관 편집</button><button class="btn mini" data-cclone>지휘관 복제</button><button class="btn mini" data-cnone>지휘관 없음</button>' : ''}${this.commanderCopy ? '<button class="btn mini" data-cpaste>복제 지휘관 배치</button>' : ''}</div>${editor}
      ${COMMANDERS.map(c => `<div class="cmdopt" data-cmd="${esc(c.id)}"><div class="portrait" style="background:${c.color}">${esc(c.name.replace(/\s/g,'').slice(0,2))}</div><div><div class="nm">${esc(c.name)} <small>${esc(c.rank)}</small></div><div class="tr">판단 ${bar(c.skill)} 공격 ${bar(c.aggression)} 규율 ${bar(c.discipline)}</div><div class="bio">${esc(c.bio)}<br><span style="color:var(--warn)">${esc(SPECIALTY_TEXT[c.specialty])}</span></div></div></div>`).join('')}`;
  }
  private bind() {
    const r=this.root, find=(p:string)=>groupAt(this.fleet.root,p), row=(v:string)=>{ const i=v.lastIndexOf(':'); return { g:find(v.slice(0,i)), n:Number(v.slice(i+1)) }; };
    r.querySelectorAll<HTMLElement>('[data-team]').forEach(e=>e.onclick=()=>{this.team=Number(e.dataset.team) as 0|1;this.sel=this.fleet.root;this.commanderEdit=false;this.notice='';this.render();});
    const search=r.querySelector<HTMLInputElement>('[data-lab-search]')!; search.oninput=()=>{this.search=search.value; const list=r.querySelector<HTMLElement>('.lab-catalog')!; list.innerHTML=this.catalogHtml(); this.bindCatalog();};
    this.bindCatalog();
    r.querySelectorAll<HTMLElement>('[data-gsel]').forEach(e=>e.onclick=ev=>{if((ev.target as HTMLElement).closest('select,button,input'))return;this.sel=find(e.dataset.gsel!);this.commanderEdit=false;this.render();});
    r.querySelectorAll<HTMLInputElement>('[data-gname]').forEach(e=>{e.onfocus=()=>{const group=find(e.dataset.gname!);if(this.sel!==group){this.sel=group;this.commanderEdit=false;const panel=r.querySelector<HTMLElement>('.cmdpick');if(panel){panel.innerHTML=this.commanderHtml();this.bindCommanders();}}r.querySelectorAll('.ghead').forEach(x=>x.classList.remove('sel'));e.closest('.ghead')?.classList.add('sel');};e.onchange=()=>{find(e.dataset.gname!).name=e.value.trim().slice(0,40)||'부대';this.actions.changed();};});
    r.querySelectorAll<HTMLSelectElement>('[data-gorder]').forEach(e=>e.onchange=()=>{find(e.dataset.gorder!).order=e.value as InitialOrder;this.commit();});
    r.querySelectorAll<HTMLSelectElement>('[data-gret]').forEach(e=>e.onchange=()=>{find(e.dataset.gret!).retreatAt=Number(e.value);this.commit();});
    r.querySelectorAll<HTMLElement>('[data-gadd]').forEach(e=>e.onclick=()=>{const g=find(e.dataset.gadd!);const ng:LabGroup={name:`${g.children.length+1}편대`,commander:null,order:'auto',retreatAt:0,ships:[],children:[]};g.children.push(ng);this.sel=ng;this.commit();});
    r.querySelectorAll<HTMLElement>('[data-gdel]').forEach(e=>e.onclick=()=>{const path=e.dataset.gdel!,g=find(path),parent=find(path.split('.').slice(0,-1).join('.'));parent.ships.push(...g.ships);parent.children.splice(parent.children.indexOf(g),1,...g.children);this.sel=parent;this.commit();});
    r.querySelectorAll<HTMLElement>('[data-gcmdx]').forEach(e=>e.onclick=()=>{find(e.dataset.gcmdx!).commander=null;this.commanderEdit=false;this.commit();});
    r.querySelectorAll<HTMLSelectElement>('[data-gmove]').forEach(e=>e.onchange=()=>{if(!e.value)return;const path=e.dataset.gmove!,g=find(path),parent=find(path.split('.').slice(0,-1).join('.')),dest=find(e.value.slice(1));if(g===dest||allLabGroups(g).includes(dest))return;parent.children.splice(parent.children.indexOf(g),1);dest.children.push(g);this.sel=g;this.commit();});
    r.querySelectorAll<HTMLInputElement>('[data-scount]').forEach(e=>e.onchange=()=>{const {g,n}=row(e.dataset.scount!),v=Number(e.value), old=g.ships[n].count;if(!Number.isInteger(v)||v<1||this.total-old+v>200){this.notice='전체 함선은 1~200척이어야 합니다.';this.render();return;}g.ships[n].count=v;this.actions.changed();const b=r.querySelector('.budget');if(b?.firstChild)b.firstChild.textContent=`${this.total} / 200`;});
    r.querySelectorAll<HTMLElement>('[data-sfit]').forEach(e=>e.onclick=()=>{const {g,n}=row(e.dataset.sfit!);this.actions.fit(g.ships[n],this.team);});
    r.querySelectorAll<HTMLElement>('[data-sclone]').forEach(e=>e.onclick=()=>{const {g,n}=row(e.dataset.sclone!),s=g.ships[n];if(this.total+s.count>200){this.notice='전투당 최대 200척입니다.';this.render();return;}const copy=structuredClone(s);copy.id=id();g.ships.splice(n+1,0,copy);this.commit();});
    r.querySelectorAll<HTMLSelectElement>('[data-smv]').forEach(e=>e.onchange=()=>{if(!e.value)return;const {g,n}=row(e.dataset.smv!),target=find(e.value.slice(1)),[s]=g.ships.splice(n,1);target.ships.push(s);this.sel=target;this.commit();});
    r.querySelectorAll<HTMLElement>('[data-sdel]').forEach(e=>e.onclick=()=>{const {g,n}=row(e.dataset.sdel!);g.ships.splice(n,1);this.commit();});
    this.bindCommanders();
    const click=(s:string,fn:()=>void)=>{const el=r.querySelector<HTMLElement>(s);if(el)el.onclick=fn;};
    r.querySelectorAll<HTMLElement>('[data-copy-team]').forEach(e=>e.onclick=()=>{const from=Number(e.dataset.copyTeam) as 0|1,to=(1-from) as 0|1;if(labShipCount(this.config.sides[from])*2>200){this.notice='복사하면 전체 함선 200척을 초과합니다.';this.render();return;}this.config.sides[to]=structuredClone(this.config.sides[from]);if(this.config.sides[to].root.name===this.config.sides[from].name)this.config.sides[to].root.name=to?'RED':'BLUE';this.config.sides[to].name=to?'RED':'BLUE';this.sel=this.fleet.root;this.commit();});
    click('[data-swap-team]',()=>{[this.config.sides[0],this.config.sides[1]]=[this.config.sides[1],this.config.sides[0]];for(const i of [0,1] as const){const side=this.config.sides[i],name=i?'RED':'BLUE';if(side.root.name===side.name)side.root.name=name;side.name=name;}this.team=(1-this.team) as 0|1;this.sel=this.fleet.root;this.commit();});
    click('[data-lab-controls]',()=>this.actions.controls());
  }
  private bindCommanders() {
    const r=this.root;
    const click=(s:string,fn:()=>void)=>{const el=r.querySelector<HTMLElement>(s);if(el)el.onclick=fn;};
    r.querySelectorAll<HTMLElement>('[data-cmd]').forEach(e=>e.onclick=()=>{const cmd=COMMANDERS.find(c=>c.id===e.dataset.cmd);if(cmd){this.sel.commander=structuredClone(cmd);this.commanderEdit=false;this.commit();}});
    click('[data-cnew]',()=>{this.sel.commander={...ACTING_CAPTAIN,id:id(),name:'새 지휘관',team:this.team};this.commanderEdit=true;this.commit();});
    click('[data-cedit]',()=>{this.commanderEdit=true;this.render();});
    click('[data-cclone]',()=>{if(this.sel.commander){this.commanderCopy=structuredClone(this.sel.commander);this.notice='복제할 부대를 선택한 뒤 지휘관을 배치하세요.';this.render();}});
    click('[data-cpaste]',()=>{if(this.commanderCopy){this.sel.commander={...structuredClone(this.commanderCopy),id:id()};this.notice='지휘관을 복제했습니다.';this.commit();}});
    click('[data-cnone]',()=>{this.sel.commander=null;this.commanderEdit=false;this.commit();});
    click('[data-cdone]',()=>{this.commanderEdit=false;this.commit();});
    r.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-cfield]').forEach(e=>e.onchange=()=>{const cmd=this.sel.commander;if(!cmd)return;const k=e.dataset.cfield!;if(k==='name')cmd.name=e.value.trim().slice(0,40)||'지휘관';else if(k==='specialty')cmd.specialty=e.value as Specialty;else (cmd as any)[k]=Math.max(0,Math.min(1,Number(e.value)||0));this.actions.changed();});
  }
  private bindCatalog() {
    this.root.querySelectorAll<HTMLElement>('[data-cat]').forEach(e=>e.onclick=ev=>{const t=ev.target as HTMLElement,hull=e.dataset.cat!;
      if(t.dataset.lo){this.catSel={hull,variant:t.dataset.lo};this.render();return;}
      if(t.dataset.add){const value=t.dataset.add==='custom'?Number(this.root.querySelector<HTMLInputElement>('[data-add-count]')?.value):Number(t.dataset.add);if(!Number.isInteger(value)||value<1||this.total+value>200){this.notice='전투당 함선은 최대 200척입니다.';this.render();return;}this.quantity=value;const ship=defaultShip(hull,id(),this.catSel.variant);ship.count=value;this.sel.ships.push(ship);this.notice='';this.commit();return;}
      if(t.matches('input'))return;if(this.catSel.hull!==hull){this.catSel={hull,variant:defaultShip(hull,'preview').variant};this.render();}
    });
  }
  private setupPreview(): void {
    const cv=this.root.querySelector<HTMLCanvasElement>('#preview');if(!cv)return;
    if (!this.preview) {
      const renderer=new THREE.WebGLRenderer({canvas:cv,antialias:true,alpha:true});renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;
      const scene=new THREE.Scene(),pm=new THREE.PMREMGenerator(renderer),environment=pm.fromScene(new RoomEnvironment(),.04).texture;scene.environment=environment;scene.environmentIntensity=.5;pm.dispose();
      const sun=new THREE.DirectionalLight(0xffe0c0,2.5);sun.position.set(-3,4,2);scene.add(sun);const rim=new THREE.DirectionalLight(0x6090ff,1.5);rim.position.set(3,1,-4);scene.add(rim);scene.add(new THREE.AmbientLight(0x304050,.6));
      const cam=new THREE.PerspectiveCamera(35,1,.5,2000);this.preview={renderer,scene,cam,model:null,raf:0,environment,modelKey:''};
      const loop=(t:number)=>{const p=this.preview;if(!p)return;const w=cv.clientWidth||320,h=cv.clientHeight||190;if(cv.width!==w||cv.height!==h){p.renderer.setSize(w,h,false);p.cam.aspect=w/h;p.cam.updateProjectionMatrix();}if(p.model)p.model.rotation.y=t*.0004;p.renderer.render(p.scene,p.cam);p.raf=requestAnimationFrame(loop);};this.preview.raf=requestAnimationFrame(loop);
    }
    const p=this.preview, key=`${this.catSel.hull}:${this.catSel.variant}:${this.team}`;
    if (p.modelKey===key) return;
    p.modelKey=key; if(p.model)p.scene.remove(p.model);
    const h=CONTENT.hulls[this.catSel.hull],cls=SHIP_CLASSES[h.classId],draft=defaultShip(h.id,'preview',this.catSel.variant),lo=shipLoadout({classId:h.classId,loadoutId:'',variant:draft.variant,fitting:draft.fitting});
    const m=buildShip(cls,lo,this.team);for(const e of m.engines)e.plume.scale.z=e.base*6;p.model=m.root;p.scene.add(m.root);const d=Math.max(cls.length,26);p.cam.position.set(d*1.15,d*.5,d*1.15);p.cam.lookAt(0,0,0);
  }
}
function bar(v:number){return '▮'.repeat(Math.round(v*5))+'▯'.repeat(5-Math.round(v*5));}
function weaponSummary(ws:string[]){const m=new Map<string,number>();for(const w of ws)m.set(w,(m.get(w)??0)+1);return [...m].map(([w,n])=>`${esc(WEAPONS[w].name)} ×${n}`).join(', ');}
function pathOf(root:LabGroup,target:LabGroup):string{const rec=(g:LabGroup,p:string):string|null=>{if(g===target)return p;for(let i=0;i<g.children.length;i++){const r=rec(g.children[i],p?`${p}.${i}`:`${i}`);if(r!==null)return r;}return null;};return rec(root,'')??'';}
function groupAt(root:LabGroup,path:string):LabGroup{if(!path)return root;let g=root;for(const i of path.split('.'))g=g.children[Number(i)];return g;}
