// The lab is only loaded after the server validates both the account and a separate lab grant.
import { api, fetchMe, type Me } from './account';

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function showDevCombatGate(app: HTMLElement, getCanvas: () => HTMLCanvasElement) {
  let account: Me | null = null;
  const error = (message: string) => { const e = app.querySelector('#devAuthError'); if (e) e.textContent = message; };
  async function enter() {
    await api('api/dev-combat/session');
    const module = await import('../devlab/devCombatLab');
    module.startDevCombatLab(app, getCanvas, () => void render());
  }
  async function render() {
    let notice = '';
    getCanvas().style.visibility = 'hidden';
    app.innerHTML = '<div id="menu"><div class="panel mbox abox"><div class="mlogo">SIDERARIUM</div><div class="msub">DEV COMBAT LAB · 인증 확인 중</div></div></div>';
    try { account = await fetchMe(); } catch (e) { account = null; notice = (e as Error).message; }
    if (account) {
      try { await enter(); return; } catch { /* show separate password prompt */ }
    }
    app.innerHTML = `<div id="menu"><div class="panel mbox abox"><div class="mlogo">SIDERARIUM</div><div class="msub">DEVELOPER COMBAT LAB</div>
      <p class="mdesc">관리자 계정과 전투 실험실 전용 비밀번호가 필요합니다. 전투는 이 브라우저에서만 실행됩니다.</p>
      ${account ? `<p class="dim">계정: <b>${esc(account.account.loginId)}</b></p>` : ''}
      <form class="aform" id="devAuth" autocomplete="off">
        ${account ? '<label class="afield"><span>전투 실험실 비밀번호</span><input id="devPw" type="password" maxlength="128" autocomplete="off" required></label>' : '<label class="afield"><span>관리자 계정 ID</span><input id="devId" maxlength="20" autocomplete="username" required></label><label class="afield"><span>계정 비밀번호</span><input id="devPw" type="password" maxlength="128" autocomplete="current-password" required></label>'}
        <div class="aerr" id="devAuthError" role="alert"></div><div class="mrow"><button class="btn go" type="submit">${account ? '실험실 인증' : '계정 로그인'}</button>${account ? '<button class="btn" type="button" id="devAccountLogout">계정 전환</button>' : ''}</div>
      </form></div></div>`;
    if (notice) error(notice);
    const form = app.querySelector<HTMLFormElement>('#devAuth')!;
    form.onsubmit = async e => {
      e.preventDefault(); const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      const input = form.querySelector<HTMLInputElement>('#devPw')!, password = input.value; input.value = ''; button.disabled = true; error('');
      try {
        if (!account) { await api('api/auth/login', { loginId: form.querySelector<HTMLInputElement>('#devId')!.value, password }); await render(); }
        else { await api('api/dev-combat/login', { password }); await enter(); }
      } catch (err) { error((err as Error).message); button.disabled = false; }
    };
    const logout = app.querySelector<HTMLButtonElement>('#devAccountLogout');
    if (logout) logout.onclick = async () => { try { await api('api/auth/logout', {}); } finally { account = null; await render(); } };
  }
  void render();
}
