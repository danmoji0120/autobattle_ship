// Opens a live persistent-world battle in the tactical view. The client re-simulates the battle
// deterministically from the server's setup and stamped orders, paced to the authority's tick.

import { BattleSession } from '../game/session';
import { BattleHUD } from '../ui/battleHud';
import type { GameClient } from './net';
import type { Group, OrderRecord } from '../sim/types';
import type { BattleSetup } from '../sim/world';
import { sfx } from '../audio/sfx';
import { canCommandGroup } from '../world/battleAuth';

export class BattleLink {
  private layer: HTMLElement;
  private session: BattleSession | null = null;
  private hud: BattleHUD | null = null;
  private raf = 0;
  private last = performance.now();
  private orders: OrderRecord[] = [];
  private setup: BattleSetup | null = null;
  /** finished battle (or the player asked to rewatch): play back locally from the record */
  private replay = false;
  private names: string[] | null = null;
  closed = false;

  constructor(private client: GameClient, readonly eng: string, private onClose: () => void) {
    this.layer = document.createElement('div');
    this.layer.id = 'battleLayer';
    document.body.appendChild(this.layer);
    this.layer.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;font-family:var(--mono);letter-spacing:.4em;color:var(--cyan)">전투 데이터 수신 중…</div>`;
    client.onBattle = m => {
      if (m.eng !== this.eng) return;
      if (m.t === 'binit') { this.setup = m.setup; this.orders = m.orders.slice(); this.replay = !!m.replay; this.names = m.names ?? null; this.build(); }
      else if (m.t === 'border') {
        this.orders.push(m.rec);
        const w = this.session?.world;
        if (!w || this.replay) return;
        if (m.rec.tick >= w.tick) w.scheduleOrder({ ...m.rec });
        else this.build(); // arrived late (we ran ahead): rebuild deterministically from the full order log
      }
    };
    client.joinBattle(eng);
  }

  private targetTick(): number {
    const st = this.client.state;
    const e = st?.engagements[this.eng];
    if (!e || e.done) return Infinity;
    const elapsed = (performance.now() - this.client.snapAt) / 1000 * this.client.speed;
    return e.tick + Math.min(elapsed, 2) * 30 - 3; // stay a few ticks behind the authority
  }

  /** the same rule the server enforces (world/battleAuth): a group is ours only if every unit under it is.
   *  Hiding a button is a convenience — the server refuses anything else regardless. */
  private canCommand(g: Group): boolean {
    const st = this.client.state, w = this.session?.world;
    if (!st || !w || this.replay) return false;
    return canCommandGroup(st, w, g, this.client.company);
  }

  /** the side this company fights on (null: spectator — an NPC battle, someone else's, or a record we were not in) */
  private mySide(): number | null {
    const st = this.client.state, me = this.client.company;
    const e = st?.engagements[this.eng];
    if (e && !e.done) { const k = e.sides.findIndex(x => x.includes(me)); return k >= 0 ? k : null; }
    const rec = st?.battleLog?.find(r => r.id === this.eng);
    const k = rec?.sides?.findIndex(x => x.company === me) ?? -1;
    return k >= 0 ? k : null;
  }
  private isSpectator(): boolean { return this.mySide() === null; }

  private build() {
    if (!this.setup) return;
    this.teardown();
    this.layer.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.id = 'view';
    this.layer.appendChild(canvas);
    const app = document.createElement('div');
    app.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.layer.appendChild(app);
    const me = this.mySide();
    const s = new BattleSession(canvas, this.setup, sfx, this.replay ? { me } : {
      me,
      lockstep: () => this.targetTick(),
      orderSink: (groupId, order, opts) => { this.client.battleOrder(this.eng, groupId, order, opts).then(err => { if (err) console.warn(err); }); },
    });
    s.world.scheduleReplay(this.orders.map(o => ({ ...o })));
    this.session = s;
    (window as any).__battle = s; (window as any).__battleLink = this;   // test / visual-check hooks
    const spectating = this.isSpectator();
    this.hud = new BattleHUD(app, s, {
      replay: this.replay, canCommand: g => this.canCommand(g), campaign: { onReturn: () => this.close() }, overlayParent: this.layer,
      spectate: spectating && this.names ? { sides: this.names } : undefined,
      me, names: this.names ?? undefined,
      // a live battle runs at the world's pace; a replay is ours to speed up, pause or scrub
      onSpeed: this.replay ? undefined : this.client.sp ? (v => this.client.setSpeed(v)) : 'none',
      onExit: () => this.close(), onRestart: () => {},
      onReplay: () => { this.replay = true; this.build(); },
    });
    const style = document.createElement('style');
    style.textContent = '#battleLayer > div > * { pointer-events: auto; }';
    app.appendChild(style);
    const back = document.createElement('button');
    back.className = 'btn';
    back.id = 'battleBack';
    back.textContent = this.replay ? '◂ 전략 지도로' : '◂ 전략 지도로 (전투는 계속됨)';
    back.onclick = () => this.close();
    app.appendChild(back);
    // P11: pull this company's whole side out (the battle goes on for the others)
    const e = this.client.state?.engagements[this.eng];
    if (!this.replay && e?.v === 2 && me !== null) {
      const wd = document.createElement('button');
      wd.className = 'btn danger';
      wd.id = 'battleWithdraw';
      wd.textContent = '전 함대 철수';
      wd.title = '자사 진영 전체가 전장을 이탈합니다. 남은 진영의 교전은 계속됩니다.';
      wd.onclick = () => { if (!confirm('자사 함대 전체를 전장에서 철수시킵니까? (남은 진영의 전투는 계속됩니다)')) return; this.client.battleOrder(this.eng, -1, null, { withdraw: true }).then(err => { if (err) alert(err); else { wd.disabled = true; wd.textContent = '철수 중…'; } }); };
      app.appendChild(wd);
    }
    s.view.resize(innerWidth, innerHeight);
    this.last = performance.now();
    const loop = (now: number) => {
      if (this.closed) return;
      const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
      s.tick(dt);
      sfx.listener = s.view.rig.camera.position;
      sfx.updateMusic(Math.min(1, s.world.intensity / 25));
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private teardown() {
    cancelAnimationFrame(this.raf);
    this.hud?.dispose(); this.hud = null;
    this.session?.dispose(); this.session = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    this.client.onBattle = null;
    this.layer.remove();
    this.onClose();
  }
}
