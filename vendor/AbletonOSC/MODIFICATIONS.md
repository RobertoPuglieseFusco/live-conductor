# Modifications to AbletonOSC

This is a vendored copy of [AbletonOSC](https://github.com/ideoforms/AbletonOSC)
by Daniel John Jones and contributors, MIT licensed — see `LICENSE.md`, which is
unchanged. Everything here is upstream except the one addition below.

## DeviceIO audio output routing

**File:** `abletonosc/device.py`, inside `DeviceHandler.init_api()`, marked by
`# --- live-conductor: DeviceIO routing ---`.

Upstream exposes device *parameters* but nothing about a device's audio
input/output routing. That matters for the Audio Routes **Audio Sends** device:
each of its 8 send rows has a destination that is *not* an automatable
parameter, so it never appears in `/live/device/get/parameters`, and there is no
other handler that reaches it.

It looks unreachable, and it isn't. Reading `Audio Sends.amxd` (not frozen —
its patcher is plain JSON behind a 61-byte chunk header) shows the destination
`umenu` is only a *view* of a Live API property. The routing sub-patch drives:

    live.observer available_routing_channels
    RoutingObjects2 available_routing_types routing_type

Those are `DeviceIO` properties — `device.audio_outputs[n].routing_type` — in
the Live API since 10.1. The gap was on the AbletonOSC side, not Live's.

### Added handlers

| address | params | returns |
| --- | --- | --- |
| `/live/device/get/num_audio_outputs` | track, device | count |
| `/live/device/get/audio_output_routing_type` | track, device, io | io, display name |
| `/live/device/set/audio_output_routing_type` | track, device, io, name | — |
| `/live/device/get/available_audio_output_routing_types` | track, device, io | io, names… |
| `/live/device/get/audio_output_routing_channel` | track, device, io | io, display name |
| `/live/device/set/audio_output_routing_channel` | track, device, io, name | — |
| `/live/device/get/available_audio_output_routing_channels` | track, device, io | io, names… |

Destinations are matched by **display name**, exactly as upstream's `track.py`
already does for track routing, so they survive renaming tracks. An unmatched
name logs a warning rather than raising.

### Verified against Live 12.4

Each `Audio Sends` device reports **9** audio outputs. Output 0 is the device's
own output; outputs 1–8 are the eight send rows — so the audio output index *is*
the row number.

    out 1 -> "Cello"   out 2 -> "FX_1"   out 3 -> "FX_2"   out 4 -> "FX_3"
    out 5..8 -> "No Output"

Writing was confirmed too: setting output 5 to `FX_2` read back as `FX_2`, and
restoring it to `No Output` succeeded.

## Installing

This copy is the reference. To install it into Live:

    # back up first, then:
    rsync -a --exclude='__pycache__' --exclude='logs' \
      vendor/AbletonOSC/ ~/Music/Ableton/User\ Library/Remote\ Scripts/AbletonOSC/

Then **restart Live** — Remote Scripts load only at startup.

Alternatively, `abletonosc-patch/patch-abletonosc.py` applies just this change to
an existing install, backing up `device.py` first and reverting with `--revert`.
That's the better route if your AbletonOSC is newer than this copy.

## Upstreaming

This is a small, general addition — nothing about it is specific to Audio Sends
or to this project — so it's a reasonable pull request against
`ideoforms/AbletonOSC` if you ever want to stop carrying a fork.
