// ── MESH MATRIX ───────────────────────────────────────────────────────────────
// The whole point of the Audio Sends rig: every track can send to every track,
// and the GAIN decides who hears whom. That makes the routing a plain N×N
// matrix — no hand-maintained route table, no per-set config.
//
// The one thing OSC can't tell you is where a row points; the destination
// dropdown isn't an automatable parameter. Derived empirically instead, by
// opening one row at a time and watching /live/track/get/output_meter_level:
//
//     row02 -> FX_1 (track 1)      row03 -> FX_2 (track 2)
//     row04 -> FX_3 (track 3)      => row = destination track index + 1
//
// Probed from Cello and again from FX_1 with identical results, so the wiring
// is the same on every device — which is what makes the arithmetic safe rather
// than a coincidence of one track. If you rewire the dropdowns, change
// rowOffset (or pass an explicit `rows` map) and nothing else moves.
//
//     const mesh = new MeshMatrix(bridge, trackMap);
//     await mesh.resolve();
//     mesh.setWeight('Cello', 'FX_1', 0.7);   // by name, not by row number
import { SenderMatrix } from './sender-matrix.js';

export class MeshMatrix {
  constructor(bridge, trackMap, { rowOffset = 1, includeSelf = false, ...senderOpts } = {}) {
    this.bridge = bridge;
    this.map = trackMap;
    this.rowOffset = rowOffset;
    this.includeSelf = includeSelf;   // self-routes are feedback; opt in deliberately
    this.senderOpts = senderOpts;
    this.matrix = null;
    this.dests = [];
  }

  async resolve() {
    const senders = this.map.senders();
    // Every track is a potential destination, including ones with no send device
    // of their own — receiving doesn't require one.
    this.dests = this.map.tracks.filter(t => t.role !== 'ignore');

    const routes = {};
    for (const src of senders) {
      const rows = {};
      for (const dst of this.dests) {
        if (!this.includeSelf && dst.id === src.id) continue;
        rows[dst.name] = dst.id + this.rowOffset;
      }
      if (Object.keys(rows).length) routes[src.name] = { device: src.sendDevice, rows };
    }
    this.matrix = new SenderMatrix(this.bridge, routes, this.senderOpts);
    await this.matrix.resolve();
    return this;
  }

  setWeight(from, to, w) { this.matrix.setWeight(from, to, w); }
  entries()              { return this.matrix.entries(); }
  dbToWeight(db)         { return this.matrix.dbToWeight(db); }

  // Every source->destination pair, as things a driver can walk.
  pairs() {
    return this.entries().map(e => {
      const [from, to] = e.key.split('>');
      return { from, to, ...e };
    });
  }

  // An N×N grid is the honest picture of a mesh — rows send, columns receive.
  render(weights) {
    const w = 9;
    const head = 'from \\ to'.padEnd(12) + this.dests.map(d => d.name.slice(0, w - 1).padStart(w)).join('');
    const lines = [head, '-'.repeat(head.length)];
    for (const src of this.map.senders()) {
      let line = src.name.slice(0, 11).padEnd(12);
      for (const dst of this.dests) {
        const key = `${src.name}>${dst.name}`;
        line += (weights?.has(key) ? weights.get(key).toFixed(2) : (src.id === dst.id ? 'self' : '·')).padStart(w);
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
}
