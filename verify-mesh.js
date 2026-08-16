// ── VERIFY MESH ───────────────────────────────────────────────────────────────
// mesh-matrix.js assumes `row = destination track index + 1`. That mapping was
// derived empirically and can't be read back over OSC — an Audio Sends
// destination dropdown isn't an automatable parameter, so nothing can confirm
// it and nothing can repair it. If you rewire a menu by hand, the conductor
// keeps happily sending audio to the wrong place with no error anywhere.
//
// This re-derives the truth the only way available: open one row at a time and
// watch which track's output meter moves. Slow and audible, so it's a
// deliberate check you run after rewiring, not something on every startup.
//
//   node verify-mesh.js                 probe the track that's making sound
//   node verify-mesh.js --from Cello    probe a specific track
//   node verify-mesh.js --rows 8        how many rows to test (default: 8)
//
// Exit code 0 = mapping matches, 1 = mismatch found, 2 = couldn't test.
import { LiveBridge } from './osc-bridge.js';
import { TrackMap }   from './track-roles.js';

const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const FROM      = arg('--from', null);
const ROWS      = +arg('--rows', 8);
const PROBE_DB  = +arg('--probe-db', -6);   // loop gain < 1, so a self-route decays
const ROW_OFFSET = 1;
const HEADROOM  = 0.45;                     // a saturated meter can't show anything added to it
const PAD = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const bridge = await new LiveBridge().open();
const map = new TrackMap(bridge);
await map.resolve();
const names = map.tracks.map(t => t.name);

// ── snapshot everything we might touch, and make damn sure it goes back ──────
const dev = [], pnames = [], params = [], volumes = [];
for (const t of map.tracks) {
  dev[t.id] = t.sendDevice;
  volumes[t.id] = (await bridge.request('/live/track/get/volume', [t.id]))[1];
  if (t.sendDevice === null) continue;
  pnames[t.id] = (await bridge.request('/live/device/get/parameters/name',  [t.id, t.sendDevice])).slice(2);
  params[t.id] = (await bridge.request('/live/device/get/parameters/value', [t.id, t.sendDevice])).slice(2);
}

let restored = false;
async function restore(quietly = false) {
  if (restored) return;
  restored = true;
  for (const t of map.tracks) {
    bridge.send('/live/track/set/volume', t.id, volumes[t.id]);
    if (dev[t.id] === null) continue;
    pnames[t.id].forEach((n, i) => bridge.send('/live/device/set/parameter/value', t.id, dev[t.id], i, params[t.id][i]));
  }
  bridge.send('/live/song/stop_playing');
  await sleep(700);
  if (!quietly) console.log('\nrestored all gains, enables and track volumes; transport stopped.');
}
process.on('SIGINT', async () => { console.log('\ninterrupted —'); await restore(); process.exit(130); });

const set    = (t, n, v) => bridge.send('/live/device/set/parameter/value', t, dev[t], pnames[t].indexOf(n), v);
const meters = async () => { const p = []; for (const t of map.tracks) p[t.id] = (await bridge.request('/live/track/get/output_meter_level', [t.id]))[1]; return p; };
const peaks  = async (ms) => { const p = names.map(() => 0); for (let i = 0; i < ms / 70; i++) { (await meters()).forEach((v, j) => { if (v > p[j]) p[j] = v; }); await sleep(70); } return p; };

