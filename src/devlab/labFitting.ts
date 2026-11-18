// DEV-1.1 copy of src/client/strategic/fittingUi.ts: the same three-column fitting
// screen and 3D preview, backed solely by local experiment drafts rather than world assets.
import * as THREE from 'three';
import { CONTENT, variantLayout, presetsOfHull, variantsOfHull, weaponRole } from '../content/registry';
import { hpAccepts, bayAccepts, weaponType, TYPE_NAME, MOUNT_NAME, BAY_NAME, arcOf, airText } from '../content/rules';
import type { HardpointDef, InternalSlotDef } from '../content/schema';
import { checkFitting, shipLoadout, shipLoadoutKey, bayModules, cpuMountsOf, type ShipFitting } from '../world/fitting';
import { EQUIPMENT, fitFx, growthFx, airFx } from '../world/industry';
import { wingInfo, wingRows, craftSlotText } from '../ui/airWing';
import { WEAPONS, isCraft, craftSummary, type WeaponDef } from '../sim/data/weapons';
import { SHIP_CLASSES } from '../sim/data/ships';
import { buildShip } from '../render/shipMesh';
import { morph } from '../ui/morph';
import type { LabPreset, LabShip } from './labModel';
import { cpuSummary } from '../sim/ai/computer';
import './labFitting.css';

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number) => (Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString();
const sgn = (n: number, d = 0) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(Number(n.toFixed(d))).toLocaleString();
const pct = (m: number) => sgn(Math.round((m - 1) * 100)) + '%';
interface Draft { variant: string; hp: Record<string, string>; bay: Record<string, string> }
type Slot = { kind: 'hp'; id: string } | { kind: 'bay'; id: string };
export const weaponDps = (w: WeaponDef) => w.damage * w.salvo / w.reload;
const TYPE_COL: Record<string, string> = { ballistic: '#ffcf7a', energy: '#9fd6ff', missile: '#ff9f6b', universal: '#d7b8ff', pd: '#7dffb0' };
export interface LabFittingActions { apply: (variant: string, fitting: ShipFitting) => void; close: () => void; clipboard: () => LabPreset | null; copy: (p: LabPreset) => void; presetsChanged: () => void }

export class LabFittingScreen {
  el: HTMLElement;
  private draft: Draft;
  private undo: Draft[] = [];
  private sel: Slot | null = null;
  private q = '';
  private filter = 'fit';
  private sort: 'name' | 'mass' | 'power' | 'dps' | 'range' = 'name';
  private presetName = '';
  private msg: { t: string; warn: boolean } | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  private model: THREE.Object3D | null = null;
  private markers = new THREE.Group();
  private modelKey = '';
  private yaw = .7; private pitch = .42; private drag: { x: number; y: number; distance: number } | null = null; private auto = true;
  private raf = 0;
  private closed = false;

  constructor(private host: HTMLElement, private ship: LabShip, private tech: string[], private presets: LabPreset[], private actions: LabFittingActions) {
    this.el = document.createElement('div'); this.el.className = 'modal fitmodal lab-fitmodal';
    this.el.onclick = e => { if (e.target === this.el) this.close(); };
    host.appendChild(this.el); this.draft = this.fromShip();
    this.el.addEventListener('click', e => this.onClick(e));
    this.el.addEventListener('input', e => this.onInput(e));
    this.el.addEventListener('change', e => this.onInput(e));
    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1a2230, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(300, 400, 200); this.scene.add(sun); this.scene.add(this.markers);
    this.render(); const loop = () => { this.raf = requestAnimationFrame(loop); this.draw(); }; this.raf = requestAnimationFrame(loop);
  }
  private fromShip(): Draft { return { variant: this.ship.variant, hp: { ...this.ship.fitting.hp }, bay: { ...this.ship.fitting.bay } }; }
  private keyOf(d: Draft) { return JSON.stringify([d.variant, Object.entries(d.hp).sort(), Object.entries(d.bay).sort()]); }
  private get dirty() { return this.keyOf(this.draft) !== this.keyOf(this.fromShip()); }
  close() { if (this.closed) return; this.closed = true; cancelAnimationFrame(this.raf); this.renderer?.dispose(); this.renderer?.forceContextLoss(); this.renderer = null; this.el.remove(); this.actions.close(); }
  private edit(fn: (d: Draft) => void) { this.undo.push(structuredClone(this.draft)); if (this.undo.length > 50) this.undo.shift(); fn(this.draft); this.msg = null; this.render(); }
  private plan() { const rep = checkFitting(this.draft.variant, this.draft); return { rep, block: rep.errors[0] ?? null }; }
  private stats(d: Draft) {
    const classId = CONTENT.hulls[this.ship.hull].classId;
    const lo = shipLoadout({ classId, loadoutId: '', variant: d.variant, fitting: { hp: d.hp, bay: d.bay } });
    const mods = bayModules(d.variant, d), fx = fitFx(mods, this.tech), g = growthFx(mods, this.tech), cls = SHIP_CLASSES[classId];
    let dps = 0, pd = 0, range = 0;
    for (const m of lo.mounts) { const w = WEAPONS[m.weapon]; if (w.kind === 'pd') { pd++; continue; } if (isCraft(w)) continue; dps += weaponDps(w); range = Math.max(range, w.range); }   // P16: craft are not gun firepower/range
    return { dps, pd, range: range * fx.rangeMul, guns: lo.mounts.length,
      hp: cls.hp * (lo.hpMul ?? 1) * fx.hpMul * (g.hpMul ?? 1), armor: cls.armor.front * (lo.armorMul ?? 1) * fx.armorMul * (g.armorMul ?? 1),
      speed: cls.maxSpeed * (lo.speedMul ?? 1) * fx.speedMul * (g.speedMul ?? 1), acc: fx.accMul * (g.accMul ?? 1), evasion: fx.evasion + (g.evasion ?? 0),
      air: airFx(mods), wing: wingInfo(lo.mounts, airFx(mods)) };
  }

  private render() {
    const s=this.ship, lay=variantLayout(this.draft.variant)!;
    const hull=lay.hull, cls=SHIP_CLASSES[CONTENT.hulls[s.hull].classId], p=this.plan();
    const now=this.stats(this.fromShip()), nxt=this.stats(this.draft);
    const cmp=(a:number,b:number,d=0,inv=false)=>{const x=b-a;if(Math.abs(x)<1e-6)return '';const good=inv?x<0:x>0;return ` <span class="${good?'up':'dn'}">${sgn(x,d)}</span>`;};
    const bar=(v:number,cap:number,label:string)=>{const f=cap>0?v/cap:0;return `<div class="fbar${f>1?' over':f>.9?' near':''}"><div class="fbl"><span>${label}</span><b>${fmt(v)} / ${fmt(cap)}</b></div><div class="fbt"><i style="width:${Math.min(100,f*100)}%"></i></div></div>`;};
    const selId=this.sel?.id;
    const hpRow=(h:HardpointDef)=>{const eq=this.draft.hp[h.id],cur=s.fitting.hp[h.id],bad=p.rep.bad[h.id],changed=(eq??'')!==(cur??'')?' chg':'';
      return `<button class="fslot${selId===h.id?' on':''}${bad?' bad':''}${changed}" data-fsel="hp:${h.id}" title="${esc(bad??'')}"><span class="fsz" style="border-color:${TYPE_COL[h.type]}">${h.size}</span><span class="fsm"><b>${eq?esc(EQUIPMENT[eq]?.name??eq):'<i class="dim">비어 있음</i>'}</b><small>${esc(h.id)} · ${TYPE_NAME[h.type]} · ${MOUNT_NAME[h.mount]} · ${eq&&WEAPONS[EQUIPMENT[eq]?.weapon??'']?.craft?esc(craftSlotText(WEAPONS[EQUIPMENT[eq].weapon!],nxt.air)):`사각 ${eq?arcOf(h,eq):h.arc}°`}</small></span>${eq?`<span class="fx" data-fclr="hp:${h.id}" title="비우기">✕</span>`:''}</button>`;};
    const bayRow=(b:InternalSlotDef)=>{const eq=this.draft.bay[b.id],cur=s.fitting.bay[b.id],bad=p.rep.bad[b.id],changed=(eq??'')!==(cur??'')?' chg':'';
      return `<button class="fslot${selId===b.id?' on':''}${bad?' bad':''}${changed}" data-fsel="bay:${b.id}" title="${esc(bad??'')}"><span class="fsz bay">${b.size}</span><span class="fsm"><b>${eq?esc(EQUIPMENT[eq]?.name??eq):'<i class="dim">비어 있음</i>'}</b><small>${esc(b.id)} · ${BAY_NAME[b.kind]} 베이${eq&&EQUIPMENT[eq]?.air?` · ${esc(airText(EQUIPMENT[eq].air!))}`:''}</small></span>${eq?`<span class="fx" data-fclr="bay:${b.id}" title="비우기">✕</span>`:''}</button>`;};
    const hullPresets=presetsOfHull(hull.id), myPresets=this.presets.filter(x=>x.hull===hull.id), variants=variantsOfHull(hull.id);
    morph(this.el, `<div class="panel fbox"><div class="shdr"><div><div class="stitle">${esc(hull.name)} <span class="dim" style="font-size:14px">${esc(cls.type)} · ${esc(CONTENT.variants[this.draft.variant]?.name??'')}</span></div><div class="dim">개발자 실험용 피팅 · 모든 장비 사용 가능</div></div><button class="btn" data-fclose>✕</button></div>
      <div class="fgrid"><section class="fcol fleft"><div class="fprev" data-fprev><canvas data-fcanvas></canvas><div class="fhint">드래그: 회전 · 점: 하드포인트 (클릭해 선택)</div></div>
      ${bar(p.rep.power,p.rep.supply,'전력')}${bar(p.rep.mass,p.rep.cap,'적재 질량')}
      <table class="fstat">${nxt.wing?wingRows(now.wing,nxt.wing,`${fmt(nxt.dps)}/s${cmp(now.dps,nxt.dps,1)}`,(a,b)=>cmp(a,b)):`<tr><td>지속 화력</td><td>${fmt(nxt.dps)}/s${cmp(now.dps,nxt.dps,1)}</td><td>최대 사거리</td><td>${fmt(nxt.range)}${cmp(now.range,nxt.range)}</td></tr>`}<tr><td>무장</td><td>${nxt.guns}문${cmp(now.guns,nxt.guns)}</td><td>방공</td><td>${nxt.pd}문${cmp(now.pd,nxt.pd)}</td></tr><tr><td>내구</td><td>${fmt(nxt.hp)}${cmp(now.hp,nxt.hp)}</td><td>전면 장갑</td><td>${fmt(nxt.armor)}${cmp(now.armor,nxt.armor,1)}</td></tr><tr><td>전투 속도</td><td>${fmt(nxt.speed)}${cmp(now.speed,nxt.speed,1)}</td><td>명중·회피</td><td>${pct(nxt.acc)} · ${Math.round(nxt.evasion*100)}%</td></tr></table>
      <div class="frow"><label class="dim">구조 변형</label><select data-fvar>${variants.map(v=>`<option value="${esc(v.id)}"${v.id===this.draft.variant?' selected':''}>${esc(v.name)}${v.mods?` (${[v.mods.hpMul&&`내구 ${pct(v.mods.hpMul)}`,v.mods.armorMul&&`장갑 ${pct(v.mods.armorMul)}`,v.mods.speedMul&&`속도 ${pct(v.mods.speedMul)}`].filter(Boolean).join(' ')})`:''}</option>`).join('')}</select></div></section>
      <section class="fcol fmid"><h3>하드포인트 <span class="dim">${lay.hardpoints.filter(h=>this.draft.hp[h.id]).length}/${lay.hardpoints.length}</span></h3><div class="fslots">${lay.hardpoints.map(hpRow).join('')}</div><h3>내부 베이 <span class="dim">${lay.internals.filter(b=>this.draft.bay[b.id]).length}/${lay.internals.length}</span></h3><div class="fslots">${lay.internals.length?lay.internals.map(bayRow).join(''):'<div class="dim small">내부 베이가 없는 선체</div>'}</div>
      <h3>프리셋</h3><div class="fpre">${hullPresets.map(x=>`<button class="chip" data-fpre="h:${esc(x.id)}" title="${esc(x.desc)}">${esc(x.name)}</button>`).join('')}</div><div class="fpre">${myPresets.map(x=>`<span class="chip mine"><span data-fpre="c:${esc(x.id)}">${esc(x.name)}</span><i data-fdelp="${esc(x.id)}" title="삭제">✕</i></span>`).join('')||'<span class="dim small">저장한 실험 프리셋 없음</span>'}</div>
      <div class="frow"><input data-fpname placeholder="프리셋 이름" maxlength="24" value="${esc(this.presetName)}"><button class="btn" data-fsavep ${p.rep.errors.length?'disabled':''}>현재 초안 저장</button></div><div class="frow"><button class="btn" data-fcopy ${p.rep.errors.length?'disabled':''}>피팅 복사</button><button class="btn" data-fpaste ${this.actions.clipboard()?'':'disabled'}>피팅 붙여넣기</button></div></section>
      <section class="fcol fright">${this.browserHtml(lay)}</section></div><div class="ffoot"><div class="fchg">${p.rep.errors.length?`<div class="warn">${p.rep.errors.map(esc).join('<br>')}</div>`:'<div class="dim">슬롯을 고르고 오른쪽 목록에서 장비를 선택하세요.</div>'}${this.msg?`<div class="${this.msg.warn?'warn':'good'}">${esc(this.msg.t)}</div>`:''}</div><div class="fact"><button class="btn" data-fundo ${this.undo.length?'':'disabled'}>되돌리기</button><button class="btn" data-freset ${this.dirty?'':'disabled'}>초기화</button><button class="btn" data-fclose>취소</button><button class="btn go" data-fapply ${p.block?'disabled':''}>적용</button></div></div></div>`);
    const cv=this.el.querySelector<HTMLCanvasElement>('[data-fcanvas]')!;this.attachPreview(cv);this.syncModel();
  }
  private browserHtml(lay:NonNullable<ReturnType<typeof variantLayout>>) {
    const sel=this.sel, hp=sel?.kind==='hp'?lay.hardpoints.find(h=>h.id===sel.id):undefined, bay=sel?.kind==='bay'?lay.internals.find(b=>b.id===sel.id):undefined;
    const cur=hp?this.draft.hp[hp.id]:bay?this.draft.bay[bay.id]:undefined, q=this.q.trim().toLowerCase();
    let list=Object.values(EQUIPMENT).filter(e=>CONTENT.equipment[e.id]&&!e.exclusive);
    if(this.filter==='fit')list=list.filter(e=>hp?!hpAccepts(hp,e.id):bay?!bayAccepts(bay,e.id):true);else if(this.filter==='weapon')list=list.filter(e=>e.kind==='weapon');else if(this.filter==='module')list=list.filter(e=>e.kind==='module');
    if(q)list=list.filter(e=>`${e.name} ${e.id} ${e.weapon?WEAPONS[e.weapon].name:''}`.toLowerCase().includes(q));
    const dps=(id:string)=>{const w=EQUIPMENT[id]?.weapon;return w?weaponDps(WEAPONS[w]):0;},rng=(id:string)=>{const w=EQUIPMENT[id]?.weapon;return w?WEAPONS[w].range:0;},sp=(id:string)=>CONTENT.equipment[id];
    const key:Record<string,(id:string)=>number>={mass:id=>sp(id).mass,power:id=>sp(id).power,dps:id=>-dps(id),range:id=>-rng(id)};
    list.sort((a,b)=>this.sort==='name'?a.name.localeCompare(b.name,'ko'):key[this.sort](a.id)-key[this.sort](b.id)||a.name.localeCompare(b.name,'ko'));
    const d=(x:number,y:number|undefined,dd=0,inv=false)=>{if(y===undefined)return '';const v=x-y;if(Math.abs(v)<1e-6)return '';return ` <span class="${(inv?v<0:v>0)?'up':'dn'}">${sgn(v,dd)}</span>`;}, c=cur?sp(cur):undefined;
    const row=(id:string)=>{const e=EQUIPMENT[id],s=sp(id),w=e.weapon?WEAPONS[e.weapon]:undefined,why=hp?hpAccepts(hp,id):bay?bayAccepts(bay,id):null,cw=cur&&EQUIPMENT[cur]?.weapon?WEAPONS[EQUIPMENT[cur].weapon!]:undefined;
      const stats=w&&isCraft(w)?`${esc(craftSummary(w))} · ${TYPE_NAME[weaponType(w.id)]}`:w?`${famBadge(w)}화력 ${fmt(weaponDps(w))}/s${d(weaponDps(w),cur?dps(cur):undefined,1)} · 사거리 ${fmt(w.range)}${d(w.range,cur?rng(cur):undefined)} · 관통 ${w.pen}${d(w.pen,cw?.pen)} · ${TYPE_NAME[weaponType(w.id)]}${statBars(w)}`:e.cpu?esc(cpuSummary(e.cpu.arch,cpuMountsOf(lay,this.draft.hp),WEAPONS,e.cpu.react)):e.air?esc(airText(e.air)):e.cfx?esc(cfxText(e.cfx)):esc(e.desc);
      return `<div class="fitem${why?' no':''}${id===cur?' cur':''}" data-fpick="${esc(id)}" title="${esc(why??e.desc)}"><div class="fin"><b>${esc(e.name)}</b><span class="fsz sm">${s.size}</span>${id===cur?'<span class="tag">장착 중</span>':''}</div><div class="fis">${stats}</div><div class="fis dim">질량 ${s.mass}${d(s.mass,c?.mass,0,true)} · 전력 ${s.power<0?`공급 +${-s.power}`:s.power}${d(s.power,c?.power,0,true)}${why?` · <span class="warn">${esc(why)}</span>`:''}</div></div>`;};
    const title=hp?`${hp.id} — ${hp.size} ${TYPE_NAME[hp.type]} ${MOUNT_NAME[hp.mount]}`:bay?`${bay.id} — ${bay.size} ${BAY_NAME[bay.kind]} 베이`:'슬롯을 선택하세요';
    return `<h3>장비 <span class="dim">${esc(title)}</span></h3><div class="frow"><input data-fq placeholder="장비 검색 (이름·종류)" value="${esc(this.q)}"></div><div class="chips">${([['fit','이 슬롯 호환'],['all','전체'],['weapon','무장'],['module','모듈']] as const).map(([v,l])=>`<button class="chip${this.filter===v?' on':''}" data-ffilt="${v}">${l}</button>`).join('')}</div><div class="chips">${([['name','이름'],['dps','화력'],['range','사거리'],['mass','질량'],['power','전력']] as const).map(([v,l])=>`<button class="chip${this.sort===v?' on':''}" data-fsort="${v}">${l}순</button>`).join('')}</div>${cur?`<div class="dim small">현재 장착: <b>${esc(EQUIPMENT[cur]?.name??cur)}</b> — 아래 수치의 <span class="up">+</span>/<span class="dn">−</span>는 이 장비와의 차이</div>`:''}<div class="flist">${list.length?list.map(e=>row(e.id)).join(''):'<div class="dim">조건에 맞는 장비가 없습니다</div>'}</div>`;
  }
  private onInput(e:Event) {
    const t=e.target as HTMLInputElement|HTMLSelectElement;
    if(t.matches('[data-fq]')){this.q=t.value;this.render();}
    else if(t.matches('[data-fpname]'))this.presetName=t.value;
    else if(t.matches('[data-fvar]')&&e.type==='change'){const v=t.value;this.edit(d=>{d.variant=v;const lay=variantLayout(v)!;for(const k of Object.keys(d.hp))if(!lay.hardpoints.some(h=>h.id===k))delete d.hp[k];for(const k of Object.keys(d.bay))if(!lay.internals.some(b=>b.id===k))delete d.bay[k];});}
  }
  private onClick(e:MouseEvent) {
    const t=(e.target as HTMLElement).closest<HTMLElement>('[data-fclose],[data-fclr],[data-fsel],[data-fpick],[data-ffilt],[data-fsort],[data-fpre],[data-fdelp],[data-fsavep],[data-fundo],[data-freset],[data-fapply],[data-fcopy],[data-fpaste]');if(!t)return;const ds=t.dataset;
    if(ds.fclose!==undefined)return this.close();
    if(ds.fclr){e.stopPropagation();const[k,id]=ds.fclr.split(':');this.edit(d=>{delete(k==='hp'?d.hp:d.bay)[id];});return;}
    if(ds.fsel){const[k,id]=ds.fsel.split(':');this.sel={kind:k as 'hp',id};this.filter='fit';this.render();return;}
    if(ds.fpick){const id=ds.fpick,sel=this.sel;if(!sel){this.msg={t:'먼저 하드포인트나 베이를 선택하세요',warn:true};this.render();return;}const lay=variantLayout(this.draft.variant)!,slot=sel.kind==='hp'?lay.hardpoints.find(h=>h.id===sel.id):lay.internals.find(b=>b.id===sel.id);if(!slot){this.msg={t:'선택한 슬롯이 없습니다',warn:true};this.render();return;}const why=sel.kind==='hp'?hpAccepts(slot as HardpointDef,id):bayAccepts(slot as InternalSlotDef,id);if(why){this.msg={t:why,warn:true};this.render();return;}this.edit(d=>{(sel.kind==='hp'?d.hp:d.bay)[sel.id]=id;});return;}
    if(ds.ffilt){this.filter=ds.ffilt;this.render();return;}if(ds.fsort){this.sort=ds.fsort as typeof this.sort;this.render();return;}
    if(ds.fpre){const[k,id]=ds.fpre.split(':');if(k==='h'){const p=CONTENT.presets[id];if(p)this.edit(d=>{d.variant=p.variant;d.hp={...p.weapons};});}else{const p=this.presets.find(x=>x.id===id);if(p)this.edit(d=>{d.variant=p.variant;d.hp={...p.hp};d.bay={...p.bay};});}return;}
    if(ds.fdelp){e.stopPropagation();const index=this.presets.findIndex(p=>p.id===ds.fdelp);if(index>=0)this.presets.splice(index,1);this.actions.presetsChanged();this.render();return;}
    if(ds.fsavep!==undefined){if(this.plan().block)return;this.presets.push(this.preset());this.actions.presetsChanged();this.msg={t:'실험 프리셋 저장됨',warn:false};this.presetName='';this.render();return;}
    if(ds.fcopy!==undefined){if(this.plan().block)return;this.actions.copy(this.preset());this.msg={t:'피팅을 복사했습니다.',warn:false};this.render();return;}
    if(ds.fpaste!==undefined){const p=this.actions.clipboard();if(!p)return;const variant=p.hull===this.ship.hull?p.variant:this.draft.variant;const fit={hp:{...p.hp},bay:{...p.bay}},errors=checkFitting(variant,fit).errors;if(errors.length){this.msg={t:`대상 선체에 적용할 수 없습니다: ${errors.join(' · ')}`,warn:true};this.render();return;}this.edit(d=>{d.variant=variant;d.hp=fit.hp;d.bay=fit.bay;});return;}
    if(ds.fundo!==undefined){const d=this.undo.pop();if(d){this.draft=d;this.msg=null;this.render();}return;}
    if(ds.freset!==undefined){this.edit(d=>Object.assign(d,this.fromShip()));return;}
    if(ds.fapply!==undefined){if(this.plan().block)return;this.actions.apply(this.draft.variant,{hp:{...this.draft.hp},bay:{...this.draft.bay}});this.close();}
  }
  private preset():LabPreset{return {id:`fit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,name:this.presetName.trim().slice(0,24)||'내 피팅',hull:this.ship.hull,variant:this.draft.variant,hp:{...this.draft.hp},bay:{...this.draft.bay}};}
  // ------------------------------------------------------------------ 3D preview

  private attachPreview(cv: HTMLCanvasElement) {
    if (this.renderer?.domElement === cv) return;
    this.renderer?.dispose();
    this.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    cv.onpointerdown = e => { this.drag = { x: e.clientX, y: e.clientY, distance: 0 }; this.auto = false; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => { if (!this.drag) return; const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y; this.yaw -= dx * 0.01; this.pitch = Math.max(-1.2, Math.min(1.3, this.pitch + dy * 0.01)); this.drag = { x: e.clientX, y: e.clientY, distance: this.drag.distance + Math.hypot(dx, dy) }; };
    cv.onpointerup = e => {
      const moved = this.drag && this.drag.distance > 3; this.drag = null;
      if (moved) return;
      // click on a hardpoint marker selects that slot
      const r = cv.getBoundingClientRect();
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.cam);
      const hit = ray.intersectObjects(this.markers.children, false)[0];
      if (hit) { this.sel = { kind: 'hp', id: hit.object.userData.hp }; this.filter = 'fit'; this.render(); }
    };
  }

  private syncModel() {
    const s = this.ship; const lay = variantLayout(this.draft.variant)!;
    const fake = { classId: CONTENT.hulls[s.hull].classId, loadoutId: '', variant: this.draft.variant, fitting: { hp: this.draft.hp, bay: this.draft.bay } };
    const key = shipLoadoutKey(fake) + '|' + (this.sel?.id ?? '') + '|' + Object.keys(checkFitting(this.draft.variant, this.draft).bad).join();
    if (key === this.modelKey) return;
    this.modelKey = key;
    if (this.model) this.scene.remove(this.model);
    const m = buildShip(SHIP_CLASSES[CONTENT.hulls[s.hull].classId], shipLoadout(fake), 0);
    this.model = m.root; this.scene.add(m.root);
    this.markers.clear();
    const bad = checkFitting(this.draft.variant, this.draft).bad;
    const L = SHIP_CLASSES[CONTENT.hulls[s.hull].classId].length;
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
    const L = SHIP_CLASSES[CONTENT.hulls[this.ship.hull].classId]?.length ?? 60;
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
function famBadge(w: import('../sim/data/weapons').WeaponDef): string {
  if (!w.family) return '';
  const role = weaponRole(w.id);
  return `<span class="wfam" style="--wc:${hexc(w.vis?.color)}">${FAMILY_NAME[w.family] ?? w.family} ${w.tier ? 'T' + w.tier : ''}</span><span class="wrole wr-${role}">${ROLE_SHORT[role] ?? role}</span> `;
}
/** four bars on a common scale: reach, armour penetration, sustained fire, effect on shields */
function statBars(w: import('../sim/data/weapons').WeaponDef): string {
  const bar = (label: string, v: number, max: number, cls = '') => `<span class="sb${cls}"><i>${label}</i><b style="width:${Math.max(4, Math.min(100, v / max * 100)).toFixed(0)}%"></b></span>`;
  return `<div class="sbars">${bar('사거리', w.range, 2400)}${bar('관통', w.pen, 125)}${bar('연사', 1 / Math.max(0.1, w.reload), 6)}${bar('대실드', (w.vsShield ?? 1), 1.6, (w.vsShield ?? 1) >= 1 ? ' good' : ' weak')}${bar('선회', w.turnSpeed, 400)}</div>`;
}
function cfxText(c: import('../content/schema').CombatFx): string {
  const out: string[] = [];
  if (c.shield) out.push(`실드 내구의 ${Math.round(c.shield * 100)}% · 초당 ${((c.shieldRegen ?? 0) * 100).toFixed(1)}% 회복`);
  for (const [k, n] of [['hpMul', '내구'], ['armorMul', '장갑'], ['speedMul', '속도'], ['accMul', '명중'], ['pdMul', '요격']] as const) if (c[k]) out.push(`${n} ${c[k]! >= 1 ? '+' : ''}${Math.round((c[k]! - 1) * 100)}%`);
  if (c.evasion) out.push(`회피 +${Math.round(c.evasion * 100)}%`);
  return out.join(' · ') || '전력 공급';
}
