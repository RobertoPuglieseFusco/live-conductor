// ── GROUP MATRIX ────────────────────────────────────────────────────────────
// No Max for Live at all. Every stage is a Group track summing a handful of
// child tracks, each with Audio From locked to exactly one thing — a Return,
// or a direct source like cello — and that child's own Volume fader *is* the
// weight for that one input. The group's own Send broadcasts the stage's
// processed result onward, same mechanism as before.
//
// Build only the child tracks you actually want a route for — same "costs
// nothing until you use it" laziness as the browser engine's Matrix.js.
// Naming convention: child track "<stage> <letter>" listens to Return
// <letter>; "<stage> <label>" (e.g. "FM cello") listens to a direct source.
export class GroupMatrix {
  constructor(bridge, { maxWeight = 0.85 } = {}) {
    this.bridge = bridge;
    this.maxWeight = maxWeight;
    this._trackIds = new Map();   // exact track name -> track_id
  }

  async resolve() {
    const names = await this.bridge.request('/live/song/get/track_names');
    names.forEach((name, id) => this._trackIds.set(name, id));
  }

  // Weight of Return <letter> flowing into <stage>, via its "<stage> <letter>"
  // child track's volume. No-ops quietly if that child doesn't exist — you
  // just haven't built a route there yet.
  setReceive(stage, letter, w) { this._setVolume(`${stage} ${letter}`, w); }

  // Weight of a direct, non-Return source (cello, sample deck, whatever)
  // feeding straight into a stage.
  setSource(stage, sourceLabel, w) { this._setVolume(`${stage} ${sourceLabel}`, w); }

  // The broadcast leg — an ordinary Send on the Group track itself. Exposed
  // for symmetry; many setups will just dial this in by hand and never
  // sequence it, since it's usually fixed (stage N always feeds letter N).
  setSend(stage, letter, returnOrder, w) {
    const trackId = this._trackIds.get(stage);
    const sendId  = returnOrder.indexOf(letter);
    if (trackId === undefined || sendId < 0) return;
    this.bridge.send('/live/track/set/send', trackId, sendId, Math.max(0, Math.min(this.maxWeight, w)));
  }

  _setVolume(trackName, w) {
    const trackId = this._trackIds.get(trackName);
    if (trackId === undefined) { console.warn(`[matrix] no track named "${trackName}" — route not built yet`); return; }
    this.bridge.send('/live/track/set/volume', trackId, Math.max(0, Math.min(this.maxWeight, w)));
  }
}