try {
  // ── get audio flowing ──────────────────────────────────────────────────────
  for (const t of map.tracks) bridge.send('/live/track/set/volume', t.id, HEADROOM);
  for (const t of map.tracks) if (dev[t.id] !== null)
    for (let r = 1; r <= ROWS; r++) { set(t.id, `Gain-${PAD(r)}`, -70); set(t.id, `Enable-${PAD(r)}`, 1); }
  await sleep(600);

  const nScenes = (await bridge.request('/live/song/get/num_scenes'))[0];
  let src = FROM ? map.tracks.find(t => t.name === FROM || t.label === FROM) : null;
  if (FROM && !src) { console.error(`No track named "${FROM}". Tracks: ${names.join(', ')}`); await restore(true); process.exit(2); }

  // Fire a clip on the source so there's something to measure. Whatever is
  // already playing is preferred — this only fires if nothing is.
  if (!src) {
    for (const t of map.tracks) {
      for (let s = 0; s < nScenes; s++) if ((await bridge.request('/live/clip_slot/get/has_clip', [t.id, s]))[2]) { src = t; src._scene = s; break; }
      if (src) break;
    }
  } else {
    for (let s = 0; s < nScenes; s++) if ((await bridge.request('/live/clip_slot/get/has_clip', [src.id, s]))[2]) { src._scene = s; break; }
  }
  if (!src) { console.error('No track has a clip to make sound with — cannot probe.'); await restore(true); process.exit(2); }
  if (dev[src.id] === null) { console.error(`"${src.name}" has no Audio Sends device.`); await restore(true); process.exit(2); }

  console.log(`probing from "${src.name}" at ${PROBE_DB} dB, ${ROWS} rows\n`);
  if (src._scene !== undefined) bridge.send('/live/clip/fire', src.id, src._scene);
  bridge.send('/live/song/start_playing');
  await sleep(1800);

  const lead = await peaks(900);
  if (lead[src.id] < 0.01) { console.error(`No signal on "${src.name}" — is the clip audible and the track unmuted?`); await restore(); process.exit(2); }

  // ── probe ──────────────────────────────────────────────────────────────────
  // Baseline is re-measured immediately before each row, so reverb tails ringing
  // from the previous probe don't read as a second destination.
  const results = [];
  for (let r = 1; r <= ROWS; r++) {
    const g = `Gain-${PAD(r)}`;
    const pre = await peaks(600);
    set(src.id, g, PROBE_DB);
    await sleep(600);
    const during = await peaks(800);
    set(src.id, g, -70);
    await sleep(400);

    const lit = map.tracks
      .map(t => ({ name: t.name, id: t.id, delta: during[t.id] - pre[t.id] }))
      .filter(x => x.id !== src.id && x.delta > 0.02)
      .sort((a, b) => b.delta - a.delta);

    const expectedId = r - ROW_OFFSET;
    const expected = expectedId === src.id ? `${names[expectedId]} (self)`
                   : expectedId < names.length ? names[expectedId]
                   : null;
    const measured = lit.length ? lit[0].name : null;
    const verdict = expectedId === src.id ? 'self'                     // can't see our own return
                  : expected === null && measured === null ? 'unused'   // row wired to nothing, as expected
                  : expected === measured ? 'ok'
                  : 'MISMATCH';
    results.push({ row: r, expected, measured, verdict });
    console.log(`  row${PAD(r)}  expected ${String(expected ?? '—').padEnd(12)} measured ${String(measured ?? '—').padEnd(12)} ${verdict}`);
  }

  const bad = results.filter(r => r.verdict === 'MISMATCH');
  const selfRows = results.filter(r => r.verdict === 'self');
  console.log('\n' + '─'.repeat(60));
  if (bad.length) {
    console.log(`${bad.length} row(s) do NOT match "row = track index + ${ROW_OFFSET}":\n`);
    for (const r of bad) console.log(`  row${PAD(r.row)}: mesh-matrix will send to "${r.expected}" but it actually reaches "${r.measured ?? 'nothing'}"`);
    console.log('\nFix the destination dropdown in the Audio Sends device — it is not');
    console.log('settable over OSC, so this cannot be repaired from here.');
  } else {
    console.log(`mapping confirmed: row = track index + ${ROW_OFFSET}`);
    if (selfRows.length) console.log(`(row${PAD(selfRows[0].row)} is "${src.name}"'s own return — not observable from this source; probe with --from another track to cover it)`);
  }
  await restore();
  process.exit(bad.length ? 1 : 0);
} catch (err) {
  console.error('\nprobe failed:', err.message);
  await restore();
  process.exit(2);
}
