// P16.6 real-server harness: start/stop a built server binary (`dist-server/server.mjs`, or an older build for the
// migration check) on a temp save file, and drive it with real accounts over HTTP + WebSocket — the same protocol
// the browser client uses (signup → hello → createPmc → cmd/ack, snap, bjoin/binit/border).
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';

export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function until<T>(fn: () => T | Promise<T>, reason: string, ms = 120000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await delay(150); }
  throw Error(reason);
}
export async function freePort() {
  const probe = net.createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
  return port;
}

export class Server {
  child?: ChildProcess; log = ''; sockets: WebSocket[] = [];
  constructor(readonly port: number, readonly save: string, readonly binary = path.resolve('dist-server/server.mjs'), readonly env: Record<string, string> = {}) {}
  get base() { return `http://127.0.0.1:${this.port}`; }
  async start(extra: Record<string, string> = {}) {
    this.log = '';
    this.child = spawn('node', [this.binary], { cwd: path.dirname(this.save), env: { ...process.env, PORT: String(this.port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: this.save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '.5', CARRIERS_P16_MIGRATE: '', ...this.env, ...extra } });
    this.child.stdout!.on('data', d => this.log += d); this.child.stderr!.on('data', d => this.log += d);
    await until(() => { if (this.child!.exitCode !== null) throw Error(this.log); return this.log.includes('listening on'); }, `server did not start: ${this.log}`);
  }
  async stop() {
    for (const s of this.sockets.splice(0)) s.close();
    if (this.child) { const p = this.child; this.child = undefined; await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
  }
}

export class Pilot {
  messages: any[] = []; seq = 1; ws!: WebSocket; cookie = ''; id = '';
  constructor(readonly srv: Server, readonly name: string, readonly background?: string) {}
  async signup(loginId: string) {
    const b = this.srv.base;
    const r = await fetch(b + '/api/auth/signup', { method: 'POST', headers: { origin: b, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p166-test-password-123', confirm: 'p166-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async connect() {
    this.messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${this.srv.port}/ws`, { headers: { origin: this.srv.base, cookie: this.cookie } }); this.ws = ws; this.srv.sockets.push(ws);
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.t === 'snap') this.messages = this.messages.filter(x => x.t !== 'snap');
      if (m.t === 'border') { const b = this.binits.get(m.eng); if (b) b.orders.push(m.rec); return; }
      if (m.t === 'binit') this.binits.set(m.eng, { ...m, orders: [...(m.orders ?? [])] });
      this.messages.push(m);
      if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name: this.name, ...(this.background ? { background: this.background } : {}) }));
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
    await this.wait(m => m.t === 'snap');
  }
  /** binit (+ every border received since) per engagement this pilot joined */
  binits = new Map<string, any>();
  wait(test: (m: any) => boolean, ms?: number) { return until(() => this.messages.find(test), `missing response for ${this.name}`, ms); }
  lastErr: string | null = null;
  async command(cmd: any): Promise<string | null> { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return this.lastErr = (await this.wait(m => m.t === 'ack' && m.id === id)).err ?? null; }
  snap() { return this.messages.filter(m => m.t === 'snap').at(-1).state; }
  /** the first snapshot sent after this call (state after the commands already acknowledged) */
  async fresh() { const at = this.messages.filter(m => m.t === 'snap').at(-1)?.at ?? -1; await until(() => this.messages.some(m => m.t === 'snap' && m.at > at), `no new snapshot for ${this.name}`); return this.snap(); }
  async join(eng: string) { this.binits.delete(eng); this.ws.send(JSON.stringify({ t: 'bjoin', eng })); return until(() => this.binits.get(eng), `no binit for ${eng}`); }
}
