// ── RECEIVER MATRIX ──────────────────────────────────────────────────────────
// Two legs, two mechanisms, multiplying together into one route's weight:
//
//   send leg:    any track   → (native Ableton Send)        → Return A..H
//   receive leg: Return A..H → (send~/receive~ Max device)  → any track's own
//                Matrix Receiver device — always the first device, identical
//                patch everywhere, 8 macros named A..H.
//
// setSend() controls the mixer's real Send knob (confirmed, documented OSC).
// setReceive() controls a device macro on the destination track's own first
// device — same mechanism as MacroWalker, just called per-letter, per-track.
export class ReceiverMatrix {
  constructor(bridge, { trackNames, returnOrder, receiverDeviceIndex = 0, maxWeight = 0.85 }) {
    this.bridge = bridge;
    this.trackNames = trackNames;             // every track that can send and/or receive
    this.returnOrder = returnOrder;           // e.g. ['A','B','C','D','E','F','G','H'] — positional for sends
    this.receiverDeviceIndex = receiverDeviceIndex;
    this.maxWeight = maxWeight;
    this._trackIds = new Map();               // name -> track_id
    this._receiveParams = new Map();          // track_id -> { A: paramId, B: paramId, ... }
    this._sendWeights = new Map();            // "track>letter" -> weight
    this._receiveWeights = new Map();         // "track>letter" -> weight
  }

  async resolve() {
    const names = await this.bridge.request('/live/song/get/track_names');
    for (const name of this.trackNames) {
      const id = names.indexOf(name);
      if (id < 0) throw new Error(`No track named "${name}"`);
      this._trackIds.set(name, id);
    }
    // Same device everywhere, but Live assigns parameter indices per
    // instance — still needs resolving once per track, by macro name.
    for (const [name, trackId] of this._trackIds) {
      const paramNames = (await this.bridge.request('/live/device/get/parameters/name', [trackId, this.receiverDeviceIndex])).slice(2);
      const byLetter = {};
      for (const letter of this.returnOrder) {
        const paramId = paramNames.indexOf(letter);
        if (paramId < 0) throw new Error(`Track "${name}"'s device ${this.receiverDeviceIndex} has no macro named "${letter}" — is it the Matrix Receiver?`);
        byLetter[letter] = paramId;
      }
      this._receiveParams.set(trackId, byLetter);
    }
  }

  sendWeight(fromTrack, letter)    { return this._sendWeights.get(fromTrack + '>' + letter) ?? 0; }
  receiveWeight(toTrack, letter)   { return this._receiveWeights.get(toTrack + '>' + letter) ?? 0; }

  setSend(fromTrack, letter, w) {
    w = Math.max(0, Math.min(this.maxWeight, w));
    const trackId = this._trackIds.get(fromTrack);
    const sendId  = this.returnOrder.indexOf(letter);
    if (trackId === undefined || sendId < 0) return;
    this._sendWeights.set(fromTrack + '>' + letter, w);
    this.bridge.send('/live/track/set/send', trackId, sendId, w);
  }

  setReceive(toTrack, letter, w) {
    w = Math.max(0, Math.min(this.maxWeight, w));
    const trackId = this._trackIds.get(toTrack);
    const paramId = this._receiveParams.get(trackId)?.[letter];
    if (paramId === undefined) return;
    this._receiveWeights.set(toTrack + '>' + letter, w);
    this.bridge.send('/live/device/set/parameter/value', trackId, this.receiverDeviceIndex, paramId, w);
  }

  panic() {
    for (const key of this._sendWeights.keys())    { const [t, l] = key.split('>'); this.setSend(t, l, 0); }
    for (const key of this._receiveWeights.keys()) { const [t, l] = key.split('>'); this.setReceive(t, l, 0); }
  }
}
