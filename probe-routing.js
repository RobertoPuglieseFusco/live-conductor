// ── PROBE ROUTING ─────────────────────────────────────────────────────────────
// Checks whether AbletonOSC exposes DeviceIO routing — i.e. whether the Audio
// Sends destinations are readable (and settable) rather than something you can
// only infer by opening rows and watching meters.
//
// Requires abletonosc-patch/patch-abletonosc.py to have been applied AND Live
// restarted. Without it every call here times out, which is the expected
// "not installed" result rather than an error in this script.
//
//   node probe-routing.js            read every row's destination
//   node probe-routing.js --verify   also cross-check against mesh-matrix's
//                                    row = track index + 1 assumption
import { LiveBridge } from './osc-bridge.js';
import { TrackMap }   from './track-roles.js';

const VERIFY = process.argv.includes('--verify');
const ROW_OFFSET = 1;

const bridge = await new LiveBridge().open();
const map = new TrackMap(bridge);
await map.resolve();

const ask = async (addr, args) => {
  try { return await bridge.request(addr, args, addr, 2000); }
  catch { return null; }
};

// One probe first, so an unpatched AbletonOSC produces a clear message instead
// of a wall of timeouts.
const first = map.tracks.find(t => t.sendDevice !== null);
if (!first) { console.error('No track has an Audio Sends device.'); process.exit(2); }

const probe = await ask('/live/device/get/num_audio_outputs', [first.id, first.sendDevice]);
if (!probe) {
  console.error('No reply to /live/device/get/num_audio_outputs.\n');
  console.error('AbletonOSC does not expose DeviceIO routing here. Either the patch');
  console.error('is not applied, or Live has not been restarted since applying it:\n');
  console.error('  python3 abletonosc-patch/patch-abletonosc.py --check');
  process.exit(2);
}

console.log('DeviceIO routing is available.\n');

const mismatches = [];
for (const t of map.tracks) {
  if (t.sendDevice === null) { console.log(`${t.name}: no Audio Sends device`); continue; }
  const n = (await ask('/live/device/get/num_audio_outputs', [t.id, t.sendDevice]))?.[2] ?? 0;
  console.log(`${t.name}  (${n} audio outputs)`);

  for (let io = 0; io < n; io++) {
    const type = await ask('/live/device/get/audio_output_routing_type', [t.id, t.sendDevice, io]);
    const chan = await ask('/live/device/get/audio_output_routing_channel', [t.id, t.sendDevice, io]);
    const dest = type?.[3] ?? '?';
    const ch   = chan?.[3] ? `  channel="${chan[3]}"` : '';
    let note = '';

    if (VERIFY) {
      // Confirmed against Live: audio output index IS the row number (out 0 is
      // the device's own output, outs 1..8 are the eight send rows), and
      // mesh-matrix maps row R to track index R - ROW_OFFSET.
      if (io === 0) { console.log(`   out 0  ->  "${dest}"${ch}  (device output, not a send row)`); continue; }
      const expectedId = io - ROW_OFFSET;
      const expected = map.tracks[expectedId]?.name;
      if (expected && dest !== '?' ) {
        const ok = dest === expected;
        note = ok ? '  ✓' : `  ✗ mesh-matrix assumes "${expected}"`;
        if (!ok) mismatches.push({ track: t.name, io, expected, actual: dest });
      }
    }
    console.log(`   out ${io}  ->  "${dest}"${ch}${note}`);
  }
}

if (VERIFY) {
  console.log('\n' + '─'.repeat(56));
  if (mismatches.length) {
    console.log(`${mismatches.length} row(s) disagree with row = track index + ${ROW_OFFSET}:`);
    for (const m of mismatches) console.log(`  ${m.track} out ${m.io}: expected "${m.expected}", actually "${m.actual}"`);
    console.log('\nWith DeviceIO exposed these can now be corrected over OSC via');
    console.log('/live/device/set/audio_output_routing_type — no meter probing needed.');
  } else {
    console.log('every destination matches what mesh-matrix assumes.');
  }
}
process.exit(0);
