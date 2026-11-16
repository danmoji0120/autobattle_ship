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
export function showPmcCreate(host: HTMLElement, o: { loginId: string; legacy: boolean; start?: { credits: number; station: string }; onSubmit: (name: string, legacy: boolean) => void; onLogout: () => void }) {
  let el = host.querySelector('#pmcCreate') as HTMLElement | null;
  if (!el) { el = document.createElement('div'); el.id = 'pmcCreate'; host.appendChild(el); }
  // the server states what this world gives (an older server sends nothing: then no amount is promised)
  const where = o.start?.station ? `${esc(o.start.station)}에 등록되고` : '모항에 등록되고';
  const funds = o.start ? `운영 자금 ${Math.round(o.start.credits).toLocaleString('en-US')} cr` : '운영 자금';
  el.innerHTML = `<div id="menu"><div class="panel mbox abox">
    <div class="mlogo">SIDERARIUM</div><div class="msub">PMC 설립 — ${esc(o.loginId)}</div>
    <div class="mdesc" data-pmc-start="${o.start ? Math.round(o.start.credits) : ''}">이 계정에는 아직 이 세계의 PMC가 없습니다. 회사 이름을 정하면 ${where}, 채굴선 2척·구축함 1척·코르벳 2척과 ${funds}이 지급됩니다 (계정당 한 번).</div>
    ${field('pmcNew', 'PMC 이름', 'text', 'maxlength="20" placeholder="2~20자"')}
    ${o.legacy ? `<label class="dim small"><input type="checkbox" id="pmcLegacy" /> 이 브라우저에서 계정 도입 전에 쓰던 PMC를 이 계정으로 가져오기 (이름 입력 불필요)</label>` : ''}
    <div class="aerr" id="pmcErr"></div>
    <div class="mrow"><button class="btn go" id="pmcGo">설립</button><button class="btn" id="pmcOut">로그아웃</button></div>
  </div></div>`;
  const name = el.querySelector('#pmcNew') as HTMLInputElement, go = el.querySelector('#pmcGo') as HTMLButtonElement;
  name.focus();
  const leg = el.querySelector('#pmcLegacy') as HTMLInputElement | null;
  go.onclick = () => {
    const useLegacy = !!leg?.checked;
    const n = name.value.trim();
    if (!useLegacy && (n.length < 2 || n.length > 20)) { (el!.querySelector('#pmcErr') as HTMLElement).textContent = 'PMC 이름은 2~20자입니다'; return; }
    go.disabled = true;
    o.onSubmit(n, useLegacy);
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
