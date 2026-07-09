"""Yamaha E-SEQ (.FIL) writer for floppy-era Disklaviers (e.g. 1995 units).

Format reverse-engineered from real PianoSoft E-SEQ files (Yamaha Disklavier
competition releases) cross-checked against the open-source fil2mid decoder
(github.com/joenardone/disklavier-tools):

  Header (0x77 bytes):
    0x00  FE 00 00                  start marker
    0x03  uint32 LE                 total file size in bytes
    0x07  "COM-ESEQ"                format id
    0x17  0x80                      constant
    0x18  uint16 LE = 16384         target resolution (constant in the wild)
    0x1A  uint16 LE = 20480         timebase (constant in the wild)
    0x1F  uint32 LE                 event-data length (file size - 0x77)
    0x23  01 58 00 00               constant
    0x27  11-byte 8.3 name, no dot  e.g. "PIANO01 FIL"
    0x33  58 04 04 00               constant
    0x37  uint32 LE                 song duration in E-SEQ units
    0x41  uint16                    per-file field with no observed correlation
                                    to size/duration/content (random per file);
                                    written as zero, players don't validate it
    0x44  77 00 00 10 7F 00 00 41 01 00 00 80   constant
    0x57  32-byte title, space padded
    0x77  event stream

  Event stream: [marker|event]... F2
    F3 nn        delta to next event, 1..127 units
    F4 lo hi     delta = (hi<<7)|lo, up to 16383 units
    (no marker)  next event is simultaneous (delta 0)
    events       plain MIDI channel messages (90/80 notes, B0 CC64 pedal...)
    F0 ... F7    sysex passthrough
    F2           end of song

  Timing: 748.8 units/second. Empirically verified: note-event spans of the
  same performances published in both formats match at 748.8007 units/sec
  across every file tested (that's Yamaha's 384 ticks * 117 bpm / 60
  convention).
"""

import struct

from .midi_writer import map_velocity, shape_note_end

UNITS_PER_SEC = 748.8
MAX_F4 = 16383


def _sec_to_units(sec):
    if sec < 0:
        sec = 0
    return int(round(sec * UNITS_PER_SEC))


def _sanitize_83(name):
    """8-char uppercase DOS base name, alphanumeric only.

    The 1995 Disklavier's song-select firmware only handles plain A-Z/0-9
    names (all real PianoSoft and user disks use them). A stray '-' or '_'
    that survives into the 8.3 name -- and thus into the PIANODIR catalog
    entry -- makes the piano refuse the song even though the FAT/E-SEQ are
    valid. Strip everything but letters and digits."""
    clean = "".join(c for c in name.upper() if c.isalnum())
    if not clean:
        clean = "PIANO01"
    return (clean[:8] + "        ")[:8].rstrip().ljust(8)


def _preamble():
    """Time-0 device setup.

    Minimal, matching real PianoSoft E-SEQ files: F1 00 then a program-change
    to acoustic grand, and nothing else. This is exactly how real disks that
    play on the 1995 Disklavier start (verified across 400+ PianoSoft songs).

    An earlier fuller preamble here -- a universal GM-System-On SysEx
    (F0 7E 7F 09 01 F7) plus bank-select/volume/pan CCs -- is what made our
    disks fail to play: only ~4% of real files use any SysEx at all, and the
    old Disklavier rejects the universal GM SysEx and the extra CCs. Note
    dynamics come from per-note velocities, so dropping volume/pan is safe.
    """
    return bytes([0xF1, 0x00, 0xC0, 0x00])


def write_eseq(notes, pedals, out_path, title="",
               vel_min=20, vel_max=112, gamma=1.0,
               offset_ms=0, include_pedal=True, dos_name="PIANO01",
               release_ms=0, cap_sustain=True):
    """Write an E-SEQ .FIL. Same event semantics as midi_writer.write_midi:
    times in seconds on the original timeline, offset_ms shifts everything,
    release_ms trims each note's tail and cap_sustain clamps to the physical
    sustain ceiling (pedal segments are left untouched).
    Returns number of notes written."""
    shift = offset_ms / 1000.0

    # (units, priority, event_bytes); priority orders simultaneous events:
    # note-offs first, pedal, then note-ons — same rule as the MIDI writer.
    events = []
    note_count = 0
    for n in notes:
        onset = n["onset"] + shift
        offset = n["offset"] + shift
        if offset <= 0:
            continue
        offset = shape_note_end(onset, offset, n["pitch"], release_ms,
                                cap_sustain)
        note_count += 1
        vel = map_velocity(n["velocity"], vel_min, vel_max, gamma)
        on_u = _sec_to_units(onset)
        off_u = _sec_to_units(offset)
        if off_u <= on_u:
            off_u = on_u + 1
        events.append((on_u, 2, bytes([0x90, n["pitch"], vel])))
        events.append((off_u, 0, bytes([0x80, n["pitch"], 0x00])))

    if include_pedal:
        for p in pedals:
            onset = p["onset"] + shift
            offset = p["offset"] + shift
            if offset <= 0:
                continue
            on_u = _sec_to_units(onset)
            off_u = _sec_to_units(offset)
            if off_u <= on_u:
                off_u = on_u + 1
            events.append((on_u, 1, bytes([0xB0, 0x40, 0x7F])))
            events.append((off_u, 1, bytes([0xB0, 0x40, 0x00])))

    events.sort(key=lambda e: (e[0], e[1]))

    stream = bytearray(_preamble())
    cur = 0
    pedal_state = 0
    for units, _prio, ev in events:
        delta = units - cur
        cur = units
        while delta > MAX_F4:
            # Chain long gaps: max delta marker plus a harmless pedal
            # re-send as the carrier event.
            stream += bytes([0xF4, 0x7F, 0x7F])
            stream += bytes([0xB0, 0x40, pedal_state])
            delta -= MAX_F4
        if delta > 127:
            stream += bytes([0xF4, delta & 0x7F, (delta >> 7) & 0x7F])
        elif delta > 0:
            stream += bytes([0xF3, delta])
        if ev[0] == 0xB0 and ev[1] == 0x40:
            pedal_state = ev[2]
        stream += ev
    stream += bytes([0xF2])

    duration_units = cur

    header = bytearray(0x77)
    header[0x00:0x03] = b"\xFE\x00\x00"
    total_size = 0x77 + len(stream)
    header[0x03:0x07] = struct.pack("<I", total_size)
    header[0x07:0x0F] = b"COM-ESEQ"
    header[0x17] = 0x80
    header[0x18:0x1A] = struct.pack("<H", 16384)
    header[0x1A:0x1C] = struct.pack("<H", 20480)
    header[0x1F:0x23] = struct.pack("<I", len(stream))
    header[0x23:0x27] = b"\x01\x58\x00\x00"
    header[0x27:0x32] = (_sanitize_83(dos_name) + "FIL").encode("ascii")
    header[0x33:0x37] = b"\x58\x04\x04\x00"
    header[0x37:0x3B] = struct.pack("<I", duration_units)
    header[0x44:0x50] = bytes([0x77, 0x00, 0x00, 0x10, 0x7F,
                               0x00, 0x00, 0x41, 0x01, 0x00, 0x00, 0x80])
    title_ascii = "".join(c if 32 <= ord(c) < 127 else " " for c in title)
    header[0x57:0x77] = title_ascii[:32].ljust(32).encode("ascii")

    with open(out_path, "wb") as f:
        f.write(bytes(header) + bytes(stream))
    return note_count
