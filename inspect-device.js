// ── INSPECT DEVICE ────────────────────────────────────────────────────────────
// One-off utility, not part of the conductor proper. Point it at a track to
// list its devices; point it at a device to dump every parameter name and
// current value. Use this on Audio Matrix (or anything else) before designing
// around it — no need to guess what's automatable.
//
// Usage:
//   node inspect-device.js "1 Audio"        list devices on that track
//   node inspect-device.js "1 Audio" 0      dump device 0's parameters
import { LiveBridge } from './osc-bridge.js';

const TRACK_NAME = process.argv[2];
const DEVICE_ID  = process.argv[3] !== undefined ? +process.argv[3] : null;

if (!TRACK_NAME) {
  console.error('Usage: node inspect-device.js "<track name>" [device index]');
  process.exit(1);
}

const bridge = await new LiveBridge().open();

const names = await bridge.request('/live/song/get/track_names');
const trackId = names.indexOf(TRACK_NAME);
if (trackId < 0) {
  console.error(`No track named "${TRACK_NAME}". Tracks in this set: ${names.join(', ')}`);
  process.exit(1);
}

const deviceNames = (await bridge.request('/live/track/get/devices/name', [trackId])).slice(1);

if (DEVICE_ID === null) {
  console.log(`Devices on "${TRACK_NAME}":`);
  deviceNames.forEach((n, i) => console.log(`  ${i}: ${n}`));
  console.log(`\nRe-run with a device index to see its parameters:`);
  console.log(`  node inspect-device.js "${TRACK_NAME}" 0`);
  process.exit(0);
}

const paramNames  = (await bridge.request('/live/device/get/parameters/name',  [trackId, DEVICE_ID])).slice(2);
const paramValues = (await bridge.request('/live/device/get/parameters/value', [trackId, DEVICE_ID])).slice(2);
const paramMin    = (await bridge.request('/live/device/get/parameters/min',   [trackId, DEVICE_ID])).slice(2);
const paramMax    = (await bridge.request('/live/device/get/parameters/max',   [trackId, DEVICE_ID])).slice(2);

console.log(`Parameters on "${TRACK_NAME}" → ${deviceNames[DEVICE_ID]}:`);
paramNames.forEach((n, i) => console.log(`  ${i}: ${n} = ${paramValues[i]}  [${paramMin[i]} .. ${paramMax[i]}]`));
process.exit(0);
