"""Gotek/Nalbantov USB stick management.

Finds the emulator stick (a drive whose root is full of DSKAxxxx.hfe slot
images), determines which slots are actually blank, and saves new disk
images into the first free slot.

"Blank" is decided by decoding the slot's FAT12 root directory out of the
MFM bitstream (track 0 only — fast) and checking it holds no files. That
makes the check immune to how the blank was created; a slot holding any
song can never be overwritten.
"""

import ctypes
import hashlib
import os
import re
import struct

SLOT_RE = re.compile(r"^DSKA(\d{4})\.hfe$", re.IGNORECASE)

# A drive root with at least this many DSKAxxxx.hfe files is treated as the
# Gotek/Nalbantov emulator stick. Factory sticks ship with hundreds, but a
# user-prepared stick may carry far fewer.
GOTEK_MIN_SLOTS = 10


def _crc16(data, crc=0xFFFF):
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 \
                else (crc << 1) & 0xFFFF
    return crc


def _track_sides(path, track):
    """Return (side0_bytes, side1_bytes) MFM bitstream of a given track."""
    with open(path, "rb") as f:
        data = f.read(1024)
        if data[:8] != b"HXCPICFE":
            return None, None
        tl_off = (data[18] | (data[19] << 8)) * 512
        f.seek(tl_off + track * 4)
        entry = f.read(4)
        if len(entry) < 4:
            return None, None
        off_blocks = entry[0] | (entry[1] << 8)
        tlen = entry[2] | (entry[3] << 8)
        f.seek(off_blocks * 512)
        raw = f.read(tlen)
    side0 = bytearray()
    side1 = bytearray()
    for blk in range(0, len(raw), 512):
        side0 += raw[blk:blk + 256]
        side1 += raw[blk + 256:blk + 512]
    return bytes(side0), bytes(side1)


def _track0_sides(path):
    """Return (side0_bytes, side1_bytes) MFM bitstream of track 0."""
    return _track_sides(path, 0)


def _decode_side(buf):
    """MFM-decode one track side -> {sector_number: 512 bytes}."""
    bits = bytearray()
    for byte in buf:
        for i in range(8):
            bits.append((byte >> i) & 1)
    n = len(bits)
    positions = []
    window = 0
    for i in range(n):
        window = ((window << 1) | bits[i]) & 0xFFFF
        if window == 0x4489:
            positions.append(i + 1)

    def read_bytes(bitpos, count):
        out = bytearray()
        p = bitpos
        for _ in range(count):
            val = 0
            for _ in range(8):
                p += 1
                if p >= n:
                    return None
                val = (val << 1) | bits[p]
                p += 1
            out.append(val)
        return bytes(out)

    sectors = {}
    k = 0
    while k < len(positions):
        if (k + 2 < len(positions)
                and positions[k + 1] - positions[k] == 16
                and positions[k + 2] - positions[k + 1] == 16):
            p = positions[k + 2]
            hdr = read_bytes(p, 7)
            if hdr and hdr[0] == 0xFE and _crc16(b"\xA1\xA1\xA1" + hdr) == 0:
                rec, nsz = hdr[3], hdr[4]
                for m in range(k + 3, min(k + 12, len(positions) - 2)):
                    if (positions[m + 1] - positions[m] == 16
                            and positions[m + 2] - positions[m + 1] == 16):
                        pd = positions[m + 2]
                        size = 128 << nsz
                        blob = read_bytes(pd, 1 + size + 2)
                        if (blob and blob[0] in (0xFB, 0xF8)
                                and _crc16(b"\xA1\xA1\xA1" + blob) == 0):
                            sectors[rec] = blob[1:1 + size]
                        break
            k += 3
        else:
            k += 1
    return sectors


