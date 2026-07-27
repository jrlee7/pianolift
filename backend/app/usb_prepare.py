"""Turn a blank USB stick into a Gotek/Nalbantov floppy-emulator stick.

The 1995 Disklavier only reads floppies. A Gotek/Nalbantov emulator fakes
them out of a FAT32 USB stick whose root holds:

  HXCSDFE.CFG    HxC firmware settings. The emulator mounts nothing without
                 it, so it is cloned byte-for-byte from a working Nalbantov
                 stick (see _CFG_HEAD below) rather than reconstructed.
  SWAPMEM.BIN    empty scratch file the firmware expects to exist.
  DSKA0000.hfe   one 720KB floppy image per emulator slot, picked by the
  ...            slot number on the emulator's display.

Every slot is written as a Disklavier-formatted blank: the same FAT12
geometry disk_writer builds for real songs, carrying only an empty
PIANODIR.FIL catalog. That is exactly what usb.is_blank_slot() calls free,
so the rest of the app fills a freshly prepared stick the same way it fills
a factory one.

Two constraints drive the safety checks:
  * the firmware's own FAT reader wants unfragmented files, so a prepare
    targets an empty drive - sequential writes onto fresh free space land
    contiguously;
  * a stick already full of DSKAxxxx.hfe may be the user's whole song
    library, so overwriting one is refused unless the caller forces it.
"""

import base64
import os
import threading

from . import disk_writer, usb

# Bytes per slot image: 512 header + 512 track LUT + 80 tracks x 49 blocks.
SLOT_BYTES = 2008064

# Slots on a factory Nalbantov stick. The emulator's display is 3 digits, so
# 1000 is also the hard ceiling.
DEFAULT_SLOTS = 1000
MAX_SLOTS = 1000

# HXCSDFE.CFG is 8192 bytes of which only the first 40 are non-zero.
_CFG_HEAD = base64.b64decode(
    "SFhDRkVDRkdWMS4wAAAAAP//FBQAQAAepQAA6JYA////BwAA/wcAAA==")
HXCSDFE_CFG = _CFG_HEAD + b"\x00" * (8192 - len(_CFG_HEAD))

# Directories Windows/macOS drop on a stick by themselves. Their presence
# does not make a drive "not blank".
_OS_JUNK = {"system volume information", "$recycle.bin", ".fseventsd",
            ".spotlight-v100", ".trashes", "found.000", "desktop.ini",
            "autorun.inf", ".ds_store"}

# Files a prepare owns and will replace without comment.
_OURS = {"hxcsdfe.cfg", "swapmem.bin"}

_blank_cache = None
_blank_lock = threading.Lock()


def blank_hfe():
    """A Disklavier-formatted empty 720K floppy as an .hfe image.

    Encoding one costs a couple of seconds of pure-Python MFM work, and every
    slot on a fresh stick is the same bytes, so it is built once and reused."""
    global _blank_cache
    with _blank_lock:
        if _blank_cache is None:
            pianodir = disk_writer.build_pianodir([])
            img = disk_writer.build_fat12([("PIANODIRFIL", pianodir)])
            _blank_cache = disk_writer.img_to_hfe(img)
        return _blank_cache


def _norm_root(drive):
    """Accept 'G', 'G:', 'G:\\' or 'G:/' and return 'G:\\'."""
    if not drive:
        raise ValueError("no drive given")
    d = str(drive).strip().rstrip("\\/")
    if len(d) == 1:
        d += ":"
    if len(d) != 2 or d[1] != ":" or not d[0].isalpha():
        raise ValueError("not a drive letter: " + str(drive))
    return d[0].upper() + ":\\"


def _size(root, name):
    try:
        return os.path.getsize(os.path.join(root, name))
    except OSError:
        return 0


