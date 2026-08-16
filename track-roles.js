// ── TRACK ROLES ───────────────────────────────────────────────────────────────
// Track names are the only free metadata Live hands you, so the conductor reads
// a ROLE out of the name instead of hardcoding "cello" in three files. Rename a
// track in Live and the machine re-resolves on next start — the same reasoning
// as resolving macros by name rather than by index.
//
// Convention:   [ordinal] [ROLE] [label]
//
//   "1-FX granular"   -> role fx,     label "granular"
//   "2 SRC cello"      -> role source, label "cello"
//   "FX"               -> role fx,     label "fx"
//   "3-Audio"          -> role source, label "Audio"      (no keyword: default)
//   "REF mixdown"      -> role ignore, label "mixdown"
//
// The ordinal prefix is Live's own habit ("1-", "02 ", "3."), stripped before
// matching so renumbering tracks changes nothing.
//
// Roles are advisory labels, not behaviour — what a role MEANS is up to the
// script using it. The conductor treats `fx` and `bus` as send destinations,
// `source` as things that generate audio, and skips `ignore` entirely.
export const DEFAULT_RULES = [
  { role: 'fx',     keywords: ['fx', 'efx', 'effect', 'effects'] },
  { role: 'bus',    keywords: ['bus', 'sum', 'group', 'gr'] },
  { role: 'source', keywords: ['src', 'source', 'in', 'input'] },
  { role: 'ignore', keywords: ['ref', 'reference', 'ignore', 'mute', 'x'] },
];

const ORDINAL = /^\s*\d+\s*[-–—.:_)]?\s*/;   // "1-", "02 ", "3.", "4) "
const SEP     = /^[\s._\-:>|]+/;               // whatever sits between role and label

// A word boundary is the obvious thing to use here and it's wrong: \b doesn't
// break between "FX" and "_1", because underscore is a word character — so
// "FX_1" would read as a source. Match the keyword followed by end-of-name, a
// separator, or a digit instead, which is how people actually name tracks
// (FX_1, FX-2, FX 3, FX4 all mean the same thing).
function keywordMatcher(keywords) {
  return new RegExp(`^(${keywords.join('|')})(?=$|[\\s._\\-:>|]|\\d)`, 'i');
}

// Pure — worth having separate so you can unit-test the convention without Live.
export function parseTrackName(name, rules = DEFAULT_RULES, defaultRole = 'source') {
  const bare = String(name).replace(ORDINAL, '');
  for (const rule of rules) {
    // `match` lets a caller supply a raw regex; `keywords` is the friendly form.
    const re = rule.match ?? keywordMatcher(rule.keywords);
    const m = bare.match(re);
    if (!m) continue;
    const label = bare.slice(m[0].length).replace(SEP, '').trim();
    return { role: rule.role, label: label || m[1].toLowerCase(), matched: true };
  }
  return { role: defaultRole, label: bare.trim() || String(name), matched: false };
}

// The name says what a track is FOR; its devices say what it can actually DO.
// Both matter: a track called "FX" with no Audio Sends can't route anything, and
// knowing that at resolve time beats a silent no-op at bar 33.
export class TrackMap {
  constructor(bridge, { rules = DEFAULT_RULES, defaultRole = 'source', sendDevice = 'Audio Sends' } = {}) {
    this.bridge = bridge;
    this.rules = rules;
    this.defaultRole = defaultRole;
    this.sendDeviceName = sendDevice;
    this.tracks = [];   // [{ id, name, role, label, matched, devices, sendDevice }]
  }

  async resolve() {
    const names = await this.bridge.request('/live/song/get/track_names');
    this.tracks = [];
    for (let id = 0; id < names.length; id++) {
      const { role, label, matched } = parseTrackName(names[id], this.rules, this.defaultRole);
      const devices = (await this.bridge.request('/live/track/get/devices/name', [id])).slice(1);
      const sendDevice = devices.indexOf(this.sendDeviceName);
      this.tracks.push({ id, name: names[id], role, label, matched, devices, sendDevice: sendDevice < 0 ? null : sendDevice });
    }
    return this.tracks;
  }

  byRole(...roles) { return this.tracks.filter(t => roles.includes(t.role)); }
  senders()        { return this.tracks.filter(t => t.sendDevice !== null && t.role !== 'ignore'); }
  find(label)      { return this.tracks.find(t => t.label.toLowerCase() === String(label).toLowerCase()); }

  describe() {
    return this.tracks.map(t =>
      `  ${String(t.id).padStart(2)}  ${t.role.padEnd(6)} ${t.label.padEnd(20)} ` +
      `${t.sendDevice !== null ? `sends@${t.sendDevice}` : '—'}${t.matched ? '' : '  (default role)'}`
    ).join('\n');
  }
}

// Which rows are actually wired is NOT readable over OSC — the destination
// dropdown isn't an automatable parameter. But a row's Enable-NN flag IS, and
// you only ever enable a row you wired, so the enabled set is a faithful
// picture of the live routing. That makes the matrix self-configuring: no
// hand-maintained route table that drifts out of sync with the Live set.
export async function discoverRoutes(bridge, trackMap) {
  const routes = {};
  for (const t of trackMap.senders()) {
    const names  = (await bridge.request('/live/device/get/parameters/name',  [t.id, t.sendDevice])).slice(2);
    const values = (await bridge.request('/live/device/get/parameters/value', [t.id, t.sendDevice])).slice(2);
    const rows = {};
    names.forEach((n, i) => {
      const m = n.match(/^Enable[-\s]?(\d+)$/i);
      if (m && values[i] > 0) rows[`row${m[1]}`] = m[1];   // keep the padded form; findRowParam handles both
    });
    if (Object.keys(rows).length) routes[t.name] = { device: t.sendDevice, rows };
  }
  return routes;
}
