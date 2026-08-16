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
export class SenderMatrix {
  constructor(bridge, routes) {
    this.bridge = bridge;
    this.routes = routes;
    this._gainParams = new Map();   // "track>label" -> { trackId, deviceId, paramId, min, max }
  }

  async resolve() {
    const names = await this.bridge.request('/live/song/get/track_names');
    for (const [track, cfg] of Object.entries(this.routes)) {
      const trackId = names.indexOf(track);
      if (trackId < 0) throw new Error(`No track named "${track}"`);

      const paramNames = (await this.bridge.request('/live/device/get/parameters/name', [trackId, cfg.device])).slice(2);
      const paramMin    = (await this.bridge.request('/live/device/get/parameters/min',  [trackId, cfg.device])).slice(2);
      const paramMax    = (await this.bridge.request('/live/device/get/parameters/max',  [trackId, cfg.device])).slice(2);

      for (const [label, row] of Object.entries(cfg.rows)) {
        const paramId = findGainParam(paramNames, row);
        if (paramId < 0) throw new Error(
          `"${track}" device ${cfg.device} has no gain parameter for row ${row}. ` +
          `Run inspect-device.js "${track}" ${cfg.device} to see the real names.`
        );
        this._gainParams.set(`${track}>${label}`, {
          trackId, deviceId: cfg.device, paramId,
          min: paramMin[paramId], max: paramMax[paramId],
        });
      }
    }
  }

  // w: 0 (silent) to 1 (fully open) — scaled onto that parameter's own real
  // min/max range, whatever it turns out to be (dB, linear, whatever).
  setWeight(fromTrack, toLabel, w) {
    const p = this._gainParams.get(`${fromTrack}>${toLabel}`);
    if (!p) { console.warn(`[matrix] no route "${fromTrack}" -> "${toLabel}"`); return; }
    w = Math.max(0, Math.min(1, w));
    const value = p.min + w * (p.max - p.min);
    this.bridge.send('/live/device/set/parameter/value', p.trackId, p.deviceId, p.paramId, value);
  }
}

function findGainParam(paramNames, row) {
  for (const candidate of [`Gain-${row}`, `Gain ${row}`, `Gain${row}`]) {
    const i = paramNames.indexOf(candidate);
    if (i >= 0) return i;
  }
  return -1;
}
