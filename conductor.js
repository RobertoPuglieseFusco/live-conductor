// ── CONDUCTOR ─────────────────────────────────────────────────────────────────
// The matrix version of index.js: instead of walking Rack macros on a named
// "cello" track, this discovers the set's own routing and drifts it on Live's
// beat clock. Nothing is hardcoded — roles come from track names
// (see track-roles.js) and live routes come from which Audio Sends rows you
// actually enabled, so it runs against any set built that way.
//
//   node conductor.js            walk the discovered routes
//   node conductor.js --dry      resolve, print the map, change nothing
import { LiveBridge }              from './osc-bridge.js';
import { Transport }               from './transport.js';
import { SenderMatrix }            from './sender-matrix.js';
import { TrackMap, discoverRoutes} from './track-roles.js';

const DRY      = process.argv.includes('--dry');
const STEP_PCT = 0.12;   // how far a route's weight can move in one bar
const EVERY_N  = 1;      // bars between steps

const bridge = await new LiveBridge().open();
const [maj, min] = await bridge.request('/live/application/get/version', [], '/live/application/get/version', 5000)
  .catch(() => { console.error('No reply from AbletonOSC. Is Live open with AbletonOSC as the Control Surface?'); process.exit(1); });
console.log(`Live ${maj}.${min}`);

// ── what's in the set ────────────────────────────────────────────────────────
const map = new TrackMap(bridge);
await map.resolve();
console.log(`\nTracks:\n${map.describe()}`);

const routes = await discoverRoutes(bridge, map);
if (!Object.keys(routes).length) {
  console.error('\nNo enabled Audio Sends rows found — nothing to drive.');
  console.error('Enable at least one row in an Audio Sends device, then re-run.');
  process.exit(1);
}

const matrix = new SenderMatrix(bridge, routes);
await matrix.resolve();
const entries = matrix.entries();
console.log(`\nRoutes (${entries.length}):`);
for (const e of entries) console.log(`  ${e.key}  ->  param ${e.paramId}  [${e.min}..${e.max}] dB`);

// ── remember where the set started, so Ctrl-C puts it back ───────────────────
const original = new Map();
for (const e of entries) {
  const db = (await bridge.request('/live/device/get/parameter/value', [e.trackId, e.deviceId, e.paramId]))[3];
  original.set(e.key, db);
}

if (DRY) { console.log('\n--dry: resolved only, nothing changed.'); process.exit(0); }

// ── the walk ─────────────────────────────────────────────────────────────────
// Each route gets its own bounded random walk, reflecting off 0 and 1 so it
// keeps drifting instead of parking at an edge. Starting weight is read back
// from the set, so bar 1 continues from your mix rather than overriding it.
const weights = new Map(entries.map(e => [e.key, matrix.dbToWeight(original.get(e.key))]));

function drift() {
  for (const [key, w] of weights) {
    let next = w + (Math.random() * 2 - 1) * STEP_PCT;
    if (next < 0) next = -next;
    if (next > 1) next = 2 - next;
    weights.set(key, Math.max(0, Math.min(1, next)));
    const [track, label] = key.split('>');
    matrix.setWeight(track, label, weights.get(key));
  }
}

const transport = new Transport(bridge);
await transport.start();
console.log(`\nTransport locked — ${transport.numerator}/4, following Live's clock.`);
console.log('Press play in Live. Ctrl-C restores every gain to where it started.\n');

let beats = 0;
transport.onBeat(() => beats++);
transport.onBar(EVERY_N, (bar) => {
  drift();
  const shown = [...weights].map(([k, w]) => `${k}=${w.toFixed(2)}`).join('  ');
  console.log(`bar ${String(bar).padStart(4)}  ${shown}`);
});

// Beat events only arrive while Live is actually playing — without this the
// process just sits there looking healthy and doing nothing.
setTimeout(() => {
  if (beats === 0) console.warn('[transport] no beats yet — is Live playing? (this is not an error)');
}, 4000);

process.on('SIGINT', () => {
  console.log('\nrestoring original gains...');
  for (const e of entries) {
    bridge.send('/live/device/set/parameter/value', e.trackId, e.deviceId, e.paramId, original.get(e.key));
  }
  // send() only queues the UDP writes — give them a tick to actually leave.
  setTimeout(() => { console.log('done.'); process.exit(0); }, 250);
});
