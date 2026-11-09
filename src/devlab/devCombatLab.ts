import './devCombatLab.css';
import { api } from '../client/account';
import { CONTENT, presetsOfHull, variantLayout, variantsOfHull } from '../content/registry';
import { BAY_NAME, MOUNT_NAME, TYPE_NAME } from '../content/rules';
import { EQUIPMENT, TECHS } from '../world/industry';
import { checkFitting } from '../world/fitting';
import { SHIP_CLASSES } from '../sim/data/ships';
import { INITIAL_ORDER_TEXT, type InitialOrder } from '../sim/fleet';
import type { OrderRecord } from '../sim/types';
import { BattleSession } from '../game/session';
import { BattleHUD } from '../ui/battleHud';
import { sfx } from '../audio/sfx';
import { availableHulls, battleSetup, configProblems, defaultConfig, defaultShip, type BattleResult, type Experiment, type LabConfig, type LabShip } from './labModel';

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number, digits = 0) => n.toLocaleString('ko-KR', { maximumFractionDigits: digits });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const weapons = () => Object.keys(CONTENT.equipment).filter(id => EQUIPMENT[id]?.kind === 'weapon' && !!EQUIPMENT[id].weapon);
const modules = () => Object.keys(CONTENT.equipment).filter(id => EQUIPMENT[id]?.kind === 'module');
const research = () => Object.values(TECHS).filter(t => !!t.cfx || t.id === 'combined_arms');
const download = (name: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

class CombatLab {
  private config = defaultConfig();
  private selected: { side: 0 | 1; id: string } = { side: 0, id: 'blue-1' };
  private search = ['', ''];
  private serial = 0;
  private worker: Worker | null = null;
  private result: Experiment | null = null;
  private battle: BattleSession | null = null;
  private hud: BattleHUD | null = null;
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private rendering = false;
  private notice = '';

  constructor(private app: HTMLElement, private getCanvas: () => HTMLCanvasElement, private onExit: () => void) {
    this.timer = setInterval(() => { void this.requireGrant(); }, 30_000);
    this.render();
  }

  private async requireGrant(): Promise<boolean> {
    if (this.disposed) return false;
    try { await api('api/dev-combat/session'); return true; }
    catch { this.dispose(); this.onExit(); return false; }
  }
  private dispose() {
    if (this.disposed) return;
    this.disposed = true; clearInterval(this.timer); this.worker?.terminate(); this.worker = null; this.teardownBattle(); this.app.innerHTML = '';
  }
  private teardownBattle() { this.hud?.dispose(); this.hud = null; this.battle?.dispose(); this.battle = null; sfx.stopMusic(); document.body.classList.remove('devlab-battle'); this.getCanvas().style.visibility = 'hidden'; }
  private current(): LabShip | undefined { return this.config.sides[this.selected.side].ships.find(s => s.id === this.selected.id); }

  private refreshValidation() {
    const problems = configProblems(this.config), panel = this.app.querySelector<HTMLElement>('[data-config-errors]');
    if (panel) { panel.hidden = !problems.length; panel.innerHTML = problems.map(e => `<div>${esc(e)}</div>`).join(''); }
    this.app.querySelectorAll<HTMLButtonElement>('[data-watch],[data-run],[data-run-custom]').forEach(b => { b.disabled = !!problems.length || !!this.worker; });
  }

  private hullOptions(side: number) {
    const q = this.search[side].trim().toLocaleLowerCase();
    return availableHulls().filter(h => `${h.id} ${h.name} ${h.maker ?? ''} ${h.size} ${h.classId} ${SHIP_CLASSES[h.classId]?.type ?? ''}`.toLocaleLowerCase().includes(q))
      .map(h => `<option value="${esc(h.id)}">${esc(h.name)} · ${esc(SHIP_CLASSES[h.classId].type)} · ${h.size} · ${esc(h.id)}</option>`).join('');
  }

  private sideHtml(index: 0 | 1): string {
    const side = this.config.sides[index], color = index ? 'RED' : 'BLUE';
    const rows = side.ships.map(s => {
      const h = CONTENT.hulls[s.hull], selected = this.selected.side === index && this.selected.id === s.id;
      return `<div class="dl-ship ${selected ? 'selected' : ''}"><button class="dl-shipname" data-pick="${index}:${esc(s.id)}"><b>${esc(h?.name ?? s.hull)}</b><span>${esc(CONTENT.variants[s.variant]?.name ?? s.variant)} · ${esc(s.group)}</span></button><span class="dl-count">×${s.count}</span><button class="btn mini" title="복제" data-duplicate="${index}:${esc(s.id)}">복제</button><button class="btn mini" title="삭제" data-remove="${index}:${esc(s.id)}">✕</button></div>`;
    }).join('') || '<p class="dim small">편대가 없습니다. 아래에서 함선을 추가하세요.</p>';
    const commander = side.commander;
    return `<section class="dl-side ${index ? 'red' : 'blue'}"><div class="dl-sidehead"><div><span class="dl-kicker">${color} FLEET</span><h2>${color} 진영</h2></div><button class="btn mini" data-copy="${index}">반대 진영으로 복사 →</button></div>
      <div class="dl-ships">${rows}</div><div class="dl-add"><input data-search="${index}" value="${esc(this.search[index])}" placeholder="선체 ID · 이름 · 제조사 · 크기 · 함급 검색" aria-label="${color} 선체 검색"><select data-hull="${index}" aria-label="${color} 추가할 선체">${this.hullOptions(index)}</select><button class="btn" data-add="${index}">함선 추가</button></div>
      <details class="dl-settings"><summary>지휘관 · 연구 보너스</summary><div class="dl-commander">${(['skill', 'aggression', 'discipline'] as const).map((k, i) => `<label>${['판단력', '공격성', '규율'][i]}<input type="number" min="0" max="1" step="0.05" data-commander="${index}:${k}" value="${commander[k]}"></label>`).join('')}<label>특기<select data-commander="${index}:specialty">${[['none', '없음'], ['tactics', '전술'], ['gunnery', '포술'], ['maneuver', '기동'], ['defense', '방공']].map(([id, label]) => `<option value="${id}"${commander.specialty === id ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <p class="dim small">연구 보너스만 적용합니다. 해금·설계도·재고 조건은 실험에 적용하지 않습니다.</p><div class="dl-research">${research().map(t => `<label><input type="checkbox" data-research="${index}:${esc(t.id)}" ${side.research.includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div></details></section>`;
  }

  private fittingHtml(): string {
    const s = this.current(); if (!s) return '<section class="dl-fit"><p class="dim">편대에서 함선을 선택하세요.</p></section>';
    const h = CONTENT.hulls[s.hull], lay = variantLayout(s.variant); if (!h || !lay) return '<section class="dl-fit">선체 정보를 찾을 수 없습니다.</section>';
    const rep = checkFitting(s.variant, s.fitting);
    const items = (ids: string[], current: string | undefined) => '<option value="">비어 있음</option>' + ids.map(id => `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(EQUIPMENT[id]?.name ?? id)} · ${CONTENT.equipment[id].size} · ${esc(id)}</option>`).join('');
    const slot = (kind: 'hp' | 'bay', id: string, description: string, current?: string) => `<label class="dl-slot"><span><b>${esc(id)}</b> <small>${esc(description)}</small></span><select data-slot="${kind}:${esc(id)}" aria-label="${esc(id)} 장비">${items(kind === 'hp' ? weapons() : modules(), current)}</select>${rep.bad[id] ? `<em>${esc(rep.bad[id])}</em>` : ''}</label>`;
    const presets = presetsOfHull(s.hull).filter(p => p.variant === s.variant);
    return `<section class="dl-fit"><div class="dl-fithead"><div><span class="dl-kicker">${this.selected.side ? 'RED' : 'BLUE'} · FITTING</span><h2>${esc(h.name)} <small>${esc(h.id)}</small></h2><p class="dim small">${esc(h.maker ?? '제조사 미기록')} · ${h.size} · ${esc(SHIP_CLASSES[h.classId]?.type ?? h.classId)}</p></div><div class="dl-meter">전력 <b>${fmt(rep.power)} / ${fmt(rep.supply)}</b><br>질량 <b>${fmt(rep.mass)} / ${fmt(rep.cap)}</b></div></div>
      <div class="dl-fields"><label>파생형<select data-variant>${variantsOfHull(s.hull).map(v => `<option value="${esc(v.id)}"${v.id === s.variant ? ' selected' : ''}>${esc(v.name)} · ${esc(v.id)}</option>`).join('')}</select></label><label>기본 피팅 적용<select data-preset><option value="">프리셋 선택</option>${presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.id)}</option>`).join('')}</select></label><label>편대 이름<input data-row="group" value="${esc(s.group)}" maxlength="40"></label><label>수량<input data-row="count" type="number" min="1" max="200" value="${s.count}"></label><label>초기 명령<select data-row="order">${Object.entries(INITIAL_ORDER_TEXT).map(([id, name]) => `<option value="${id}"${s.order === id ? ' selected' : ''}>${name}</option>`).join('')}</select></label></div>
      ${rep.errors.length ? `<div class="dl-errors" role="alert"><b>피팅 오류 · 전투 시작 불가</b>${rep.errors.map(e => `<div>${esc(e)}</div>`).join('')}</div>` : '<div class="dl-valid">피팅 규칙 통과 · 연구와 자금 제한 없음</div>'}
      <div class="dl-slots"><div><h3>하드포인트 <small>${lay.hardpoints.length}</small></h3>${lay.hardpoints.map(hp => slot('hp', hp.id, `${hp.size} · ${TYPE_NAME[hp.type]} · ${MOUNT_NAME[hp.mount]} · 사각 ${hp.arc}°`, s.fitting.hp[hp.id])).join('') || '<p class="dim">없음</p>'}</div><div><h3>내부 베이 <small>${lay.internals.length}</small></h3>${lay.internals.map(b => slot('bay', b.id, `${b.size} · ${BAY_NAME[b.kind]}`, s.fitting.bay[b.id])).join('') || '<p class="dim">없음</p>'}</div></div></section>`;
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
    if (this.disposed || this.battle || this.rendering) return;
    this.rendering = true;
    try {
    const scroll = this.app.querySelector<HTMLElement>('.dl')?.scrollTop ?? 0;
    const expanded = Array.from(this.app.querySelectorAll<HTMLDetailsElement>('.dl-settings'), d => d.open);
    const active = document.activeElement;
    const attrs = ['data-condition', 'data-commander', 'data-research', 'data-variant', 'data-preset', 'data-row', 'data-slot'];
    const focusAttr = active instanceof HTMLElement && this.app.contains(active) ? attrs.find(a => active.hasAttribute(a)) : undefined;
    const focusValue = focusAttr ? active!.getAttribute(focusAttr) ?? '' : '';
    const errors = configProblems(this.config), c = this.config;
    this.getCanvas().style.visibility = 'hidden';
    this.app.innerHTML = `<main class="dl"><header class="dl-header"><div><span class="dl-kicker">SIDERARIUM / DEVELOPMENT</span><h1>Combat Lab</h1><p>실제 전투 엔진으로 두 함대를 비교합니다. 실험은 브라우저 안에서만 실행됩니다.</p></div><div class="dl-actions"><button class="btn" data-default>기본 비교</button><button class="btn" data-export>설정 내보내기</button><label class="btn dl-file">설정 가져오기<input type="file" accept="application/json,.json" data-import></label><button class="btn" data-logout>실험실 잠금</button></div></header>
      ${this.notice && !this.worker ? `<div class="dl-notice" role="status">${esc(this.notice)}</div>` : ''}<section class="dl-conditions"><div><span class="dl-kicker">EXPERIMENT CONDITIONS</span><h2>전투 조건</h2></div><label>시드<input type="number" min="0" max="2147483647" data-condition="seed" value="${c.seed}"></label><label>기준 거리<input type="number" min="400" max="6000" step="100" data-condition="distance" value="${c.distance}"></label><label>제한 시간 (초)<input type="number" min="10" max="3600" step="10" data-condition="timeLimit" value="${c.timeLimit}"></label><label>관전 배속<select data-condition="speed">${[.5, 1, 2, 4].map(n => `<option value="${n}"${n === c.speed ? ' selected' : ''}>${n}×</option>`).join('')}</select></label><button class="btn" data-swap>진영 교환 ⇄</button></section>
      <div class="dl-fleets">${this.sideHtml(0)}${this.sideHtml(1)}</div>${this.fittingHtml()}
      <section class="dl-run"><div><span class="dl-kicker">RUN EXPERIMENT</span><h2>전투 실행</h2><p class="dim small">반복 횟수는 시드 수입니다. 배치 교환을 선택하면 각 시드를 두 번 실행합니다.</p></div>
      <div class="dl-errors" data-config-errors role="alert" ${errors.length ? '' : 'hidden'}>${errors.map(e => `<div>${esc(e)}</div>`).join('')}</div><div class="dl-runbar"><button class="btn go" data-watch ${errors.length || this.worker ? 'disabled' : ''}>전투 관전</button><button class="btn" data-run="10" ${errors.length || this.worker ? 'disabled' : ''}>10 시드</button><button class="btn" data-run="100" ${errors.length || this.worker ? 'disabled' : ''}>100 시드</button><button class="btn" data-run="1000" ${errors.length || this.worker ? 'disabled' : ''}>1,000 시드</button><label>직접 지정 <input type="number" data-custom min="1" max="10000" value="100"></label><button class="btn" data-run-custom ${errors.length || this.worker ? 'disabled' : ''}>실행</button><label class="dl-check"><input type="checkbox" data-swap-runs checked> 동일 시드 배치 교환</label></div><div id="dlProgress" role="status">${esc(this.notice)}</div><button class="btn" data-cancel ${this.worker ? '' : 'hidden'}>반복 실험 취소</button></section>
      <section class="dl-results"><div class="dl-sidehead"><div><span class="dl-kicker">BATTLE REPORT</span><h2>실험 결과</h2></div><span class="dim small">${esc(c.content.fingerprint)}</span></div>${this.resultHtml()}</section></main>`;
    this.app.onclick = e => { void this.click(e); };
    this.app.onchange = e => { if (!this.rendering) this.change(e); };
    this.app.oninput = e => {
      if (this.rendering) return;
      const target = e.target as HTMLInputElement;
      if (target.dataset.search !== undefined) { const side = Number(target.dataset.search); this.search[side] = target.value; const select = this.app.querySelector<HTMLSelectElement>(`[data-hull="${side}"]`); if (select) select.innerHTML = this.hullOptions(side); }
      else if (target.dataset.condition || target.dataset.commander || target.dataset.row) this.change(e);
    };
    this.app.querySelectorAll<HTMLDetailsElement>('.dl-settings').forEach((d, i) => { d.open = expanded[i] ?? false; });
    const shell = this.app.querySelector<HTMLElement>('.dl'); if (shell) shell.scrollTop = scroll;
    if (focusAttr) this.app.querySelector<HTMLElement>(`[${focusAttr}="${CSS.escape(focusValue)}"]`)?.focus({ preventScroll: true });
    } finally { this.rendering = false; }
  }

  private async click(event: MouseEvent) {
    const button = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!button) return;
    const d = button.dataset;
    if (d.logout !== undefined) { try { await api('api/dev-combat/logout', {}); } finally { this.dispose(); this.onExit(); } return; }
    if (d.default !== undefined) { this.config = defaultConfig(); this.selected = { side: 0, id: 'blue-1' }; this.result = null; this.notice = ''; this.render(); return; }
    if (d.export !== undefined) { download('siderarium-combat-lab.json', this.config); return; }
    if (d.exportResult !== undefined && this.result) { download('siderarium-combat-results.json', this.result); return; }
    if (d.swap !== undefined) { [this.config.sides[0], this.config.sides[1]] = [this.config.sides[1], this.config.sides[0]]; this.config.sides[0].name = 'BLUE'; this.config.sides[1].name = 'RED'; this.selected.side = this.selected.side ? 0 : 1; this.render(); return; }
    if (d.copy !== undefined) { const from = Number(d.copy) as 0 | 1, to = (1 - from) as 0 | 1; this.config.sides[to] = structuredClone(this.config.sides[from]); this.config.sides[to].name = to ? 'RED' : 'BLUE'; this.render(); return; }
    if (d.pick || d.duplicate || d.remove) {
      const [team, id] = (d.pick ?? d.duplicate ?? d.remove)!.split(':'); const side = Number(team) as 0 | 1, ships = this.config.sides[side].ships, index = ships.findIndex(s => s.id === id);
      if (index < 0) return;
      if (d.remove) { ships.splice(index, 1); if (this.selected.id === id && this.selected.side === side) this.selected = { side, id: ships[0]?.id ?? '' }; }
      else if (d.duplicate) { const row = structuredClone(ships[index]); row.id = `ship-${Date.now()}-${this.serial++}`; ships.splice(index + 1, 0, row); this.selected = { side, id: row.id }; }
      else this.selected = { side, id };
      this.render(); return;
    }
    if (d.add !== undefined) { const side = Number(d.add) as 0 | 1, hull = this.app.querySelector<HTMLSelectElement>(`[data-hull="${side}"]`)?.value; if (hull) { const ship = defaultShip(hull, `ship-${Date.now()}-${this.serial++}`); this.config.sides[side].ships.push(ship); this.selected = { side, id: ship.id }; this.render(); } return; }
    if (d.cancel !== undefined) { this.worker?.terminate(); this.worker = null; this.notice = '반복 실험을 취소했습니다.'; this.render(); return; }
    if (d.watch !== undefined) { if (await this.requireGrant()) this.startBattle(structuredClone(this.config), this.config.seed, false); return; }
    if (d.run !== undefined || d.runCustom !== undefined) {
      if (!await this.requireGrant()) return;
      const n = d.run !== undefined ? Number(d.run) : Number(this.app.querySelector<HTMLInputElement>('[data-custom]')?.value);
      const swap = !!this.app.querySelector<HTMLInputElement>('[data-swap-runs]')?.checked;
      this.startBatch(n, swap); return;
    }
    if (d.replay !== undefined || d.replayInput !== undefined) {
      if (!this.result || !await this.requireGrant()) return;
      const i = d.replay !== undefined ? Number(d.replay) : Number(this.app.querySelector<HTMLInputElement>('[data-result-index]')?.value) - 1;
      const r = this.result.battles[i]; if (r) this.startBattle(structuredClone(this.result.config), r.seed, r.swapped); else { this.notice = '존재하지 않는 전투 번호입니다.'; this.render(); }
    }
  }

  private change(event: Event) {
    const el = event.target as HTMLInputElement | HTMLSelectElement;
    if (el.dataset.import !== undefined && el instanceof HTMLInputElement) {
      const file = el.files?.[0]; if (!file) return;
      if (file.size > 2_000_000) { this.notice = '설정 파일은 2 MB를 넘을 수 없습니다.'; this.render(); return; }
      void file.text().then(raw => { try { const next: unknown = JSON.parse(raw), problems = configProblems(next); if (problems.length) throw new Error(problems.join(' · ')); this.config = next as LabConfig; this.selected = { side: 0, id: this.config.sides[0].ships[0].id }; this.result = null; this.notice = '설정을 가져왔습니다.'; } catch (e) { this.notice = `가져오기 실패: ${(e as Error).message}`; } this.render(); }); return;
    }
    if (el.dataset.condition) { (this.config as any)[el.dataset.condition] = Number(el.value); this.refreshValidation(); return; }
    if (el.dataset.commander) { const [team, key] = el.dataset.commander.split(':'); (this.config.sides[Number(team) as 0 | 1].commander as any)[key] = key === 'specialty' ? el.value : Number(el.value); this.refreshValidation(); return; }
    if (el.dataset.research) { const [team, id] = el.dataset.research.split(':'), side = this.config.sides[Number(team) as 0 | 1]; side.research = (el as HTMLInputElement).checked ? [...new Set([...side.research, id])] : side.research.filter(x => x !== id); this.refreshValidation(); return; }
    const ship = this.current(); if (!ship) return;
    if (el.dataset.variant !== undefined) { const fresh = defaultShip(ship.hull, ship.id, el.value); ship.variant = fresh.variant; ship.fitting = fresh.fitting; }
    else if (el.dataset.preset !== undefined) { const p = CONTENT.presets[el.value]; if (p?.variant === ship.variant) ship.fitting.hp = { ...p.weapons }; }
    else if (el.dataset.row) {
      if (el.dataset.row === 'count') ship.count = Number(el.value); else if (el.dataset.row === 'order') ship.order = el.value as InitialOrder; else ship.group = el.value;
      const row = this.app.querySelector<HTMLElement>(`[data-pick="${this.selected.side}:${CSS.escape(ship.id)}"]`);
      const name = row?.querySelector('span'), count = row?.parentElement?.querySelector('.dl-count');
      if (name) name.textContent = `${CONTENT.variants[ship.variant]?.name ?? ship.variant} · ${ship.group}`;
      if (count) count.textContent = `×${ship.count}`;
      this.refreshValidation(); return;
    }
    else if (el.dataset.slot) { const [kind, id] = el.dataset.slot.split(':'), slots = kind === 'hp' ? ship.fitting.hp : ship.fitting.bay; if (el.value) slots[id] = el.value; else delete slots[id]; }
    else return;
    this.render();
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
