"""MusicXML read/write/timeline helpers shared by the pedal and dynamics
engines (see pedal_engine.py, dynamics_engine.py).

MusicXML has no concept of absolute time — position is implied by walking
each part's children in document order and tracking a "divisions" cursor
that <backup>/<forward> elements move around within a measure (this is how
multiple voices/staves share one part's timeline). Everything here is built
around that walk: `part_timeline` extracts note/chord events with absolute
onset times in quarter-note beats, and `insert_directions` re-walks the same
measures to splice new <direction> elements (pedal marks, dynamics, wedges)
at the correct position in the sibling order — a direction has no duration,
so its effective time is just "where it sits among the notes/backups".
"""

import io
import xml.etree.ElementTree as ET
import zipfile

STEP_TO_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def load_musicxml(path):
    """Read a .musicxml/.xml (plain) or .mxl (zip-compressed) file, return
    the parsed ElementTree root (<score-partwise> or <score-timewise>)."""
    with open(path, "rb") as f:
        data = f.read()
    return load_musicxml_bytes(data)


def load_musicxml_bytes(data):
    """Same as load_musicxml, but from an in-memory bytes blob (e.g. an
    upload that hasn't been written to disk with the right extension yet)."""
    if data[:2] == b"PK":  # zip signature -> compressed .mxl
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            root_name = _mxl_rootfile(z)
            data = z.read(root_name)
    return ET.fromstring(data)


def _mxl_rootfile(z):
    """Find the main score entry inside an .mxl container via
    META-INF/container.xml; fall back to the first non-META-INF *.xml."""
    try:
        container = z.read("META-INF/container.xml")
        croot = ET.fromstring(container)
        rootfile = croot.find(".//rootfile")
        if rootfile is not None and rootfile.get("full-path"):
            return rootfile.get("full-path")
    except KeyError:
        pass
    for name in z.namelist():
        if name.lower().endswith((".xml", ".musicxml")) and not name.startswith("META-INF/"):
            return name
    raise ValueError("no MusicXML entry found inside .mxl archive")


def save_musicxml(root, path):
    """Serialize back to a plain (uncompressed) .musicxml file."""
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    buf = io.BytesIO()
    tree.write(buf, encoding="UTF-8", xml_declaration=True)
    with open(path, "wb") as f:
        f.write(buf.getvalue())


def pitch_info(note_el):
    """(midi_number, pitch_class 0-11) for a <note>'s <pitch>, or None for
    an unpitched/rest note."""
    pitch = note_el.find("pitch")
    if pitch is None:
        return None
    step = pitch.findtext("step")
    octave = int(pitch.findtext("octave"))
    alter = int(float(pitch.findtext("alter") or 0))
    pc = (STEP_TO_PC[step] + alter) % 12
    midi = (octave + 1) * 12 + STEP_TO_PC[step] + alter
    return midi, pc


def pick_part(root):
    """Which <part> carries the pedal/dynamics marks. A single-part score
    (typical MuseScore/Finale piano export with a 2-staff grand staff) is
    the obvious choice; for a multi-part score, prefer the part declaring
    2+ staves (piano grand staff), else fall back to the last part, which
    conventionally carries the bass/pedal line in split LH/RH exports."""
    parts = root.findall("part")
    if not parts:
        raise ValueError("no <part> elements in score")
    if len(parts) == 1:
        return parts[0]
    for p in parts:
        staves = p.findtext(".//attributes/staves")
        if staves and int(staves) >= 2:
            return p
    return parts[-1]


