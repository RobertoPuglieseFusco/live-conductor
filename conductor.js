// ── CONDUCTOR ─────────────────────────────────────────────────────────────────
// The matrix version of index.js: instead of walking Rack macros on a named
// "cello" track, this reads the set's own shape and drifts the routing between
// tracks on Live's beat clock. Nothing is hardcoded — roles come from track
// names (track-roles.js) and the send matrix is derived arithmetically
// (mesh-matrix.js) — so it runs against any set built the same way.
//
//   node conductor.js            walk the mesh
//   node conductor.js --dry      resolve, print the matrix, change nothing
import { LiveBridge } from './osc-bridge.js';
import { Transport }  from './transport.js';
import { TrackMap }   from './track-roles.js';
import { MeshMatrix } from './mesh-matrix.js';

const DRY     = process.argv.includes('--dry');
const EVERY_N = 1;    // bars between steps

// Roles earn their keep here: how far a route is allowed to move in one bar
// depends on what it connects. Feeding an effect is where the interest is, so
// it moves most; effect-into-effect is the runaway-feedback direction, so it
// creeps. Retune freely — this is the musical decision, not an implementation
// detail.
const STEP = { 'source>fx': 0.12, 'source>bus': 0.10, 'fx>fx': 0.04, default: 0.06 };
const stepFor = (fromRole, toRole) => STEP[`${fromRole}>${toRole}`] ?? STEP.default;

const bridge = await new LiveBridge().open();
const [maj, min] = await bridge.request('/live/application/get/version', [], '/live/application/get/version', 5000)
  .catch(() => { console.error('No reply from AbletonOSC. Is Live open with AbletonOSC as the Control Surface?'); process.exit(1); });
console.log(`Live ${maj}.${min}`);

const map = new TrackMap(bridge);
await map.resolve();
console.log(`\nTracks:\n${map.describe()}`);

const mesh = new MeshMatrix(bridge, map);
await mesh.resolve();
const pairs = mesh.pairs();
if (!pairs.length) { console.error('\nNo send routes resolved — is there an Audio Sends device anywhere?'); process.exit(1); }

const roleOf = Object.fromEntries(map.tracks.map(t => [t.name, t.role]));

// Read where the set already sits, so bar 1 continues the mix instead of
// overriding it — and so Ctrl-C can put every gain back exactly.
const original = new Map();
for (const p of pairs) {
  original.set(p.key, (await bridge.request('/live/device/get/parameter/value', [p.trackId, p.deviceId, p.paramId]))[3]);
}
const weights = new Map(pairs.map(p => [p.key, mesh.dbToWeight(original.get(p.key))]));

console.log(`\nMesh (${pairs.length} routes), current weights:\n`);
console.log(mesh.render(weights));

if (DRY) { console.log('\n--dry: resolved only, nothing changed.'); process.exit(0); }

function drift() {
  for (const p of pairs) {
    const pct = stepFor(roleOf[p.from], roleOf[p.to]);
    let next = weights.get(p.key) + (Math.random() * 2 - 1) * pct;
    if (next < 0) next = -next;            // reflect rather than clamp, so it
    if (next > 1) next = 2 - next;         // keeps drifting instead of parking
    weights.set(p.key, Math.max(0, Math.min(1, next)));
    mesh.setWeight(p.from, p.to, weights.get(p.key));
  }
}

const transport = new Transport(bridge);
await transport.start();
console.log(`\nTransport locked — ${transport.numerator}/4, following Live's clock.`);
console.log('Press play in Live. Ctrl-C restores every gain to where it started.\n');

let beats = 0;
let stopping = false;   // see the SIGINT handler
transport.onBeat(() => beats++);
transport.onBar(EVERY_N, (bar) => {
  if (stopping) return;
  drift();
  console.log(`\nbar ${bar}\n${mesh.render(weights)}`);
});

// Beat events only arrive while Live is actually playing — without this the
// process just sits there looking healthy and doing nothing.
setTimeout(() => {
  if (beats === 0) console.warn('[transport] no beats yet — is Live playing? (this is not an error)');
}, 4000);

// Restoring isn't instant: the UDP writes need a tick to flush, and beat events
// keep arriving the whole time. Without the `stopping` guard a bar boundary
// landing inside that window re-drifts every gain AFTER the restore was sent,
// and the process exits leaving the set wrong — roughly 1 in 10 at 90bpm, and
// it would look like Ableton's fault.
process.on('SIGINT', () => {
  if (stopping) return;
  stopping = true;
  console.log('\nrestoring original gains...');
  for (const p of pairs) {
    bridge.send('/live/device/set/parameter/value', p.trackId, p.deviceId, p.paramId, original.get(p.key));
  }
  setTimeout(() => { bridge.close(); console.log('done.'); process.exit(0); }, 300);
});
