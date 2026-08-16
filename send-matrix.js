// ── SEND MATRIX ──────────────────────────────────────────────────────────────
// Ableton's Send → Return system *is* the matrix: every stage is a regular
// Audio track (Audio From = its paired Return, tap point Post Mixer), and an
// edge in the matrix is just that stage's Send knob targeting another Return.
// Only ever addresses regular tracks — Return tracks stay untouched by OSC,
// which sidesteps the question of whether they're individually addressable.
//
// stageTracks: { HRM: 'HRM', AM: 'AM', FM: 'FM', ... }  stage key -> track name
// returnOrder: ['HRM', 'AM', 'FM', ...]                  send_id is positional,
//              must match the Return tracks' left-to-right order in Live.
export class SendMatrix {
  constructor(bridge, { stageTracks, returnOrder, maxWeight = 0.85 }) {
    this.bridge = bridge;
    this.stageTracks = stageTracks;
    this.returnOrder = returnOrder;
    this.maxWeight = maxWeight;
    this._trackIds = new Map();   // stage key -> track_id
    this._weights  = new Map();   // "from>to" -> weight
  }

  async resolve() {
    const names = await this.bridge.request('/live/song/get/track_names');
    for (const [key, name] of Object.entries(this.stageTracks)) {
      const id = names.indexOf(name);
      if (id < 0) throw new Error(`No stage track named "${name}" — check it exists and is spelled exactly right`);
      this._trackIds.set(key, id);
    }
  }

  weight(from, to) { return this._weights.get(from + '>' + to) ?? 0; }

  setWeight(from, to, w) {
    w = Math.max(0, Math.min(this.maxWeight, w));
    const trackId = this._trackIds.get(from);
    const sendId  = this.returnOrder.indexOf(to);
    if (trackId === undefined) { console.warn(`[matrix] unknown stage "${from}"`); return; }
    if (sendId < 0)             { console.warn(`[matrix] unknown return "${to}"`);  return; }
    this._weights.set(from + '>' + to, w);
    this.bridge.send('/live/track/set/send', trackId, sendId, w);
  }

  // Nudge toward a target rather than jumping — smoother than a hard set when
  // called once per bar, closer to how the wet/dry ramps in the browser engine
  // never snap.
  nudge(from, to, target, amount = 0.15) {
    const w = this.weight(from, to);
    this.setWeight(from, to, w + (target - w) * amount);
  }

  activeRoutes() { return [...this._weights.entries()].filter(([, w]) => w > 0.001); }

  panic() { for (const key of this._weights.keys()) { const [from, to] = key.split('>'); this.setWeight(from, to, 0); } }
}
