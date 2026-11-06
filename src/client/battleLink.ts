// Opens a live persistent-world battle in the tactical view. The client re-simulates the battle
// deterministically from the server's setup and stamped orders, paced to the authority's tick.

import { BattleSession } from '../game/session';
import { BattleHUD } from '../ui/battleHud';
import type { GameClient } from './net';
import type { Group, OrderRecord } from '../sim/types';
import type { BattleSetup } from '../sim/world';
import { sfx } from '../audio/sfx';

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
  private names: [string, string] | null = null;
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

  private canCommand(g: Group): boolean {
    const st = this.client.state;
    if (!st || !g.ref) return false;
    const me = this.client.company;
    if (this.replay) return false;
    if (g.ref === 'root') {
      // the root command belongs to the attacking side's player — never to a spectator of an NPC battle
      const e = st.engagements[this.eng];
      const players = e ? e.sides[0].filter(c => st.companies[c]?.kind === 'player') : [];
      return players.length > 0 && players.every(c => c === me);
    }
    if (g.ref.startsWith('station:')) return st.stations[g.ref.slice(8)]?.owner === me;
    const sg = st.groups[g.ref.replace('#civ', '')];
    return sg?.owner === me;
  }

  /** this company has no ships in the fight (an NPC battle, or someone else's) */
  private isSpectator(): boolean {
    const st = this.client.state, me = this.client.company;
    const e = st?.engagements[this.eng];
    if (!e) return true; // finished battle → record replay
    return !e.sides[0].includes(me) && !e.sides[1].includes(me);
  }

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
    const s = new BattleSession(canvas, this.setup, sfx, this.replay ? {} : {
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
