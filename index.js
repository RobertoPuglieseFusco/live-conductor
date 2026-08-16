// ── LIVE CONDUCTOR ────────────────────────────────────────────────────────────
// Minimal worked example. Assumes:
//   - AbletonOSC installed as the selected Control Surface in Live.
//   - A track named "cello" feeding a Rack (any name) with macros including
//     "grain wet" and "density" — swap the names below for your own set.
//   - Scenes 0..2 roughly mean: sparse / building / dense. Adjust the
//     transition weights to taste, or add more scenes.
import { LiveBridge }   from './osc-bridge.js';
import { Transport }    from './transport.js';
import { SceneWalker }  from './scene-walker.js';
import { MacroWalker }  from './macro-walker.js';

const bridge = await new LiveBridge().open();
console.log('Connected — waiting for Live...');
await bridge.request('/live/application/get/version', [], '/live/application/get/version', 5000)
  .then(([maj, min]) => console.log(`Live ${maj}.${min}`));

const transport = new Transport(bridge);

// Sparse mostly stays or nudges into building; dense wants to fall back to
// sparse eventually rather than climax forever — a shape, not just noise.
const scenes = new SceneWalker(bridge, {
  weights: {
    0: { 0: 5, 1: 3 },
    1: { 0: 2, 1: 3, 2: 3 },
    2: { 1: 4, 2: 3, 0: 1 },
  },
});

const macros = [
  new MacroWalker(bridge, { trackName: 'cello', deviceName: 'texture rack', macroName: 'grain wet', stepPct: 0.06 }),
  new MacroWalker(bridge, { trackName: 'cello', deviceName: 'texture rack', macroName: 'density',   stepPct: 0.10 }),
];
for (const m of macros) await m.resolve().catch(e => console.warn('[macro]', e.message));

await transport.start();
console.log(`Transport locked — ${transport.numerator}/4, following Live's clock.`);

// Structure: a scene change every 8 bars, macro drift every bar. Both derive
// from Live's real beat clock, so they never drift relative to what's playing
// — the thing the browser engine's setTimeout sequencers explicitly can't do.
transport.onBar(8, () => { const s = scenes.step(); console.log(`bar ${transport.beat / transport.numerator} → scene ${s}`); });
transport.onBar(1, () => macros.forEach(m => m.step()));

process.on('SIGINT', () => { bridge.send('/live/song/stop_playing'); process.exit(0); });