def part_timeline(part_el):
    """Walk one <part>, returns (note_events, measure_bounds).

    note_events: list of dicts sorted by onset —
      {onset, duration, midi, pc, measure_index, voice, staff}
      (onset/duration in quarter-note beats, rests excluded).
    measure_bounds: list of (measure_index, start_beat, end_beat, divisions,
      measure_el) — end_beat is the longest voice's local cursor, used to
      advance the next measure's start and to locate insertion points.
    """
    events = []
    bounds = []
    divisions = 1
    global_start = 0.0
    measures = part_el.findall("measure")
    for m_idx, measure in enumerate(measures):
        local = 0  # divisions units, resets each measure
        # A <chord/> note shares its carrier's onset, not wherever the
        # cursor has moved to by the time the chord note is reached (the
        # carrier already advanced `local` past it) — track that shared
        # onset separately from the advancing cursor.
        carrier_onset = 0
        measure_len = 0
        for child in measure:
            tag = child.tag
            if tag == "attributes":
                d = child.findtext("divisions")
                if d:
                    divisions = int(d)
            elif tag == "note":
                dur = int(child.findtext("duration") or 0)
                is_chord = child.find("chord") is not None
                is_grace = child.find("grace") is not None
                onset_local = carrier_onset if is_chord else local
                info = pitch_info(child)
                if info is not None and not is_grace:
                    midi, pc = info
                    voice = child.findtext("voice") or "1"
                    staff = child.findtext("staff") or "1"
                    events.append({
                        "onset": global_start + onset_local / divisions,
                        "duration": dur / divisions if divisions else 0.0,
                        "midi": midi, "pc": pc,
                        "measure_index": m_idx, "voice": voice, "staff": staff,
                    })
                if not is_chord and not is_grace:
                    carrier_onset = local
                    local += dur
            elif tag == "backup":
                local -= int(child.findtext("duration") or 0)
            elif tag == "forward":
                local += int(child.findtext("duration") or 0)
            measure_len = max(measure_len, local)
        bounds.append((m_idx, global_start, global_start + measure_len / divisions,
                       divisions, measure))
        global_start += measure_len / divisions
    events.sort(key=lambda e: e["onset"])
    return events, bounds


def insert_directions(part_el, bounds, scheduled):
    """Splice <direction> elements into `part_el`'s measures at the given
    beat positions. `scheduled` is a list of (onset_beat, build_fn) where
    build_fn() returns a fresh <direction> Element. Mutates the tree.

    Directions land right before the first note/backup/forward whose local
    cursor position reaches the target beat, so they fire at the same
    instant the next note group attacks (matches how engraving software
    places pedal/dynamic marks relative to the notes they annotate).
    """
    scheduled = sorted(scheduled, key=lambda s: s[0])
    si = 0
    n = len(scheduled)
    for m_idx, start_beat, end_beat, divisions, measure in bounds:
        if si >= n:
            break
        # Directions belonging to this measure (by onset range); the last
        # measure also absorbs anything scheduled exactly at its end.
        is_last = (m_idx == bounds[-1][0])
        due = []
        while si < n and (scheduled[si][0] < end_beat or
                          (is_last and scheduled[si][0] <= end_beat)):
            due.append(scheduled[si])
            si += 1
        if not due:
            continue
        _insert_into_measure(measure, start_beat, divisions, due)


_POSITIONAL_TAGS = {"note", "backup", "forward"}


def _insert_into_measure(measure, measure_start_beat, divisions, due):
    """due: [(onset_beat, build_fn), ...] sorted, all within this measure."""
    local = 0
    di = 0
    children = list(measure)
    insert_before = {}  # id(child) -> [build_fn, ...] to place before it
    for child in children:
        # Only check for a due insertion in front of note/backup/forward —
        # non-positional siblings (attributes, print, barline, ...) don't
        # represent a moment in time, and a direction scheduled for beat 0
        # must land after <attributes> (clef/key/time), not before it.
        if child.tag in _POSITIONAL_TAGS:
            cur_beat = measure_start_beat + local / divisions
            while di < len(due) and due[di][0] <= cur_beat + 1e-6:
                insert_before.setdefault(id(child), []).append(due[di][1])
                di += 1
        tag = child.tag
        if tag == "note":
            is_chord = child.find("chord") is not None
            is_grace = child.find("grace") is not None
            dur = int(child.findtext("duration") or 0)
            if not is_chord and not is_grace:
                local += dur
        elif tag == "backup":
            local -= int(child.findtext("duration") or 0)
        elif tag == "forward":
            local += int(child.findtext("duration") or 0)
    # Anything still due (onset at/after the measure's last event) goes at
    # the end of the measure.
    trailing = [fn for (_, fn) in due[di:]]

    for child in children:
        marker = insert_before.get(id(child))
        if marker:
            idx = list(measure).index(child)
            for offset, fn in enumerate(marker):
                measure.insert(idx + offset, fn())
    for fn in trailing:
        measure.append(fn())