def is_blank_slot(path):
    """True if the slot image is a formatted disk with an empty root dir.
    Unreadable/undecodable files return False (never treated as free)."""
    try:
        side0, side1 = _track0_sides(path)
        if side0 is None:
            return False
        s0 = _decode_side(side0)
        s1 = _decode_side(side1)
        # 720K layout: LBA = (track*2 + side)*9 + (sec-1).
        # Root dir = LBA 7..13 -> side0 sectors 8,9 + side1 sectors 1..5.
        root = b""
        for sec in (8, 9):
            if sec not in s0:
                return False
            root += s0[sec]
        for sec in (1, 2, 3, 4, 5):
            if sec not in s1:
                return False
            root += s1[sec]
        for i in range(0, len(root), 32):
            first = root[i]
            if first == 0x00:
                break
            if first == 0xE5:
                continue  # deleted entry
            attr = root[i + 11]
            if attr == 0x0F or attr & 0x08:
                continue  # LFN / volume label, not a file
            if root[i:i + 11].upper() == b"PIANODIRFIL":
                # Disklavier-formatted blanks carry an empty PIANODIR.FIL
                # catalog; songs always appear as their own .FIL entries,
                # so a catalog-only disk holds no music.
                continue
            return False  # a real file -> not blank
        return True
    except OSError:
        return False


def _read_lbas(path):
    """Decode tracks 0 and 1 into an {LBA: 512 bytes} map. That covers the
    whole FAT12 metadata region (boot/FATs/root at LBA 0..13) and the start of
    the data area (LBA 14+), which is where PIANODIR.FIL — always the first,
    contiguous file — lives. Enough to enumerate a slot's songs without
    decoding all 80 tracks. LBA = track*18 + side*9 + (sector-1)."""
    out = {}
    for track in (0, 1):
        s0, s1 = _track_sides(path, track)
        if s0 is None:
            return None
        d0 = _decode_side(s0)
        d1 = _decode_side(s1)
        base = track * 18
        for sec, blk in d0.items():
            out[base + (sec - 1)] = blk
        for sec, blk in d1.items():
            out[base + 9 + (sec - 1)] = blk
    return out


def _fat12_next(fat, cluster):
    off = (cluster * 3) // 2
    if off + 1 >= len(fat):
        return 0xFFF
    if cluster % 2:
        return (fat[off] >> 4) | (fat[off + 1] << 4)
    return fat[off] | ((fat[off + 1] & 0x0F) << 8)


def _parse_pianodir(buf):
    """PIANODIR.FIL -> [{name, title}] in play order. 16-byte header then
    80-byte entries: 11-byte 8.3 name, and the song's 32-char title at 0x57."""
    songs = []
    i = 16
    while i + 80 <= len(buf):
        e = buf[i:i + 80]
        name = e[0:11]
        if name[0] in (0x00, 0xE5) or name.strip(b"\x00 ") == b"":
            break
        dos = name.decode("latin1").rstrip()
        title = e[48:80].decode("latin1").rstrip(" \x00").strip()
        songs.append({"name": dos, "title": title or dos})
        i += 80
    return songs


def read_slot_catalog(path):
    """List the songs on one slot image as [{name, title}] in play order.
    Reads the PIANODIR.FIL catalog (nice titles); if a disk has none, falls
    back to the raw .FIL directory names. Returns None if undecodable, []
    for a formatted-but-empty disk."""
    try:
        lbas = _read_lbas(path)
    except OSError:
        return None
    if lbas is None:
        return None
    fat = b"".join(lbas.get(l, b"\x00" * 512) for l in (1, 2, 3))
    root = b"".join(lbas.get(l, b"\x00" * 512) for l in range(7, 14))

    fil_names = []
    pianodir = None
    for i in range(0, len(root), 32):
        first = root[i]
        if first == 0x00:
            break
        if first == 0xE5:
            continue
        attr = root[i + 11]
        if attr == 0x0F or attr & 0x08:
            continue  # LFN / volume label
        name = root[i:i + 11]
        start = root[i + 26] | (root[i + 27] << 8)
        size = int.from_bytes(root[i + 28:i + 32], "little")
        if name.upper() == b"PIANODIRFIL":
            pianodir = (start, size)
        else:
            fil_names.append(name.decode("latin1").rstrip())

    songs = []
    if pianodir and pianodir[1]:
        data = bytearray()
        cluster = pianodir[0]
        guard = 0
        while 2 <= cluster < 0xFF0 and len(data) < pianodir[1] and guard < 16:
            lba = 14 + (cluster - 2) * 2  # data area, 2 sectors/cluster
            data += lbas.get(lba, b"\x00" * 512)
            data += lbas.get(lba + 1, b"\x00" * 512)
            cluster = _fat12_next(fat, cluster)
            guard += 1
        songs = _parse_pianodir(bytes(data[:pianodir[1]]))

    if not songs:
        songs = [{"name": n, "title": n} for n in fil_names]
    return songs


