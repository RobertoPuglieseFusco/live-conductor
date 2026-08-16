# live-conductor

An external, procedural "brain" for an Ableton Live set, talking over OSC via
[AbletonOSC](https://github.com/ideoforms/AbletonOSC). Node owns the
macro-time decisions (scene structure, section arcs, slow parameter drift);
Live owns anything audio-rate.

## Setup

1. **Install AbletonOSC** — download
   [the repo](https://github.com/ideoforms/AbletonOSC), unzip, rename the
   folder to `AbletonOSC`, and copy it into Live's Remote Scripts folder
   (macOS: `~/Music/Ableton/User Library/Remote Scripts`). Restart Live.
2. In **Preferences → Link/Tempo/MIDI**, set the Control Surface dropdown to
   **AbletonOSC**. Live should report *"AbletonOSC: Listening for OSC on port
   11000."*
3. In your Live set: a track named `cello` (or edit `index.js`), a Rack on it
   with macros named `grain wet` and `density`, and at least 3 scenes.
4. `npm install`
5. `node index.js`

## Shape of the thing

- `osc-bridge.js` — send/request/listen over UDP to AbletonOSC.
- `transport.js` — beat/bar clock, driven by Live's *actual* playback
  (`/live/song/start_listen/beat`), not a local timer.
- `scene-walker.js` — weighted-random scene transitions (a Markov-ish
  Arpeggiator, but for scenes instead of notes).
- `macro-walker.js` — bounded random walk on a named Rack macro, resolved by
  name once at startup so it survives you rebuilding the Rack.
- `index.js` — wires it together into one small evolving structure.

## The matrix (current approach): Audio Sends per track

Confirmed by hand: multiple `Audio Sends` devices on different tracks, both
aimed at the same destination, **sum** rather than override — so a single
uniform device per track, weighted by its Gain knobs, is the whole matrix.
No receiver device, no Return tracks, no Group tracks needed.

Setup per track: drop `Audio Sends` (from Cycling '74's free **Audio
Routes** pack) on it, wire up whichever destination rows you actually want
in the device's own UI (that assignment isn't automatable — only Gain and
Enable per row are — so it's a one-time manual step), and leave the ones you
don't need yet off.

```js
import { SenderMatrix } from './sender-matrix.js';

const matrix = new SenderMatrix(bridge, {
  HRM: { device: 0, rows: { B: 3, cello: 1 } },   // HRM's row 3 → "B", row 1 → cello
  FM:  { device: 0, rows: { A: 1, C: 2 } },
});
await matrix.resolve();

matrix.setWeight('HRM', 'B', 0.7);
```

`setWeight(from, to, w)` takes `w` from 0 to 1: 0 is silence, 1 is unity gain
(0 dB), and in between `w` is squared into amplitude — so `w = 0.5` lands near
−12 dB rather than the −35 dB a linear map across the parameter's real
[−70, +24] dB range would give. Pass `{ maxDb: 24 }` if you actually want to
reach the device's boost range; the default deliberately won't.

Only rows whose `Enable-NN` flag is on in the device pass audio, so a gain write
to a disabled row does nothing audible. `resolve()` reads those flags and
`setWeight` warns once per route if you drive a disabled one — pass
`{ autoEnable: true }` to have it flip the flag for you instead of warning.

## The mesh (what the matrix actually is)

If every track's `Audio Sends` is wired to every track, the routing is a plain
N×N matrix and the *gain* decides who hears whom. Where a row points isn't
readable over OSC, so it was derived by opening one row at a time and watching
`/live/track/get/output_meter_level`:

    row02 -> track 1    row03 -> track 2    row04 -> track 3
    => row = destination track index + 1

Probed from two different source tracks with identical results, so the wiring is
uniform and the arithmetic holds. `mesh-matrix.js` builds on that, letting you
address routes by name instead of by row number:

```js
const map  = new TrackMap(bridge);   await map.resolve();
const mesh = new MeshMatrix(bridge, map); await mesh.resolve();

mesh.setWeight('Cello', 'FX_1', 0.7);
console.log(mesh.render(weights));   // an N×N grid: rows send, columns receive
```

Self-routes are excluded unless you pass `{ includeSelf: true }` — a track
sending to itself is a feedback loop, which is worth opting into deliberately
rather than getting by default. If you rewire the dropdowns, change `rowOffset`
and nothing else moves.

`node conductor.js --dry` prints the resolved mesh and changes nothing.

### When a destination menu gets rewired

An `Audio Sends` destination dropdown is **not** an automatable parameter, so it
can be neither read nor set over OSC — `device.py` in AbletonOSC exposes only
parameter get/set. Rewire one by hand and the conductor will keep sending audio
to the wrong track with no error anywhere.

`verify-mesh.js` re-derives the truth the only way available — opening one row
at a time and watching output meters — and tells you which row lies:

    npm run verify                  probe whichever track is making sound
    node verify-mesh.js --from FX_1 probe a specific track

Exit 0 means the mapping holds, 1 means a row is mis-wired, 2 means it couldn't
test (no audio). It snapshots every gain, enable and track volume and restores
them on exit, including on Ctrl-C. It's audible and takes a minute, so run it
after rewiring rather than on every startup.

Note it can't verify a source's own return row — a track can't hear itself
arrive — so probe from a second track to cover that one.

Native *track* routing is a different story and fully settable:
`/live/track/set/output_routing_type` matches on display name, and Live
enumerates the other tracks as options. That's one destination per track, so it
complements the mesh rather than replacing it.

Run `inspect-device.js` on a track with `Audio Sends` loaded before trusting
any of this — it'll show the real parameter names and ranges, which
`resolve()` needs to match.

`send-matrix.js`, `receiver-matrix.js`, and `group-matrix.js` are earlier
designs explored along the way (Return-track sends, Max for Live receiver
knobs, all-native group tracks) — kept here for reference, superseded by
this one.

## Where to go next

- Feed cello analysis (RMS, pitch, spectral centroid) from the granular
  engine's analyser nodes into this process over a WebSocket, and use it in
  place of / alongside the random walks — same shape as `DataMapper.js`, new
  destination.
- Replace the flat scene-transition table with something that reacts to
  `/live/track/get/output_meter_level` — e.g. don't advance to "dense" until
  the cello's actually been quiet for N bars, so the machine is listening,
  not just running a clock.
- `/live/clip/add/notes` lets the conductor write MIDI directly into a clip
  before firing it — useful if you want Live 12's Euclidean/Stacks generators
  seeded procedurally rather than by hand.
