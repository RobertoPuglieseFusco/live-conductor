// ── SENDER MATRIX ─────────────────────────────────────────────────────────────
// One Audio Sends device per source track — confirmed: multiple senders
// converging on the same destination sum rather than override, so this is
// the whole matrix, no receiver device needed anywhere.
//
// A row's DESTINATION isn't an automatable parameter — only its Gain (and an
// enable flag) are — so that mapping lives here, documented once by hand,
// matching whatever you actually wired in Ableton's dropdowns.
//
// routes: { HRM: { device: 0, rows: { B: 3, cello: 1 } }, ... }
//   "HRM" track's Audio Sends is device index 0; row 3 is wired to whatever
//   you're calling "B", row 1 to "cello".
//
// opts:
//   maxDb      what w=1 means, in dB. Defaults to 0 (unity) — Audio Sends will
//              happily go to +24, which is a 24 dB boost you don't want an
//              automated walk to reach by accident.
//   curve      amplitude exponent. w is treated as perceived loudness and
//              squared into amplitude, so w=0.5 lands near -12 dB rather than
//              the -6 dB a linear-amplitude map gives. 1 = linear amplitude.
//   autoEnable when true, setWeight also flips the row's Enable-NN flag. Off by
//              default: which rows are live is part of the routing you wired by
//              hand, so this warns instead of quietly rewriting it.
export class SenderMatrix {
  constructor(bridge, routes, { maxDb = 0, curve = 2, autoEnable = false } = {}) {
    this.bridge = bridge;
    this.routes = routes;
    this.maxDb = maxDb;
    this.curve = curve;
    this.autoEnable = autoEnable;
    this._gainParams = new Map();   // "track>label" -> { trackId, deviceId, paramId, min, max, enableId, enabled }
    this._warned = new Set();
    this.minDbFloor = -69;   // anything at/below the floor reads as silence
  }

  async resolve() {
    const names = await this.bridge.request('/live/song/get/track_names');
    for (const [track, cfg] of Object.entries(this.routes)) {
      const trackId = names.indexOf(track);
      if (trackId < 0) throw new Error(`No track named "${track}". Tracks in this set: ${names.join(', ')}`);

      const paramNames  = (await this.bridge.request('/live/device/get/parameters/name',  [trackId, cfg.device])).slice(2);
      const paramMin    = (await this.bridge.request('/live/device/get/parameters/min',   [trackId, cfg.device])).slice(2);
      const paramMax    = (await this.bridge.request('/live/device/get/parameters/max',   [trackId, cfg.device])).slice(2);
      const paramValues = (await this.bridge.request('/live/device/get/parameters/value', [trackId, cfg.device])).slice(2);

      for (const [label, row] of Object.entries(cfg.rows)) {
        const paramId = findRowParam(paramNames, 'Gain', row);
        if (paramId < 0) throw new Error(
          `"${track}" device ${cfg.device} has no gain parameter for row ${row}. ` +
          `Run inspect-device.js "${track}" ${cfg.device} to see the real names.`
        );
        // Enable-NN is optional — a device without one is just always-on.
        const enableId = findRowParam(paramNames, 'Enable', row);
        this._gainParams.set(`${track}>${label}`, {
          trackId, deviceId: cfg.device, paramId, enableId,
          min: paramMin[paramId], max: paramMax[paramId],
          enabled: enableId < 0 ? true : paramValues[enableId] > 0,
        });
      }
    }
  }

  // w: 0 (silent) to 1 (= maxDb). Curved through amplitude and converted to the
  // parameter's own dB range, so the knob moves the way an ear expects rather
  // than the way a linear interpolation across [-70, +24] would.
  setWeight(fromTrack, toLabel, w) {
    const key = `${fromTrack}>${toLabel}`;
    const p = this._gainParams.get(key);
    if (!p) { console.warn(`[matrix] no route "${fromTrack}" -> "${toLabel}"`); return; }
    w = Math.max(0, Math.min(1, w));

    if (w > 0 && !p.enabled) {
      if (this.autoEnable && p.enableId >= 0) {
        this.bridge.send('/live/device/set/parameter/value', p.trackId, p.deviceId, p.enableId, 1);
        p.enabled = true;
      } else if (!this._warned.has(key)) {
        this._warned.add(key);
        console.warn(`[matrix] "${key}" row is disabled in Audio Sends — gain writes are silent. ` +
                     `Enable it in the device, or construct with { autoEnable: true }.`);
      }
    }

    // w=0 is true silence (the parameter's floor), not just a very small number.
    const db = w === 0 ? p.min : this.maxDb + 20 * this.curve * Math.log10(w);
    const value = Math.max(p.min, Math.min(p.max, db));
    this.bridge.send('/live/device/set/parameter/value', p.trackId, p.deviceId, p.paramId, value);
  }

  // Every resolved route, for drivers that need to read or restore raw state.
  entries() {
    return [...this._gainParams].map(([key, p]) => ({ key, ...p }));
  }

  // Inverse of setWeight's curve. Lets a driver start walking from wherever the
  // set already sits instead of yanking every gain to an arbitrary opening value.
  dbToWeight(db) {
    if (db <= this.minDbFloor) return 0;
    return Math.max(0, Math.min(1, 10 ** ((db - this.maxDb) / (20 * this.curve))));
  }
}

// Audio Sends names its rows zero-padded (Gain-01, Enable-02, ...), so a
// numeric row like 3 has to become "03". Unpadded forms kept as fallbacks.
function findRowParam(paramNames, prefix, row) {
  const pad = String(row).padStart(2, '0');
  for (const candidate of [`${prefix}-${pad}`, `${prefix}-${row}`, `${prefix} ${row}`, `${prefix}${row}`]) {
    const i = paramNames.indexOf(candidate);
    if (i >= 0) return i;
  }
  return -1;
}
