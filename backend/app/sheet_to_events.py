"""MusicXML score -> playable note/pedal events.

Bridges the sheet pipeline (MusicXML from OMR or upload, see
sheet_routes.py) into the audio pipeline's canonical seconds-based shape
(jobs/<id>/events.json): {"notes": [{onset, offset, pitch, velocity}],
"pedals": [{onset, offset}]}. That format is what the piano-roll editor,
the MIDI/E-SEQ/floppy writers, and the library all consume, so a converted
score immediately gets the whole editing/export surface for free.

Velocities are written in *raw model space* (like the transcription
models emit): the export step re-maps them through midi_writer.
map_velocity with the job's velMin/velMax/gamma sliders, so mf here is
chosen to land in a natural Disklavier range under the default curve.

The walk mirrors musicxml_io.part_timeline (divisions cursor,
backup/forward, chord carrier onset) but covers every <part> — OMR
frequently splits an arrangement into vocal + piano parts — and
additionally collects ties, tempo, dynamics/wedge and pedal directions.
"""

from .musicxml_io import pitch_info

# Raw-velocity table for printed/suggested dynamics words. Under the
# default export curve (velMin 20, velMax 112, gamma 1) mf=76 plays at
# ~75 — a comfortable mezzo on the hardware.
DYNAMIC_VELOCITY = {
    "pppp": 30, "ppp": 34, "pp": 40, "p": 52, "mp": 64,
    "mf": 76, "f": 88, "ff": 100, "fff": 106, "ffff": 110,
    "sf": 88, "sfz": 88, "sffz": 92, "fz": 88, "rf": 84, "rfz": 84,
    "fp": 76, "sfp": 76,
}
DEFAULT_VELOCITY = DYNAMIC_VELOCITY["mf"]
WEDGE_FALLBACK_STEP = 12   # ramp target when no dynamic follows the wedge
PITCH_MIN, PITCH_MAX = 21, 108   # 88-key range, matches main._clean_events
MIN_DUR_SEC = 0.05
TIE_TOL = 1e-3                   # beats: tie continuation onset tolerance


def convert(root, default_bpm=100):
    """root: parsed <score-partwise>. Returns (notes, pedals, warnings)
    with notes/pedals in the events.json shape (times in seconds)."""
    warnings = []
    beat_notes = []    # {onset, duration, pitch} in quarter-note beats
    tempi = []         # (beat, bpm)
    dynamics = []      # (beat, raw velocity)
    wedge_marks = []   # (beat, "crescendo"|"diminuendo"|"stop")
    pedal_marks = []   # (beat, "start"|"stop")
    saw_repeat = False

    for part in root.findall("part"):
        notes, directives, has_repeat = _walk_part(part)
        beat_notes.extend(notes)
        saw_repeat = saw_repeat or has_repeat
        for beat, kind, value in directives:
            if kind == "tempo":
                tempi.append((beat, value))
            elif kind == "dynamic":
                dynamics.append((beat, value))
            elif kind == "wedge":
                wedge_marks.append((beat, value))
            elif kind == "pedal":
                pedal_marks.append((beat, value))

    if not beat_notes:
        return [], [], warnings

    if saw_repeat:
        warnings.append("Repeats aren't expanded — the song plays straight "
                        "through.")

    tempi.sort()
    if not tempi:
        warnings.append("No tempo mark found — assuming %d BPM (adjust with "
                        "Speed in the editor)." % default_bpm)
        tempi = [(0.0, float(default_bpm))]
    to_seconds = _tempo_mapper(tempi)

    dynamics.sort()
    ramps = _build_ramps(sorted(wedge_marks), dynamics)

    last_end = max(n["onset"] + n["duration"] for n in beat_notes)

    notes = []
    for n in beat_notes:
        pitch = min(PITCH_MAX, max(PITCH_MIN, n["pitch"]))
        onset = to_seconds(n["onset"])
        offset = to_seconds(n["onset"] + n["duration"])
        if offset - onset < MIN_DUR_SEC:
            offset = onset + MIN_DUR_SEC
        vel = _velocity_at(n["onset"], dynamics, ramps)
        notes.append({
            "onset": round(onset, 4), "offset": round(offset, 4),
            "pitch": pitch, "velocity": min(127, max(1, int(round(vel)))),
        })
    notes.sort(key=lambda n: (n["onset"], n["pitch"]))

    pedals = []
    # Re-pedal points arrive as a stop+start pair at the same beat; the stop
    # must be processed first or the pair reads as a zero-length press.
    pedal_marks.sort(key=lambda m: (m[0], 0 if m[1] == "stop" else 1))
    open_beat = None
    for beat, action in pedal_marks:
        if action == "start":
            if open_beat is None:
                open_beat = beat
        elif action == "stop" and open_beat is not None:
            if beat > open_beat:
                pedals.append((open_beat, beat))
            open_beat = None
    if open_beat is not None and last_end > open_beat:
        pedals.append((open_beat, last_end))
    pedals = [{"onset": round(to_seconds(a), 4),
               "offset": round(to_seconds(b), 4)} for a, b in pedals]

    return notes, pedals, warnings


