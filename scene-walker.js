// ── SCENE WALKER ─────────────────────────────────────────────────────────────
// Same shape as the granular engine's Arpeggiator: a stepper with a rule for
// what comes next. Here "notes" are scenes, and the rule is a weighted
// transition table rather than up/down/pingpong/random — a first pass at
// something Markov-ish, so structure emerges instead of pure dice-rolling.
//
// weights[fromScene] = { toScene: weight, ... }. A scene missing from the
// table falls back to `defaultWeights` (usually "stay put or go anywhere").
export class SceneWalker {
  constructor(bridge, { weights = {}, defaultWeights = null } = {}) {
    this.bridge = bridge;
    this.weights = weights;
    this.defaultWeights = defaultWeights;
    this.current = 0;
  }

  next() {
    const table = this.weights[this.current] ?? this.defaultWeights;
    if (!table) return this.current;
    const entries = Object.entries(table);
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [scene, w] of entries) { r -= w; if (r <= 0) { this.current = +scene; break; } }
    return this.current;
  }

  fire(sceneId = this.current) {
    this.bridge.send('/live/scene/fire', sceneId);
    this.current = sceneId;
  }

  // Advance and fire in one call — the thing you actually hang off onBar().
  step() { this.fire(this.next()); return this.current; }
}