# Bytes hashed per slot in fast mode. The FAT metadata (boot/FATs/root) and
# PIANODIR.FIL live inside the first two tracks, well under this, so a blank
# disk's signature differs from any disk carrying songs.
_FAST_SIG_BYTES = 200 * 1024


def _slot_signature(path):
    try:
        with open(path, "rb") as f:
            return hashlib.md5(f.read(_FAST_SIG_BYTES)).digest()
    except OSError:
        return None


def _blank_signature(root, nums):
    """In fast mode, most slots on a factory/user stick are identical blank
    images. Find that majority signature and confirm one representative really
    is blank (guards a stick that's mostly copies of one song). Returns the
    signature to treat as blank, or None to fall back to full decoding."""
    from collections import Counter
    sigs = {}
    for s in nums:
        sig = _slot_signature(os.path.join(root, "DSKA%04d.hfe" % s))
        if sig is not None:
            sigs[s] = sig
    if not sigs:
        return {}, None
    sig, count = Counter(sigs.values()).most_common(1)[0]
    if count < 2:
        return sigs, None  # no clear majority -> decode everything
    rep = next(s for s, v in sigs.items() if v == sig)
    if not is_blank_slot(os.path.join(root, "DSKA%04d.hfe" % rep)):
        return sigs, None  # majority isn't actually blank -> decode everything
    return sigs, sig


def scan_catalog(root, fast=True):
    """Every DSKAxxxx.hfe slot on the stick, in slot order, with the songs on
    each. Blank slots are included (songs: []) so a printed catalog shows the
    gaps too.

    fast=True (default): fingerprint every slot cheaply and skip the ~100ms
    MFM decode for the ones matching the confirmed-blank template — only slots
    that carry data get decoded. fast=False decodes every slot."""
    nums = sorted(int(m.group(1)) for m in
                  (SLOT_RE.match(n) for n in os.listdir(root)) if m)
    sigs, blank_sig = ({}, None)
    if fast:
        sigs, blank_sig = _blank_signature(root, nums)
    slots = []
    for s in nums:
        path = os.path.join(root, "DSKA%04d.hfe" % s)
        entry = {"slot": s, "filename": "DSKA%04d.hfe" % s}
        try:
            if blank_sig is not None and sigs.get(s) == blank_sig:
                entry["blank"] = True
                entry["songs"] = []
            elif is_blank_slot(path):
                entry["blank"] = True
                entry["songs"] = []
            else:
                songs = read_slot_catalog(path)
                if songs is None:
                    entry["blank"] = False
                    entry["songs"] = []
                    entry["error"] = "unreadable"
                else:
                    entry["blank"] = len(songs) == 0
                    entry["songs"] = songs
        except OSError:
            entry["blank"] = False
            entry["songs"] = []
            entry["error"] = "read error"
        slots.append(entry)
    return slots


def find_usb_drive():
    """Locate the emulator stick: a drive root holding many DSKAxxxx.hfe.
    PIANOFORGE_USB_DIR overrides detection (testing / unusual setups)."""
    override = os.environ.get("PIANOFORGE_USB_DIR")
    if override:
        if os.path.isdir(override):
            return override
        return None
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        root = letter + ":\\"
        try:
            names = os.listdir(root)
        except OSError:
            continue
        slots = [n for n in names if SLOT_RE.match(n)]
        if len(slots) >= GOTEK_MIN_SLOTS:
            return root
    return None


