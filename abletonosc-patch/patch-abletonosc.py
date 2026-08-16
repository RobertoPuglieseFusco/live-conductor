#!/usr/bin/env python3
"""
Teach AbletonOSC to read and set an Audio Sends destination.

The Audio Routes "Audio Sends" device looks like it hides its destinations in
Max — the dropdown isn't an automatable parameter, so /live/device/get/parameters
never shows it. Reading the device's patcher shows otherwise: the umenu is only
a VIEW of a Live API property. The routing sub-patch drives

    live.observer available_routing_channels
    RoutingObjects2 available_routing_types routing_type

which are DeviceIO properties — device.audio_outputs[n].routing_type, added to
the Live API in 10.1. The destination has always been in the object model.
AbletonOSC simply never exposed that path: it has no DeviceIO support and no
generic LOM accessor.

This adds the missing handlers:

    /live/device/get/num_audio_outputs                      track, device
    /live/device/get/audio_output_routing_type              track, device, io_index
    /live/device/set/audio_output_routing_type              track, device, io_index, name
    /live/device/get/available_audio_output_routing_types   track, device, io_index
    ...and the same three for routing_channel.

Destinations are matched by display name, exactly as track.py already does for
track routing, so they survive renaming tracks.

    python3 patch-abletonosc.py            apply (backs up device.py first)
    python3 patch-abletonosc.py --revert   restore the backup
    python3 patch-abletonosc.py --check    report status only

Live must be RESTARTED afterwards — Remote Scripts are loaded once at startup.
"""
import sys
import shutil
import pathlib

DEVICE_PY = pathlib.Path.home() / "Music/Ableton/User Library/Remote Scripts/AbletonOSC/abletonosc/device.py"
BACKUP = DEVICE_PY.with_suffix(".py.pre-deviceio-backup")
MARKER = "# --- live-conductor: DeviceIO routing ---"

BLOCK = '''
        ''' + MARKER + '''
        # A device's audio_outputs are DeviceIO objects carrying the same
        # routing_type / routing_channel properties a track has. That is where
        # Audio Sends actually stores each row's destination — the umenu in the
        # Max patch is only a view of this. Matched by display name, the way
        # track.py already does it, so the mapping survives renaming tracks.
        def _device_io(device, index):
            return device.audio_outputs[int(index)]

        def device_get_num_audio_outputs(device, params: Tuple[Any] = ()):
            return len(device.audio_outputs),

        def make_io_getter(prop):
            def getter(device, params: Tuple[Any] = ()):
                index = int(params[0])
                value = getattr(_device_io(device, index), prop)
                return index, (value.display_name if value is not None else "")
            return getter

        def make_io_lister(available_prop):
            def lister(device, params: Tuple[Any] = ()):
                index = int(params[0])
                items = getattr(_device_io(device, index), available_prop)
                return (index, *[item.display_name for item in items])
            return lister

        def make_io_setter(prop, available_prop):
            def setter(device, params: Tuple[Any] = ()):
                index, name = int(params[0]), params[1]
                io = _device_io(device, index)
                for candidate in getattr(io, available_prop):
                    if candidate.display_name == name:
                        setattr(io, prop, candidate)
                        return
                self.logger.warning("Couldn't find %s '%s' on audio output %d" % (prop, name, index))
            return setter

        self.osc_server.add_handler("/live/device/get/num_audio_outputs",
                                    create_device_callback(device_get_num_audio_outputs))
        for _prop, _avail in (("routing_type", "available_routing_types"),
                              ("routing_channel", "available_routing_channels")):
            self.osc_server.add_handler("/live/device/get/audio_output_%s" % _prop,
                                        create_device_callback(make_io_getter(_prop)))
            self.osc_server.add_handler("/live/device/get/available_audio_output_%ss" % _prop,
                                        create_device_callback(make_io_lister(_avail)))
            self.osc_server.add_handler("/live/device/set/audio_output_%s" % _prop,
                                        create_device_callback(make_io_setter(_prop, _avail)))
        # --- end live-conductor ---
'''

ANCHOR = ("        #--------------------------------------------------------------------------------\n"
          "        # Device: Get/set parameter lists")


def main():
    if not DEVICE_PY.exists():
        sys.exit("Not found: %s\nIs AbletonOSC installed in Remote Scripts?" % DEVICE_PY)

    src = DEVICE_PY.read_text()
    applied = MARKER in src

    if "--check" in sys.argv:
        print("device.py:      %s" % DEVICE_PY)
        print("patch applied:  %s" % applied)
        print("backup exists:  %s" % BACKUP.exists())
        return

    if "--revert" in sys.argv:
        if not BACKUP.exists():
            sys.exit("No backup found — nothing to revert to.")
        shutil.copy2(BACKUP, DEVICE_PY)
        print("reverted %s from backup. Restart Live." % DEVICE_PY.name)
        return

    if applied:
        print("Already patched; nothing to do.")
        return

    if ANCHOR not in src:
        sys.exit("Couldn't find the insertion point — AbletonOSC's device.py has changed.\n"
                 "Apply the BLOCK in this file by hand inside DeviceHandler.init_api().")

    if not BACKUP.exists():
        shutil.copy2(DEVICE_PY, BACKUP)
        print("backed up -> %s" % BACKUP.name)

    DEVICE_PY.write_text(src.replace(ANCHOR, BLOCK + "\n" + ANCHOR))

    import py_compile
    py_compile.compile(str(DEVICE_PY), doraise=True)
    print("patched %s (syntax OK)" % DEVICE_PY.name)
    print("\nNow RESTART ABLETON LIVE — Remote Scripts only load at startup.")
    print("Then run: node probe-routing.js")


main()
