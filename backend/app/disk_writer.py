"""Build a ready-to-play Disklavier floppy as an HxC .HFE image.

Produces what a 1995 floppy Disklavier expects to find on a 720KB DD disk
served by a Gotek/Nalbantov USB floppy emulator:

  FAT12 filesystem (geometry cloned from a working PianoSoft disk)
    PIANODIR.FIL   6KB song index
    <name>.FIL     the E-SEQ song

PIANODIR.FIL format (reverse-engineered from a working PianoSoft floppy):
  0x00  FE 00 00 | 00 14 00 00 | "PIANODIR" 00
  0x10  80-byte entries:
          11-byte 8.3 filename, no dot ("01-XMASAFIL"), NUL
          bytes 0x33..0x56 of the song's .FIL header verbatim
          (constants + duration + per-file field)
          bytes 0x57..0x76 of the song's .FIL header (32-char title)
  zero-padded to 6144 bytes.

HFE/MFM: header fields cloned from the user's working Nalbantov images
(80 cyl, 2 sides, ISOIBM MFM, 250 kbit). Standard IBM track layout,
9 x 512-byte sectors, CRC16-CCITT. Verified by round-tripping through the
same decoder that reads real Yamaha disks bit-perfectly.
"""

import base64
import struct

# Boot sector from a PianoSoft floppy verified playing on the user's 1995
# Disklavier (MSWIN4.1-formatted: the piano only reads the FAT, not boot code).
BOOT_SECTOR = base64.b64decode(
    "6zyQTVNXSU40LjEAAgIBAAJwAKAF+QMACQACAAAAAAAAAAAAAAApU1xZxCAgICAgICAgICAgRkFU"
    "MTIgICAzyY7RvPx7Fge9eADFdgAeVhZVvyIFiX4AiU4CsQv886QGH70AfMZF/g84TiR9IIvBmeh+"
    "AYPrOmahHHxmOweKV/x1BoDKAohWAoDDEHPtM8n+Bth9ikYQmPdmFgNGHBNWHgNGDhPRi3YRYIlG"
    "/IlW/rggAPfmi14LA8NI9/MBRvwRTv5hvwAH6CgBcj44LXQXYLELvth986ZhdD1OdAmDxyA7+3Ln"
    "693+Dth9e6e+f32smAPwrJhAdAxIdBO0DrsHAM0Q6+++gn3r5r6AfevhzRZeH2aPBM0ZvoF9i30a"
    "jUX+ik4N9+EDRvwTVv6xBOjCAHLX6gACcABSUAZTagFqEJGLRhiiJgWWkjPS9/aR9/ZCh8r3dhqK"
    "8orowMwCCsy4AQKAfgIOdQS0Qov0ilYkzRNhYXIKQHUBQgNeC0l1d8MDGAEnDQpJbnZhbGlkIHN5"
    "c3RlbSBkaXNr/w0KRGlzayBJL08gZXJyb3L/DQpSZXBsYWNlIHRoZSBkaXNrLCBhbmQgdGhlbiBw"
    "cmVzcyBhbnkga2V5DQoAAElPICAgICAgU1lTTVNET1MgICBTWVN/AQBBuwAHYGZqAOk7/wAAVao="
)

BPS = 512
SPC = 2                 # sectors per cluster
FAT_SECTORS = 3
N_FATS = 2
ROOT_ENTRIES = 112
TOTAL_SECTORS = 1440    # 720KB
SPT = 9
TRACKS = 80
SIDES = 2


# ---------------------------------------------------------------- PIANODIR

def build_pianodir(entries):
    """entries: [(dos11_name, fil_header_0x77_bytes)] in play order."""
    out = bytearray()
    out += b"\xFE\x00\x00" + struct.pack("<I", 0x1400)[:4]
    out = out[:7] + b"PIANODIR\x00"
    body = bytearray(out)
    for dos11, hdr in entries:
        e = bytearray(80)
        e[0:11] = dos11.encode("ascii")
        e[11] = 0
        e[12:48] = hdr[0x33:0x57]
        e[48:80] = hdr[0x57:0x77]
        body += e
    body += b"\x00" * (6144 - len(body))
    return bytes(body[:6144])


# ---------------------------------------------------------------- FAT12

