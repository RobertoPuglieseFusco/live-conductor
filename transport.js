// ── TRANSPORT ────────────────────────────────────────────────────────────────
// Unlike the browser engine's Transport (a shared BPM value, each device
// free-running off its own setTimeout), this one is driven by Live's actual
// beat clock — /live/song/start_listen/beat fires once per quarter note, in
// sync with what's really playing. Bars are derived from the numerator, so
// onBar(4) means "call me every 4 bars", which is the resolution a macro-time
// conductor actually wants (scene changes, section arcs, slow walks).
export class Transport {
  constructor(bridge) {
    this.bridge = bridge;
    this.beat = 0;
    this.numerator = 4;
    this._barCbs = new Map();   // everyNBars -> Set<fn>
    this._beatCbs = new Set();
    this._lastBar = -1;
  }

  async start() {
    this.numerator = (await this.bridge.request('/live/song/get/signature_numerator'))[0] ?? 4;
    this.bridge.listen('/live/song/get/beat', (beat) => {
      this.beat = beat;
      this._beatCbs.forEach(fn => fn(beat));
      // Fire on the bar CHANGING rather than on beat % numerator === 0. UDP
      // drops packets and the playhead can be moved by hand, so testing for an
      // exact beat hit silently skips whole bars; comparing against the last
      // bar we saw survives both.
      const bar = Math.floor(beat / this.numerator);
      if (bar !== this._lastBar) {
        this._lastBar = bar;
        this._barCbs.forEach((fns, everyN) => { if (bar % everyN === 0) fns.forEach(fn => fn(bar)); });
      }
    });
    this.bridge.send('/live/song/start_listen/beat');
  }

  onBeat(fn) { this._beatCbs.add(fn); return () => this._beatCbs.delete(fn); }

  onBar(everyN, fn) {
    if (!this._barCbs.has(everyN)) this._barCbs.set(everyN, new Set());
    this._barCbs.get(everyN).add(fn);
    return () => this._barCbs.get(everyN)?.delete(fn);
  }
}
