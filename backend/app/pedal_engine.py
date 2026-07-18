"""Auto-pedal suggestions for piano MusicXML.

Heuristic: syncopated pedaling driven by bass-staff note attacks — the
standard beginner/intermediate rule (pedal changes with each new bass note,
lifts on a bass rest long enough to matter). Falls back to whole-texture
attack-grouping for single-staff scores with no separate bass staff. This
is a starting point meant to be edited, not a substitute for real pedaling
judgment (it has no sense of legato slurs, articulation, or voice-leading).
"""

import xml.etree.ElementTree as ET

from .musicxml_io import part_timeline, insert_directions, pick_part

REST_LIFT_BEATS = 0.75  # a bass gap at least this long fully lifts the pedal


def _round_beat(b):
    return round(b * 16) / 16.0  # snap to a 1/16-beat grid


def _attack_groups(events):
    """Group note-on events sharing (near-)identical onset into chords.
    Returns [(onset, [events]), ...] sorted by onset."""
    groups = {}
    for e in events:
        key = _round_beat(e["onset"])
        groups.setdefault(key, []).append(e)
    return sorted(groups.items())


def _pedal_dir(ptype, staff):
    def build():
        direction = ET.Element("direction", {"placement": "below"})
        dtype = ET.SubElement(direction, "direction-type")
        ET.SubElement(dtype, "pedal", {"type": ptype, "line": "yes"})
        if staff is not None:
            ET.SubElement(direction, "staff").text = staff
        return direction
    return build


def suggest_pedal(root):
    """Insert suggested <direction><pedal> marks into the score's chosen
    part. Mutates `root` in place. Returns the number of pedal segments."""
    part = pick_part(root)
    events, bounds = part_timeline(part)
    if not events:
        return 0
    staves_present = {e["staff"] for e in events}
    bass_staff = max(staves_present, key=lambda s: int(s)) if len(staves_present) > 1 else None
    driver = [e for e in events if e["staff"] == bass_staff] if bass_staff else events

    attacks = _attack_groups(driver)
    if not attacks:
        return 0

    piece_end = bounds[-1][2]
    # One segment per bass attack; a gap to the next attack that's long
    # enough to be a real rest gets a plain lift instead of a syncopated
    # change straight into the next chord.
    segments = []  # (onset, offset)
    for i, (onset, grp) in enumerate(attacks):
        held_end = max(e["onset"] + e["duration"] for e in grp)
        next_onset = attacks[i + 1][0] if i + 1 < len(attacks) else piece_end
        gap = next_onset - held_end
        seg_end = next_onset if gap < REST_LIFT_BEATS else held_end
        segments.append((onset, seg_end))

    scheduled = []
    for i, (onset, seg_end) in enumerate(segments):
        if i == 0:
            ptype = "start"
        else:
            prev_end = segments[i - 1][1]
            # Contiguous with the previous segment -> lift+redepress in one
            # mark; otherwise the previous one already closed with "stop".
            ptype = "change" if abs(prev_end - onset) < 1e-6 else "start"
        scheduled.append((onset, _pedal_dir(ptype, bass_staff)))
        is_last = (i == len(segments) - 1)
        next_touches = (not is_last) and abs(segments[i + 1][0] - seg_end) < 1e-6
        if not next_touches:
            scheduled.append((seg_end, _pedal_dir("stop", bass_staff)))

    insert_directions(part, bounds, scheduled)
    return len(scheduled)  # count of <pedal> elements, matching count_marks