# Usable data clusters on a 720K FAT12 disk once the reserved sector, both
# FATs and the fixed-size root directory are subtracted. A cluster is
# SPC * BPS = 1024 bytes, so this is the real per-disk song-payload ceiling.
DATA_CLUSTERS = (TOTAL_SECTORS - 1 - N_FATS * FAT_SECTORS
                 - (ROOT_ENTRIES * 32) // BPS) // SPC


def build_fat12(files):
    """files: [(dos11_name, data_bytes)]. Returns 737280-byte image."""
    if len(files) > ROOT_ENTRIES:
        raise ValueError(
            "too many files for one disk (%d, max %d root entries)"
            % (len(files), ROOT_ENTRIES))
    need = sum(max(1, (len(d) + SPC * BPS - 1) // (SPC * BPS))
               for _n, d in files)
    if need > DATA_CLUSTERS:
        raise ValueError(
            "files exceed 720K disk capacity (%d of %d clusters used)"
            % (need, DATA_CLUSTERS))
    img = bytearray(TOTAL_SECTORS * BPS)
    img[0:512] = BOOT_SECTOR

    fat = bytearray(FAT_SECTORS * BPS)
    fat[0:3] = b"\xF9\xFF\xFF"

    def set_fat(n, val):
        off = (n * 3) // 2
        if n % 2:
            fat[off] = (fat[off] & 0x0F) | ((val << 4) & 0xF0)
            fat[off + 1] = (val >> 4) & 0xFF
        else:
            fat[off] = val & 0xFF
            fat[off + 1] = (fat[off + 1] & 0xF0) | ((val >> 8) & 0x0F)

    root_off = (1 + N_FATS * FAT_SECTORS) * BPS
    data_off = root_off + ROOT_ENTRIES * 32
    next_cluster = 2

    for idx, (dos11, data) in enumerate(files):
        n_clusters = max(1, (len(data) + SPC * BPS - 1) // (SPC * BPS))
        start = next_cluster
        for c in range(start, start + n_clusters):
            set_fat(c, c + 1 if c < start + n_clusters - 1 else 0xFFF)
        pos = data_off + (start - 2) * SPC * BPS
        img[pos:pos + len(data)] = data
        next_cluster = start + n_clusters

        e = bytearray(32)
        e[0:8] = dos11[:8].encode("ascii")
        e[8:11] = dos11[8:11].encode("ascii")
        e[11] = 0x20  # archive
        e[22:24] = struct.pack("<H", 0x6000)   # 12:00
        e[24:26] = struct.pack("<H", 0x30A1)   # 1 May 2004 (arbitrary)
        e[26:28] = struct.pack("<H", start)
        e[28:32] = struct.pack("<I", len(data))
        img[root_off + idx * 32: root_off + (idx + 1) * 32] = e

    fat_bytes = bytes(fat)
    img[BPS:BPS + len(fat_bytes)] = fat_bytes
    img[BPS + len(fat_bytes):BPS + 2 * len(fat_bytes)] = fat_bytes
    return bytes(img)


# ---------------------------------------------------------------- MFM / HFE

def _crc16(data, crc=0xFFFF):
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 \
                else (crc << 1) & 0xFFFF
    return crc


class _MfmStream:
    def __init__(self):
        self.bits = []
        self.last_data_bit = 0

    def byte(self, val):
        for i in range(7, -1, -1):
            d = (val >> i) & 1
            c = 1 if (self.last_data_bit == 0 and d == 0) else 0
            self.bits.append(c)
            self.bits.append(d)
            self.last_data_bit = d

    def raw16(self, pattern):
        """Emit a 16-bitcell pattern verbatim (sync marks with missing clock)."""
        for i in range(15, -1, -1):
            self.bits.append((pattern >> i) & 1)
        self.last_data_bit = pattern & 1

    def bytes_(self, seq):
        for b in seq:
            self.byte(b)


def _encode_track(img, cyl, head):
    s = _MfmStream()
    s.bytes_([0x4E] * 80)          # gap 4a
    s.bytes_([0x00] * 12)
    for _ in range(3):
        s.raw16(0x5224)            # C2 sync
    s.byte(0xFC)                   # index mark
    s.bytes_([0x4E] * 50)          # gap 1
    for sec in range(1, SPT + 1):
        s.bytes_([0x00] * 12)
        for _ in range(3):
            s.raw16(0x4489)        # A1 sync
        hdr = bytes([0xFE, cyl, head, sec, 2])
        s.bytes_(hdr)
        s.bytes_(struct.pack(">H", _crc16(b"\xA1\xA1\xA1" + hdr)))
        s.bytes_([0x4E] * 22)      # gap 2
        s.bytes_([0x00] * 12)
        for _ in range(3):
            s.raw16(0x4489)
        lba = (cyl * SIDES + head) * SPT + (sec - 1)
        payload = img[lba * BPS:(lba + 1) * BPS]
        s.byte(0xFB)
        s.bytes_(payload)
        s.bytes_(struct.pack(">H", _crc16(b"\xA1\xA1\xA1\xFB" + payload)))
        s.bytes_([0x4E] * 80)      # gap 3
    # pad to the per-side bitstream size used by real Nalbantov images
    target_bits = 12544 * 8
    while len(s.bits) < target_bits:
        s.byte(0x4E)
    bits = s.bits[:target_bits]
    # pack LSB-first
    out = bytearray(12544)
    for i, bit in enumerate(bits):
        if bit:
            out[i >> 3] |= 1 << (i & 7)
    return bytes(out)


def img_to_hfe(img):
    track_len = 25088          # both sides, bytes
    blocks_per_track = (track_len + 511) // 512  # 49
    header = bytearray(512)
    header[0:8] = b"HXCPICFE"
    header[8] = 0              # revision
    header[9] = TRACKS
    header[10] = SIDES
    header[11] = 0             # ISOIBM_MFM
    header[12:14] = struct.pack("<H", 250)
    header[14:16] = struct.pack("<H", 0)
    header[16] = 0             # IBMPC_DD interface
    header[17] = 1
    header[18:20] = struct.pack("<H", 1)  # track list at block 1
    header[20:] = b"\xFF" * (512 - 20)

    lut = bytearray(512)
    data = bytearray()
    first_block = 2
    for t in range(TRACKS):
        off_block = first_block + t * blocks_per_track
        lut[t * 4:t * 4 + 2] = struct.pack("<H", off_block)
        lut[t * 4 + 2:t * 4 + 4] = struct.pack("<H", track_len)
        side0 = _encode_track(img, t, 0)
        side1 = _encode_track(img, t, 1)
        track = bytearray()
        for i in range(0, 12544, 256):
            track += side0[i:i + 256]
            track += side1[i:i + 256]
        track += b"\x00" * (blocks_per_track * 512 - len(track))
        data += track
    lut[TRACKS * 4:] = b"\xFF" * (512 - TRACKS * 4)
    return bytes(header) + bytes(lut) + bytes(data)


# ---------------------------------------------------------------- top level

# PIANODIR.FIL is a fixed 6144-byte catalog: 16-byte header + 80 bytes per
# song. That caps how many songs the piano's song-select menu can index.
PIANODIR_MAX_SONGS = (6144 - 16) // 80  # 76


def build_disk_hfe_multi(songs):
    """songs: [(fil_bytes, dos_base)] in play order. Each dos_base must be a
    unique 8-char DOS base (the piano rejects duplicate names, and each song's
    own .FIL header at 0x27 must already carry the same name). Returns one
    .hfe image holding every song plus the PIANODIR.FIL catalog."""
    if not songs:
        raise ValueError("no songs to write")
    if len(songs) > PIANODIR_MAX_SONGS:
        raise ValueError(
            "too many songs for one disk (%d, max %d in the PIANODIR catalog)"
            % (len(songs), PIANODIR_MAX_SONGS))
    dir_entries = []
    files = []
    seen = set()
    for fil_bytes, dos_base in songs:
        dos11 = (dos_base.upper()[:8].ljust(8) + "FIL")
        if dos11 in seen:
            raise ValueError("duplicate disk song name: " + dos11)
        seen.add(dos11)
        dir_entries.append((dos11, fil_bytes[:0x77]))
        files.append((dos11, fil_bytes))
    pianodir = build_pianodir(dir_entries)
    img = build_fat12([("PIANODIRFIL", pianodir)] + files)
    return img_to_hfe(img)


def build_disk_hfe(fil_bytes, dos_base):
    """Single-song disk. fil_bytes: complete E-SEQ .FIL; dos_base: 8-char DOS
    name. Returns .hfe image bytes."""
    return build_disk_hfe_multi([(fil_bytes, dos_base)])
