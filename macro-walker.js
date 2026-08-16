// ── MACRO WALKER ─────────────────────────────────────────────────────────────
// Targets a Rack macro by (track name, device name, macro name) instead of
// raw indices — same reasoning as the browser engine's n.<name> node keys:
// what's patched under the Rack can change without this code changing.
// Resolves indices once via /live/track/get/name + /live/track/get/devices/name
// + /live/device/get/parameters/name, then walks the macro's 0..127 range with
// bounded random steps. This is macro-time modulation (call it on onBar), not
// an LFO — let a Live-side modulator do audio-rate movement off this macro.
export class MacroWalker {
  constructor(bridge, { trackName, deviceName, macroName, min = 0, max = 127, stepPct = 0.08 }) {
    this.bridge = bridge;
    this.target = { trackName, deviceName, macroName };
    this.min = min; this.max = max; this.stepPct = stepPct;
    this.value = (min + max) / 2;
    this._resolved = null;                    // { trackId, deviceId, paramId }
    this._held = false;                       // true while setTarget() is pinning it
  }

  async resolve() {
    const names = (await this.bridge.request('/live/song/get/track_names'));
    const trackId = names.indexOf(this.target.trackName);
    if (trackId < 0) throw new Error(`No track named "${this.target.trackName}"`);

    const devNames = (await this.bridge.request('/live/track/get/devices/name', [trackId])).slice(1);
    const deviceId = devNames.indexOf(this.target.deviceName);
    if (deviceId < 0) throw new Error(`No device named "${this.target.deviceName}" on "${this.target.trackName}"`);

    const paramNames = (await this.bridge.request('/live/device/get/parameters/name', [trackId, deviceId])).slice(2);
    const paramId = paramNames.indexOf(this.target.macroName);
    if (paramId < 0) throw new Error(`No parameter named "${this.target.macroName}" on "${this.target.deviceName}"`);

    this._resolved = { trackId, deviceId, paramId };
    return this._resolved;
  }

  // Bounded random walk — reflects off min/max rather than clamping+sticking,
  // so it keeps drifting instead of parking at an edge.
  step() {
    if (!this._resolved || this._held) return;
    const range = this.max - this.min;
    let next = this.value + (Math.random() * 2 - 1) * range * this.stepPct;
    if (next < this.min) next = this.min + (this.min - next);
    if (next > this.max) next = this.max - (next - this.max);
    this.value = Math.max(this.min, Math.min(this.max, next));
    this._send();
  }

  // Manual override: pin the macro and stop walking it. Unlike overwriting
  // step(), this actually transmits the value and can be undone — release()
  // hands the parameter back to the walk from wherever you left it.
  setTarget(value) {
    this.value = Math.max(this.min, Math.min(this.max, value));
    this._held = true;
    this._send();
  }

  release() { this._held = false; }

  _send() {
    if (!this._resolved) return;
    const { trackId, deviceId, paramId } = this._resolved;
    this.bridge.send('/live/device/set/parameter/value', trackId, deviceId, paramId, this.value);
  }
}