def _slot_count(root):
    try:
        return sum(1 for n in os.listdir(root) if SLOT_RE.match(n))
    except OSError:
        return 0


def list_removable_drives():
    """All removable drives (USB sticks) currently mounted, with volume
    label, free space and whether the drive looks like the Gotek stick.
    Windows-only; returns [] elsewhere."""
    if os.name != "nt":
        return []
    k32 = ctypes.windll.kernel32
    DRIVE_REMOVABLE = 2
    drives = []
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        root = letter + ":\\"
        if k32.GetDriveTypeW(root) != DRIVE_REMOVABLE:
            continue
        label_buf = ctypes.create_unicode_buffer(261)
        fs_buf = ctypes.create_unicode_buffer(261)
        ok = k32.GetVolumeInformationW(
            ctypes.c_wchar_p(root), label_buf, 261,
            None, None, None, fs_buf, 261)
        if not ok:
            continue  # no media in the slot (card readers etc.)
        free = ctypes.c_ulonglong(0)
        total = ctypes.c_ulonglong(0)
        k32.GetDiskFreeSpaceExW(
            ctypes.c_wchar_p(root),
            ctypes.byref(free), ctypes.byref(total), None)
        drives.append({
            "root": root,
            "label": label_buf.value or "USB drive",
            "freeBytes": free.value,
            "isGotek": _slot_count(root) >= GOTEK_MIN_SLOTS,
        })
    return drives


def used_and_free(root, scan_from=0, stop_after_free=1):
    """Scan slots in order; return (used_names, first_free_slots).
    Stops after finding `stop_after_free` free slots (blank check is
    ~100ms per slot, so exhaustive scans are avoidable)."""
    names = {}
    for n in os.listdir(root):
        m = SLOT_RE.match(n)
        if m:
            names[int(m.group(1))] = n
    free = []
    used = []
    for slot in range(scan_from, 1000):
        if slot not in names:
            free.append(slot)
        elif is_blank_slot(os.path.join(root, names[slot])):
            free.append(slot)
        else:
            used.append(slot)
        if len(free) >= stop_after_free:
            break
    return used, free


def save_to_next_free(hfe_bytes, scan_from=14):
    """Write hfe_bytes into the first blank slot. Returns (drive, slot)."""
    root = find_usb_drive()
    if root is None:
        raise FileNotFoundError(
            "No Gotek/Nalbantov USB stick found (no drive with DSKAxxxx.hfe "
            "slot files). Plug in the stick and try again.")
    _used, free = used_and_free(root, scan_from=scan_from, stop_after_free=1)
    if not free:
        raise RuntimeError("No blank slots left on the stick.")
    slot = free[0]
    path = os.path.join(root, "DSKA%04d.hfe" % slot)
    write_flushed(path, hfe_bytes)
    return root, slot


def save_to_slot(hfe_bytes, slot):
    """Write hfe_bytes into a specific slot, OVERWRITING whatever is there.
    Used when the user deliberately targets an occupied slot. Returns
    (drive, slot)."""
    if not isinstance(slot, int) or slot < 0 or slot > 999:
        raise ValueError("slot must be an integer 0-999")
    root = find_usb_drive()
    if root is None:
        raise FileNotFoundError(
            "No Gotek/Nalbantov USB stick found (no drive with DSKAxxxx.hfe "
            "slot files). Plug in the stick and try again.")
    path = os.path.join(root, "DSKA%04d.hfe" % slot)
    write_flushed(path, hfe_bytes)
    return root, slot


def write_flushed(path, data):
    """Write bytes to path and force them onto the physical device before
    returning. Without the fsync the data lingers in Windows' write-back
    cache; if the user pulls the USB stick before the OS flushes, the file
    is left half-written on the medium (fine when re-read on the PC from
    cache, but corrupt/unreadable on the piano). Atomic via a .tmp rename."""
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
