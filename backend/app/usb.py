"""Gotek/Nalbantov USB stick management.

Finds the emulator stick (a drive whose root is full of DSKAxxxx.hfe slot
images), determines which slots are actually blank, and saves new disk
images into the first free slot.

"Blank" is decided by decoding the slot's FAT12 root directory out of the
MFM bitstream (track 0 only — fast) and checking it holds no files. That
makes the check immune to how the blank was created; a slot holding any
song can never be overwritten.
"""

import os
import re
import struct

SLOT_RE = re.compile(r"^DSKA(\d{4})\.hfe$", re.IGNORECASE)


def _crc16(data, crc=0xFFFF):
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 \
                else (crc << 1) & 0xFFFF
    return crc


def _track0_sides(path):
    """Return (side0_bytes, side1_bytes) MFM bitstream of track 0."""
    with open(path, "rb") as f:
        data = f.read(1024)
        if data[:8] != b"HXCPICFE":
            return None, None
        tl_off = (data[18] | (data[19] << 8)) * 512
        f.seek(tl_off)
        entry = f.read(4)
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
            if first != 0xE5:
                return False  # a live directory entry -> not blank
        return True
    except OSError:
        return False


def find_usb_drive():
    """Locate the emulator stick: a drive root holding many DSKAxxxx.hfe.
    PIANOLIFT_USB_DIR overrides detection (testing / unusual setups)."""
    override = os.environ.get("PIANOLIFT_USB_DIR")
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
        if len(slots) >= 20:
            return root
    return None


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
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(hfe_bytes)
    os.replace(tmp, path)
    return root, slot