def inspect(drive, slots=DEFAULT_SLOTS):
    """What preparing `drive` would involve, without touching it.

    Returns a dict the UI renders directly:
      blockers  reasons the prepare cannot run at all
      warnings  data that would be destroyed (needs force=True to proceed)
    """
    root = _norm_root(drive)
    slots = max(1, min(MAX_SLOTS, int(slots)))
    info = {
        "drive": root,
        "slots": slots,
        "neededBytes": slots * SLOT_BYTES + len(HXCSDFE_CFG),
        "blockers": [],
        "warnings": [],
        "existingSlots": 0,
        "otherFiles": [],
        "ok": False,
        "needsForce": False,
    }

    removable = {d["root"].upper(): d for d in usb.list_removable_drives()}
    dev = removable.get(root)
    if dev is None:
        info["blockers"].append(
            "%s is not a removable USB drive. Preparing only ever touches "
            "removable drives." % root)
        return info

    info["label"] = dev["label"]
    info["freeBytes"] = dev["freeBytes"]
    info["totalBytes"] = dev["totalBytes"]

    fs = dev.get("fileSystem") or ""
    info["fileSystem"] = fs
    if fs.upper() != "FAT32":
        info["blockers"].append(
            "The stick is formatted %s. The Gotek/Nalbantov firmware only "
            "reads FAT32: reformat the drive as FAT32 in Windows Explorer "
            "(right-click the drive, Format) and try again. Windows cannot "
            "put FAT32 on sticks larger than 32GB, so use a 32GB or smaller "
            "stick." % (fs or "an unknown filesystem"))

    try:
        names = os.listdir(root)
    except OSError as e:
        info["blockers"].append("cannot read %s: %s" % (root, e))
        return info

    reclaimable = 0
    for n in names:
        low = n.lower()
        if low in _OS_JUNK:
            continue
        if low in _OURS:
            reclaimable += _size(root, n)
            continue
        if usb.SLOT_RE.match(n):
            info["existingSlots"] += 1
            reclaimable += _size(root, n)
            continue
        info["otherFiles"].append(n)

    if info["existingSlots"]:
        info["warnings"].append(
            "%s already holds %d disk image%s. Preparing overwrites every one "
            "of them, so any songs on this stick are lost."
            % (root, info["existingSlots"],
               "" if info["existingSlots"] == 1 else "s"))
    if info["otherFiles"]:
        info["otherFiles"].sort()
        info["otherFileCount"] = len(info["otherFiles"])
        shown = ", ".join(info["otherFiles"][:6])
        more = len(info["otherFiles"]) - 6
        info["warnings"].append(
            "%s is not empty (%s%s). Those files are left alone, but the "
            "firmware reads fragmented files badly - a freshly formatted "
            "stick is the reliable case."
            % (root, shown, " and %d more" % more if more > 0 else ""))
        # A junk-filled stick has thousands of names; the warning above already
        # says how many, so only a sample needs to cross the wire.
        del info["otherFiles"][20:]

    info["reclaimableBytes"] = reclaimable
    usable = dev["freeBytes"] + reclaimable
    if usable < info["neededBytes"]:
        info["blockers"].append(
            "Not enough room: %d slots need %.1f GB, the stick has %.1f GB "
            "usable. Choose fewer slots or use a bigger stick."
            % (slots, info["neededBytes"] / 1e9, usable / 1e9))

    info["ok"] = not info["blockers"]
    info["needsForce"] = bool(info["warnings"])
    return info


# ------------------------------------------------------------- background run
# A full 1000-slot prepare writes ~2GB, so it runs on a worker thread and the
# UI polls status(). One prepare at a time.

_state = {
    "running": False, "finished": False, "drive": None, "slots": 0,
    "done": 0, "stage": "", "error": None, "cancelled": False,
}
_state_lock = threading.Lock()
_cancel = threading.Event()


def status():
    with _state_lock:
        return dict(_state)


def cancel():
    """Ask a running prepare to stop after the slot it is on."""
    _cancel.set()
    return status()


def start(drive, slots=DEFAULT_SLOTS, force=False):
    """Validate, then kick the prepare off on a worker thread.

    Raises ValueError for anything that makes the target unsafe, so the caller
    gets a real error instead of a background run that fails later."""
    with _state_lock:
        if _state["running"]:
            raise RuntimeError("a USB prepare is already running")

    info = inspect(drive, slots)
    if info["blockers"]:
        raise ValueError(" ".join(info["blockers"]))
    if info["warnings"] and not force:
        raise ValueError(" ".join(info["warnings"])
                         + " Resend with force to continue.")

    root = info["drive"]
    n = info["slots"]
    _cancel.clear()
    with _state_lock:
        _state.update({"running": True, "finished": False, "drive": root,
                       "slots": n, "done": 0, "error": None,
                       "cancelled": False, "stage": "building blank image"})
    threading.Thread(target=_run, args=(root, n, force), daemon=True).start()
    return status()


def _set(**kw):
    with _state_lock:
        _state.update(kw)


def _run(root, slots, force):
    try:
        blank = blank_hfe()

        _set(stage="writing firmware config")
        _write(os.path.join(root, "HXCSDFE.CFG"), HXCSDFE_CFG)
        _write(os.path.join(root, "SWAPMEM.BIN"), b"")

        _set(stage="writing disk slots")
        cancelled = False
        for i in range(slots):
            if _cancel.is_set():
                cancelled = True
                _set(cancelled=True, stage="cancelled")
                break
            _write(os.path.join(root, "DSKA%04d.hfe" % i), blank)
            _set(done=i + 1)
        if not cancelled:
            if force:
                _set(stage="removing leftover slots")
                _drop_extra_slots(root, slots)
            _set(stage="done")
    except OSError as e:
        _set(error="write failed: %s" % e, stage="failed")
    except Exception as e:  # never leave the UI polling a stuck "running"
        _set(error=str(e) or repr(e), stage="failed")
    finally:
        _set(running=False, finished=True)


def _drop_extra_slots(root, slots):
    """Delete DSKAxxxx.hfe above the new slot count. Only reached on a forced
    prepare over an existing stick, where leaving stale slots behind would
    make the Disk tab list songs the user thinks they just erased."""
    for n in os.listdir(root):
        m = usb.SLOT_RE.match(n)
        if m and int(m.group(1)) >= slots:
            try:
                os.remove(os.path.join(root, n))
            except OSError:
                pass


def _write(path, data):
    """Write straight to the final name and force it onto the device.

    Unlike usb.write_flushed there is no .tmp/rename step: a prepare lays
    files down in slot order onto empty space so the firmware's FAT reader
    sees them contiguous, and the rename dance both fragments the result and
    doubles the metadata writes across a thousand files."""
    with open(path, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
