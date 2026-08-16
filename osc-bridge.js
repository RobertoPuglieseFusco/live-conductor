// ── OSC BRIDGE ──────────────────────────────────────────────────────────────
// Thin wrapper over node `osc`, talking to AbletonOSC (listens 11000, replies
// 11001). Two ways in: fire-and-forget `send()`, and `request()` for the
// get/reply round trip. `listen()` is for AbletonOSC's push-style messages
// (beat events, start_listen/<property> subscriptions) — many callbacks per
// address, never consumed.
import osc from 'osc';

export class LiveBridge {
  constructor({ localPort = 11001, remotePort = 11000, remoteAddress = '127.0.0.1' } = {}) {
    this.port = new osc.UDPPort({ localAddress: '0.0.0.0', localPort, remoteAddress, remotePort, metadata: true });
    this._listeners = new Map();   // address -> Set<fn>
    this._pending   = new Map();   // address -> [{resolve, timer}, ...]  (FIFO per address)
    this.ready = new Promise(res => this.port.on('ready', res));
    this.port.on('message', msg => this._dispatch(msg));
    this.port.on('error', err => console.error('[osc]', err.message));
  }

  // AbletonOSC replies to a fixed port (11001), so only one client can be
  // listening at a time — a second process just hangs waiting for a 'ready'
  // that never comes. Fail loudly instead, and give callers a way to hand the
  // port back.
  async open(timeoutMs = 3000) {
    this.port.open();
    await Promise.race([
      this.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error(
        `OSC port ${this.port.options.localPort} did not open — is another ` +
        `conductor already running? Only one client can hold the reply port.`
      )), timeoutMs)),
    ]);
    return this;
  }

  close() { try { this.port.close(); } catch {} }

  send(address, ...args) {
    this.port.send({ address, args: args.map(toArg) });
  }

  // Resolves with the args of the next reply on `replyAddress` (defaults to
  // the query address itself, which is how most AbletonOSC getters behave).
  request(address, args = [], replyAddress = address, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const q = this._pending.get(replyAddress);
        if (q) { const i = q.findIndex(e => e.timer === timer); if (i >= 0) q.splice(i, 1); }
        reject(new Error(`OSC request timed out: ${address}`));
      }, timeoutMs);
      if (!this._pending.has(replyAddress)) this._pending.set(replyAddress, []);
      this._pending.get(replyAddress).push({ resolve, timer });
      this.send(address, ...args);
    });
  }

  // Ongoing subscription — beat events, start_listen/* pushes. Returns an
  // unsubscribe fn.
  listen(address, fn) {
    if (!this._listeners.has(address)) this._listeners.set(address, new Set());
    this._listeners.get(address).add(fn);
    return () => this._listeners.get(address)?.delete(fn);
  }

  _dispatch({ address, args }) {
    const vals = args.map(a => a.value);
    const q = this._pending.get(address);
    if (q?.length) { const { resolve, timer } = q.shift(); clearTimeout(timer); resolve(vals); }
    this._listeners.get(address)?.forEach(fn => fn(...vals));
  }
}

function toArg(v) {
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'i' : 'f', value: v };
  return { type: 's', value: String(v) };
}
