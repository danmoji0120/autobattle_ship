// Account screens for the shared world: sign in / sign up / recovery, PMC creation, account panel.
// The session lives in an HttpOnly cookie set by the server; this code never sees or stores it.

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const base = () => location.pathname.replace(/[^/]*$/, '');

export interface Me { account: { id: string; loginId: string; createdAt: number; lastLogin: number | null }; company: { id: string; name: string } | null }

export class ApiError extends Error { constructor(msg: string, public status: number, public code?: string) { super(msg); } }

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(base() + path, body === undefined ? { credentials: 'same-origin', cache: 'no-store' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new ApiError('서버에 연결할 수 없습니다. 네트워크를 확인하세요', 0, 'NETWORK'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error ?? `오류 (${r.status})`, r.status, j.code);
  return j as T;
}

/** null = not signed in; throws ApiError(status 0) when the server cannot be reached */
export async function fetchMe(): Promise<Me | null> {
  try { return await api<Me>('api/auth/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
}

const fmtDate = (t: number | null) => t ? new Date(t).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const field = (id: string, label: string, type = 'text', extra = '') =>
  `<label class="afield"><span>${label}</span><input id="${id}" type="${type}" ${extra} /></label>`;

/** sign in / sign up / recovery. `onDone` runs once a session cookie is set. */
export function showAuth(app: HTMLElement, o: { onDone: (me: Me) => void; onBack: () => void; notice?: string; tab?: 'login' | 'signup' | 'recover' }) {
  let tab = o.tab ?? 'login';
  let notice = o.notice ?? '';
  const render = () => {
    app.innerHTML = `<div id="menu"><div class="panel mbox abox">
      <div class="mlogo">SIDERARIUM</div>
      <div class="msub">공유 세계 — 계정</div>
      ${notice ? `<div class="anotice">${esc(notice)}</div>` : ''}
      <div class="atabs">${([['login', '로그인'], ['signup', '회원가입'], ['recover', '계정 복구']] as const).map(([k, l]) => `<button class="btn${tab === k ? ' on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <form class="aform" id="aform" autocomplete="on">
        ${tab === 'login' ? `
          ${field('aId', '로그인 ID', 'text', 'autocomplete="username" maxlength="20" autocapitalize="off" spellcheck="false"')}
          ${field('aPw', '비밀번호', 'password', 'autocomplete="current-password" maxlength="128"')}`
        : tab === 'signup' ? `
          ${field('aId', '로그인 ID', 'text', 'autocomplete="username" maxlength="20" autocapitalize="off" spellcheck="false" placeholder="영문 소문자·숫자·_ 3~20자"')}
          ${field('aPw', '비밀번호', 'password', 'autocomplete="new-password" maxlength="128" placeholder="8자 이상"')}
          ${field('aPw2', '비밀번호 확인', 'password', 'autocomplete="new-password" maxlength="128"')}
          <div class="dim small">PMC 이름은 가입 후 따로 정합니다. 가입하면 <b>복구 코드</b>가 한 번 표시됩니다 — 비밀번호를 잊었을 때 필요하니 꼭 보관하세요. 이메일은 받지 않습니다.</div>`
        : `
          ${field('aId', '로그인 ID', 'text', 'autocomplete="username" maxlength="20" autocapitalize="off" spellcheck="false"')}
          ${field('aCode', '복구 코드', 'text', 'autocomplete="off" maxlength="40" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" spellcheck="false"')}
          ${field('aPw', '새 비밀번호', 'password', 'autocomplete="new-password" maxlength="128"')}
          ${field('aPw2', '새 비밀번호 확인', 'password', 'autocomplete="new-password" maxlength="128"')}
          <div class="dim small">가입할 때 받은 복구 코드로 비밀번호를 재설정합니다. 재설정하면 모든 기기에서 로그아웃되고 새 복구 코드가 발급됩니다.</div>`}
        <div class="aerr" id="aErr"></div>
        <div class="mrow"><button class="btn go" type="submit" id="aGo">${tab === 'login' ? '로그인' : tab === 'signup' ? '가입하기' : '비밀번호 재설정'}</button><button class="btn" type="button" id="aBack">메인 메뉴</button></div>
      </form>
    </div></div>`;
    app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab as typeof tab; notice = ''; render(); });
    (app.querySelector('#aBack') as HTMLButtonElement).onclick = () => o.onBack();
    const v = (id: string) => (app.querySelector('#' + id) as HTMLInputElement | null)?.value ?? '';
    const err = (m: string) => { (app.querySelector('#aErr') as HTMLElement).textContent = m; };
    (app.querySelector('#aId') as HTMLInputElement).focus();
    const form = app.querySelector('#aform') as HTMLFormElement;
    form.onsubmit = async ev => {
      ev.preventDefault();
      const go = app.querySelector('#aGo') as HTMLButtonElement;
      err('');
      if (tab !== 'login' && v('aPw') !== v('aPw2')) return err('비밀번호 확인이 일치하지 않습니다');
      go.disabled = true;
      try {
        if (tab === 'login') o.onDone(await api<Me>('api/auth/login', { loginId: v('aId'), password: v('aPw') }));
        else if (tab === 'signup') {
          const r = await api<Me & { recoveryCode: string }>('api/auth/signup', { loginId: v('aId'), password: v('aPw'), confirm: v('aPw2') });
          showCode(app, r.recoveryCode, '가입 완료', () => o.onDone(r));
        } else {
          const r = await api<Me & { recoveryCode: string }>('api/auth/recover', { loginId: v('aId'), code: v('aCode'), next: v('aPw'), confirm: v('aPw2') });
          showCode(app, r.recoveryCode, '비밀번호 재설정 완료 — 새 복구 코드', () => o.onDone(r));
        }
      } catch (e) { err((e as Error).message); go.disabled = false; }
    };
  };
  render();
}

function showCode(app: HTMLElement, code: string, title: string, next: () => void) {
  app.innerHTML = `<div id="menu"><div class="panel mbox abox">
    <div class="mlogo">SIDERARIUM</div><div class="msub">${esc(title)}</div>
    <div class="mdesc">아래 <b>복구 코드</b>는 비밀번호를 잊었을 때 계정을 되찾는 유일한 수단입니다. 지금 한 번만 표시되며 서버에도 원문이 남지 않습니다. 안전한 곳에 적어 두세요.</div>
    <div class="acode" id="aCodeShow">${esc(code)}</div>
    <div class="mrow"><button class="btn" id="aCopy">복사</button><label class="dim small"><input type="checkbox" id="aKept" /> 복구 코드를 보관했습니다</label></div>
    <div class="mrow"><button class="btn go" id="aNext" disabled>계속</button></div>
  </div></div>`;
  (app.querySelector('#aCopy') as HTMLButtonElement).onclick = () => { navigator.clipboard?.writeText(code).catch(() => {}); };
  const kept = app.querySelector('#aKept') as HTMLInputElement, nx = app.querySelector('#aNext') as HTMLButtonElement;
  kept.onchange = () => { nx.disabled = !kept.checked; };
  nx.onclick = () => next();
}

/** first sign-in in this world: name the PMC (or carry over the one this browser used before accounts) */
type StartTerms = { credits: number; station: string; backgrounds?: BgTerm[] };
type BgTerm = {
  id: string; name: string; desc: string; faction: string; factionName: string; factionColor: string; system: string; station: string;
  ships: { name: string; role: string; n: number; military: boolean }[]; commander?: string; credits: number;
  standing: { faction: string; name: string; value: number; band: string }[]; upkeep: number; value: number; hours: number;
  activities: string[]; difficulty: string; notes: string[];
};
const cr = (n: number) => `${Math.round(n).toLocaleString('en-US')} cr`;
const DIFF_CLASS: Record<string, string> = { '낮음': 'd1', '보통': 'd2', '높음': 'd3', '매우 높음': 'd4' };
/** A-3.1: everything shown here comes from the server's terms — what the chosen background really grants */
function bgDetail(b: BgTerm): string {
  const sign = (v: number) => v > 0 ? `+${v}` : `${v}`;
  return `<div class="bgdet" data-bg-detail="${esc(b.id)}">
    <div class="bgdh"><b>${esc(b.name)}</b><span class="bgfac" style="--fc:${esc(b.factionColor)}">${esc(b.factionName)}</span><span class="bgdiff ${DIFF_CLASS[b.difficulty] ?? ''}">난이도 ${esc(b.difficulty)}</span></div>
    <div class="bgdesc">${esc(b.desc)}</div>
    <div class="bggrid">
      <div><span>시작 위치</span><b>${esc(b.system)} 성계 · ${esc(b.station)}</b></div>
      <div><span>시작 자금</span><b data-bg-credits="${b.credits}">${cr(b.credits)}</b></div>
      <div><span>함선</span><b>${b.ships.map(s => `${esc(s.name)} ×${s.n} <i>(${esc(s.role)})</i>`).join('<br>')}</b></div>
      <div><span>지휘관</span><b>${b.commander ? esc(b.commander) : '없음'}</b></div>
      <div><span>예상 운영비</span><b data-bg-upkeep="${b.upkeep}">시간당 약 ${cr(b.upkeep)}</b><i>정박 기준 · 자금으로 약 ${b.hours}시간</i></div>
      <div><span>함대 가치</span><b>${cr(b.value)}</b><i>조선소 정가 기준</i></div>
      <div><span>초기 세력 신뢰도</span><b>${b.standing.map(x => `${esc(x.name)} ${sign(x.value)} <i>(${esc(x.band)})</i>`).join('<br>')}</b><i>나머지 세력 0 (중립)</i></div>
      <div><span>추천 활동</span><b>${b.activities.map(esc).join('<br>')}</b></div>
    </div>
    <ul class="bgnotes">${b.notes.map(n => `<li>${esc(n)}</li>`).join('')}<li>출신은 시작 조건일 뿐이다 — 이후 어떤 활동·세력·함선도 막지 않는다.</li></ul>
  </div>`;
}

export function showPmcCreate(host: HTMLElement, o: { loginId: string; legacy: boolean; start?: StartTerms; onSubmit: (name: string, legacy: boolean, background?: string) => void; onLogout: () => void }) {
  let el = host.querySelector('#pmcCreate') as HTMLElement | null;
  if (!el) { el = document.createElement('div'); el.id = 'pmcCreate'; host.appendChild(el); }
  const bgs = o.start?.backgrounds ?? [];
  // the server states what this world gives (an older server sends nothing: then no amount is promised)
  const where = o.start?.station ? `${esc(o.start.station)}에 등록되고` : '모항에 등록되고';
  const funds = o.start ? `운영 자금 ${Math.round(o.start.credits).toLocaleString('en-US')} cr` : '운영 자금';
  const intro = bgs.length
    ? '이 계정에는 아직 이 세계의 PMC가 없습니다. 회사 이름과 창업 배경을 정하세요. 배경에 따라 시작 위치·함대·자금·세력 관계가 달라집니다 (계정당 한 번).'
    : `이 계정에는 아직 이 세계의 PMC가 없습니다. 회사 이름을 정하면 ${where}, 채굴선 2척·구축함 1척·코르벳 2척과 ${funds}이 지급됩니다 (계정당 한 번).`;
  el.innerHTML = `<div id="menu"><div class="panel mbox abox${bgs.length ? ' bgbox' : ''}">
    <div class="mlogo">SIDERARIUM</div><div class="msub">PMC 설립 — ${esc(o.loginId)}</div>
    <div class="mdesc" data-pmc-start="${o.start ? Math.round(o.start.credits) : ''}">${intro}</div>
    ${field('pmcNew', 'PMC 이름', 'text', 'maxlength="20" placeholder="2~20자"')}
    ${bgs.length ? `<div class="bglabel">창업 배경</div><div class="bgcards" role="radiogroup">${bgs.map(b => `<button type="button" class="bgcard" role="radio" aria-checked="false" data-bg="${esc(b.id)}" style="--fc:${esc(b.factionColor)}">
        <b>${esc(b.name)}</b><span class="bgfac">${esc(b.factionName)}</span><span class="bgwhere">${esc(b.system)} · ${esc(b.station)}</span>
        <span class="bgsum">${cr(b.credits)} · ${b.ships.reduce((n, s) => n + s.n, 0)}척 · 운영비 ${cr(b.upkeep)}/h</span><span class="bgdiff ${DIFF_CLASS[b.difficulty] ?? ''}">난이도 ${esc(b.difficulty)}</span></button>`).join('')}</div>
      <div id="bgDetail" class="bgdetail"><div class="dim small">배경을 선택하면 지급 내용이 표시됩니다.</div></div>` : ''}
    ${o.legacy ? `<label class="dim small"><input type="checkbox" id="pmcLegacy" /> 이 브라우저에서 계정 도입 전에 쓰던 PMC를 이 계정으로 가져오기 (이름 입력 불필요)</label>` : ''}
    <div class="aerr" id="pmcErr"></div>
    <div class="mrow"><button class="btn go" id="pmcGo">설립</button><button class="btn" id="pmcOut">로그아웃</button></div>
  </div></div>`;
  const name = el.querySelector('#pmcNew') as HTMLInputElement, go = el.querySelector('#pmcGo') as HTMLButtonElement;
  name.focus();
  const leg = el.querySelector('#pmcLegacy') as HTMLInputElement | null;
  let chosen: string | undefined;
  for (const card of el.querySelectorAll<HTMLButtonElement>('[data-bg]')) card.onclick = () => {
    chosen = card.dataset.bg;
    for (const c of el!.querySelectorAll<HTMLElement>('[data-bg]')) { const on = c === card; c.classList.toggle('on', on); c.setAttribute('aria-checked', String(on)); }
    const b = bgs.find(x => x.id === chosen);
    const det = el!.querySelector('#bgDetail') as HTMLElement;
    if (b) { det.innerHTML = bgDetail(b); if (matchMedia('(max-width: 720px)').matches) det.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    (el!.querySelector('#pmcErr') as HTMLElement).textContent = '';
  };
  go.onclick = () => {
    const useLegacy = !!leg?.checked;
    const n = name.value.trim();
    const err = el!.querySelector('#pmcErr') as HTMLElement;
    if (!useLegacy && (n.length < 2 || n.length > 20)) { err.textContent = 'PMC 이름은 2~20자입니다'; return; }
    if (!useLegacy && bgs.length && !chosen) { err.textContent = '창업 배경을 선택하세요'; return; }
    go.disabled = true;
    o.onSubmit(n, useLegacy, useLegacy ? undefined : chosen);
  };
  name.onkeydown = e => { if (e.key === 'Enter') go.click(); };
  (el.querySelector('#pmcOut') as HTMLButtonElement).onclick = () => o.onLogout();
}
export function pmcCreateError(host: HTMLElement, msg: string) {
  const e = host.querySelector('#pmcErr') as HTMLElement | null; if (e) e.textContent = msg;
  const g = host.querySelector('#pmcGo') as HTMLButtonElement | null; if (g) g.disabled = false;
}
export function closePmcCreate(host: HTMLElement) { host.querySelector('#pmcCreate')?.remove(); }

/** in-game account panel: account info, password change, logout */
export function showAccountPanel(host: HTMLElement, o: { onLogout: () => void }) {
  if (host.querySelector('#acctPanel')) return;
  const el = document.createElement('div');
  el.id = 'acctPanel';
  el.className = 'acctwrap';
  host.appendChild(el);
  const close = () => el.remove();
  el.onclick = e => { if (e.target === el) close(); };
  el.innerHTML = '<div class="panel acct"><div class="ptitle">계정</div><div class="abody">불러오는 중…</div></div>';
  fetchMe().then(me => {
    if (!me) { o.onLogout(); return; }
    (el.querySelector('.abody') as HTMLElement).innerHTML = `
      <div class="kvl"><span>로그인 ID</span><b>${esc(me.account.loginId)}</b></div>
      <div class="kvl"><span>PMC</span><b>${esc(me.company?.name ?? '—')}</b></div>
      <div class="kvl"><span>가입</span><b>${fmtDate(me.account.createdAt)}</b></div>
      <div class="kvl"><span>마지막 로그인</span><b>${fmtDate(me.account.lastLogin)}</b></div>
      <div class="ptitle sub">비밀번호 변경</div>
      <form id="pwForm" class="aform">
        <input type="text" autocomplete="username" value="${esc(me.account.loginId)}" hidden />
        ${field('pwCur', '현재 비밀번호', 'password', 'autocomplete="current-password" maxlength="128"')}
        ${field('pwNew', '새 비밀번호', 'password', 'autocomplete="new-password" maxlength="128"')}
        ${field('pwNew2', '새 비밀번호 확인', 'password', 'autocomplete="new-password" maxlength="128"')}
        <div class="aerr" id="pwMsg"></div>
        <div class="mrow"><button class="btn" type="submit">변경</button></div>
      </form>
      <div class="mrow arow"><button class="btn danger" id="acOut">로그아웃</button><button class="btn" id="acClose">닫기</button></div>`;
    (el.querySelector('#acClose') as HTMLButtonElement).onclick = close;
    (el.querySelector('#acOut') as HTMLButtonElement).onclick = () => o.onLogout();
    const f = el.querySelector('#pwForm') as HTMLFormElement;
    const v = (id: string) => (el.querySelector('#' + id) as HTMLInputElement).value;
    const msg = (m: string, good = false) => { const x = el.querySelector('#pwMsg') as HTMLElement; x.textContent = m; x.classList.toggle('good', good); };
    f.onsubmit = async ev => {
      ev.preventDefault();
      if (v('pwNew') !== v('pwNew2')) return msg('새 비밀번호 확인이 일치하지 않습니다');
      try {
        const r = await api<{ signedOut: number }>('api/auth/password', { current: v('pwCur'), next: v('pwNew'), confirm: v('pwNew2') });
        f.reset(); msg(`비밀번호를 변경했습니다.${r.signedOut ? ` 다른 기기의 세션 ${r.signedOut}개를 로그아웃했습니다.` : ''}`, true);
      } catch (e) { msg((e as Error).message); }
    };
  }, () => { (el.querySelector('.abody') as HTMLElement).textContent = '서버에 연결할 수 없습니다'; });
}
