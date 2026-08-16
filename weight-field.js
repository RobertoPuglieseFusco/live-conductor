// ── WEIGHT FIELD ──────────────────────────────────────────────────────────────
// Owns every route weight in the mesh and the rules they have to obey. Pure
// logic — no OSC, no Live — so the musical behaviour can be tested and tuned
// without a set open, which is the opposite of how the rest of this started.
//
// Two constraints matter, and neither is optional once the mesh has cycles:
//
//   LOOP GAIN. Cello -> FX_1 -> FX_2 -> FX_3 -> Cello is a ring. Independent
//   random walks will happily push every hop toward unity at the same moment,
//   and a cycle whose gains multiply to >= 1 doesn't drift, it howls — and the
//   effects on those tracks add their own gain the send weights know nothing
//   about. So cycles are found and scaled back to a safety margin.
//
//   SEND BUDGET. A track shouting into every destination at once is mud, not
//   texture. Each source's outgoing amplitudes are capped in total, so the
//   walk redistributes emphasis instead of just accumulating it.
//
// Both are applied AFTER the walk, so the drift stays free and the constraints
// only bite when they're actually violated.
export class WeightField {
  constructor({ pairs, roleOf = {}, step = {}, curve = 2, maxDb = 0,
                loopMax = 0.6, sendBudget = 1.6, rng = Math.random } = {}) {
    this.pairs = pairs;                  // [{ key, from, to }]
    this.roleOf = roleOf;
    this.step = { default: 0.06, ...step };
    this.curve = curve;
    this.maxDb = maxDb;
    this.loopMax = loopMax;              // max product of amplitudes around a cycle
    this.sendBudget = sendBudget;        // max sum of amplitudes leaving one track
    this.rng = rng;
    this.w = new Map(pairs.map(p => [p.key, 0]));
    this.cycles = findCycles(pairs);
  }

  get(key) { return this.w.get(key); }
  set(key, v) { this.w.set(key, clamp01(v)); }
  values() { return new Map(this.w); }

  // A weight is perceived loudness; amplitude is what actually multiplies around
  // a loop. Must match SenderMatrix.setWeight's curve or the guard is fiction.
  amplitude(w) { return 10 ** (this.maxDb / 20) * w ** this.curve; }

  stepFor(p) { return this.step[`${this.roleOf[p.from]}>${this.roleOf[p.to]}`] ?? this.step.default; }

  // Bounded walk, reflecting off 0 and 1 so routes keep moving rather than
  // parking at an edge.
  drift() {
    for (const p of this.pairs) {
      let next = this.w.get(p.key) + (this.rng() * 2 - 1) * this.stepFor(p);
      if (next < 0) next = -next;
      if (next > 1) next = 2 - next;
      this.w.set(p.key, clamp01(next));
    }
    return this.constrain();
  }

  // Returns what it had to pull back, so a driver can say so out loud rather
  // than silently overriding the walk.
  constrain() {
    const notes = [];

    for (const cycle of this.cycles) {
      const gain = cycle.reduce((g, key) => g * this.amplitude(this.w.get(key)), 1);
      if (gain <= this.loopMax) continue;
      // Scaling every weight in the cycle by k scales loop gain by k^(curve*len),
      // so solve for the k that lands exactly on the limit.
      const k = (this.loopMax / gain) ** (1 / (this.curve * cycle.length));
      for (const key of cycle) this.w.set(key, clamp01(this.w.get(key) * k));
      notes.push(`loop ${cycle.length}-cycle gain ${gain.toFixed(2)} -> ${this.loopMax}`);
    }

    const bySource = new Map();
    for (const p of this.pairs) {
      if (!bySource.has(p.from)) bySource.set(p.from, []);
      bySource.get(p.from).push(p.key);
    }
    for (const [from, keys] of bySource) {
      const total = keys.reduce((s, k) => s + this.amplitude(this.w.get(k)), 0);
      if (total <= this.sendBudget) continue;
      const k = (this.sendBudget / total) ** (1 / this.curve);
      for (const key of keys) this.w.set(key, clamp01(this.w.get(key) * k));
      notes.push(`${from} send budget ${total.toFixed(2)} -> ${this.sendBudget}`);
    }
    return notes;
  }

  // Worst-case loop gain right now — the number worth watching in a live rig.
  worstLoop() {
    let worst = 0;
    for (const cycle of this.cycles) {
      const g = cycle.reduce((acc, key) => acc * this.amplitude(this.w.get(key)), 1);
      if (g > worst) worst = g;
    }
    return worst;
  }
}

const clamp01 = v => Math.max(0, Math.min(1, v));

// Every simple directed cycle in the route graph, as lists of route keys.
// Meshes here are tiny (a handful of tracks), so an exhaustive DFS is fine and
// far easier to trust than anything cleverer.
export function findCycles(pairs) {
  const out = new Map();   // from -> [{to, key}]
  for (const p of pairs) {
    if (!out.has(p.from)) out.set(p.from, []);
    out.get(p.from).push(p);
  }
  const cycles = [], seen = new Set();

  const walk = (start, node, path, visited) => {
    for (const edge of out.get(node) ?? []) {
      if (edge.to === start) {
        const keys = [...path, edge.key];
        // Same cycle found from each of its members — keep one representative.
        const id = [...keys].sort().join('|');
        if (!seen.has(id)) { seen.add(id); cycles.push(keys); }
      } else if (!visited.has(edge.to)) {
        walk(start, edge.to, [...path, edge.key], new Set([...visited, edge.to]));
      }
    }
  };
  for (const from of out.keys()) walk(from, from, [], new Set([from]));
  return cycles;
}