def _walk_part(part_el):
    """One part's measures -> (notes, directives, saw_repeat), everything
    in absolute quarter-note beats. Ties are merged here: a tie-stop note
    extends its still-open predecessor instead of emitting a new note."""
    notes = []
    directives = []   # (beat, kind, value)
    divisions = 1
    global_start = 0.0
    saw_repeat = False
    open_ties = {}    # pitch -> index into notes (awaiting continuation)

    for measure in part_el.findall("measure"):
        local = 0
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
                if info is not None and not is_grace and divisions:
                    midi = info[0]
                    onset = global_start + onset_local / divisions
                    duration = dur / divisions
                    tie_start, tie_stop = _tie_flags(child)
                    open_idx = open_ties.get(midi)
                    if (tie_stop and open_idx is not None and
                            abs(notes[open_idx]["onset"]
                                + notes[open_idx]["duration"]
                                - onset) <= TIE_TOL):
                        notes[open_idx]["duration"] += duration
                        if not tie_start:
                            del open_ties[midi]
                    else:
                        notes.append({"onset": onset, "duration": duration,
                                      "pitch": midi})
                        if tie_start:
                            open_ties[midi] = len(notes) - 1
                        elif open_idx is not None and tie_stop:
                            # stop without a matching open note: plain note
                            del open_ties[midi]
                if not is_chord and not is_grace:
                    carrier_onset = local
                    local += dur
            elif tag == "backup":
                local -= int(child.findtext("duration") or 0)
            elif tag == "forward":
                local += int(child.findtext("duration") or 0)
            elif tag == "direction":
                beat = global_start + (local / divisions if divisions else 0)
                directives.extend(_direction_directives(child, beat))
            elif tag == "sound":
                tempo = _parse_tempo(child.get("tempo"))
                if tempo:
                    beat = (global_start
                            + (local / divisions if divisions else 0))
                    directives.append((beat, "tempo", tempo))
            elif tag == "barline":
                if child.find("repeat") is not None:
                    saw_repeat = True
            measure_len = max(measure_len, local)
        global_start += measure_len / divisions if divisions else 0.0
    return notes, directives, saw_repeat


def _tie_flags(note_el):
    start = stop = False
    for tie in note_el.findall("tie"):
        t = tie.get("type")
        start = start or t == "start"
        stop = stop or t == "stop"
    notations = note_el.find("notations")
    if notations is not None:
        for tied in notations.findall("tied"):
            t = tied.get("type")
            start = start or t == "start"
            stop = stop or t == "stop"
    return start, stop


def _parse_tempo(raw):
    """A <sound tempo>/<per-minute> value -> sane BPM float or None."""
    try:
        bpm = float(raw)
    except (TypeError, ValueError):
        return None
    return bpm if 20.0 <= bpm <= 320.0 else None


def _direction_directives(direction_el, beat):
    out = []
    sound = direction_el.find("sound")
    if sound is not None:
        tempo = _parse_tempo(sound.get("tempo"))
        if tempo:
            out.append((beat, "tempo", tempo))
    for dtype in direction_el.findall("direction-type"):
        dyn = dtype.find("dynamics")
        if dyn is not None:
            for mark in dyn:
                vel = DYNAMIC_VELOCITY.get(mark.tag)
                if vel:
                    out.append((beat, "dynamic", vel))
                    break
        wedge = dtype.find("wedge")
        if wedge is not None:
            wtype = wedge.get("type")
            if wtype in ("crescendo", "diminuendo", "stop"):
                out.append((beat, "wedge", wtype))
        metronome = dtype.find("metronome")
        if metronome is not None:
            tempo = _parse_tempo(metronome.findtext("per-minute"))
            if tempo:
                out.append((beat, "tempo", tempo))
        pedal = dtype.find("pedal")
        if pedal is not None:
            ptype = pedal.get("type")
            if ptype == "start":
                out.append((beat, "pedal", "start"))
            elif ptype in ("stop", "discontinue"):
                out.append((beat, "pedal", "stop"))
            elif ptype == "change":
                # re-strike: lift and press again at the same instant
                out.append((beat, "pedal", "stop"))
                out.append((beat, "pedal", "start"))
    return out


def _tempo_mapper(tempi):
    """tempi: sorted (beat, bpm), at least one entry. Returns beat->seconds
    over a piecewise-constant tempo map (first tempo also covers any pickup
    before its own beat)."""
    segments = []   # (start_beat, seconds_at_start, sec_per_beat)
    seconds = 0.0
    prev_beat, prev_bpm = 0.0, tempi[0][1]
    segments.append((0.0, 0.0, 60.0 / prev_bpm))
    for beat, bpm in tempi:
        if beat > prev_beat:
            seconds += (beat - prev_beat) * (60.0 / prev_bpm)
            segments.append((beat, seconds, 60.0 / bpm))
            prev_beat = beat
        prev_bpm = bpm
        segments[-1] = (segments[-1][0], segments[-1][1], 60.0 / bpm)

    def to_seconds(beat):
        seg = segments[0]
        for s in segments:
            if s[0] <= beat:
                seg = s
            else:
                break
        return seg[1] + (beat - seg[0]) * seg[2]

    return to_seconds


def _base_level(beat, dynamics):
    level = DEFAULT_VELOCITY
    for b, vel in dynamics:
        if b <= beat:
            level = vel
        else:
            break
    return level


def _build_ramps(wedge_marks, dynamics):
    """Pair crescendo/diminuendo starts with their next stop; ramp from the
    dynamic level at the start toward the next printed dynamic (or a fixed
    step when none follows). Returns [(start_beat, end_beat, v0, v1)]."""
    ramps = []
    open_wedge = None   # (start_beat, direction)
    for beat, wtype in wedge_marks:
        if wtype in ("crescendo", "diminuendo"):
            open_wedge = (beat, wtype)
        elif wtype == "stop" and open_wedge is not None:
            start, direction = open_wedge
            open_wedge = None
            if beat <= start:
                continue
            v0 = _base_level(start, dynamics)
            v1 = None
            for b, vel in dynamics:
                if b >= beat:
                    v1 = vel
                    break
            if v1 is None:
                step = (WEDGE_FALLBACK_STEP if direction == "crescendo"
                        else -WEDGE_FALLBACK_STEP)
                v1 = v0 + step
            ramps.append((start, beat, v0, v1))
    return ramps


def _velocity_at(beat, dynamics, ramps):
    for start, end, v0, v1 in ramps:
        if start <= beat < end:
            return v0 + (v1 - v0) * (beat - start) / (end - start)
    return _base_level(beat, dynamics)
