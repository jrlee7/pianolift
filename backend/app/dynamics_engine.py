"""Auto-dynamics suggestions for piano MusicXML.

Heuristic: segment the top-staff melody into phrases at rests, then shape
each phrase with a crescendo/diminuendo wedge that builds toward its
highest note and releases after it (a flat/near-flat phrase gets no
wedge). Each phrase also gets a coarse base dynamic (pp..ff) from its
average register and note density relative to the whole piece, only
written when it changes from the previous phrase. Heuristic and coarse by
design — a starting point to edit, not a performance-quality reading.
"""

import statistics
import xml.etree.ElementTree as ET

from .musicxml_io import part_timeline, insert_directions, pick_part

PHRASE_GAP_BEATS = 1.0     # a melodic rest at least this long splits phrases
MAX_PHRASE_BEATS = 16.0    # hard cap so one long unbroken run still splits
DYNAMIC_WORDS = ["pp", "p", "mp", "mf", "f", "ff"]


def _melody_events(events):
    """Events on the top (lowest-numbered) staff, or all events for a
    single-staff score."""
    if not events:
        return events
    staves = {e["staff"] for e in events}
    if len(staves) <= 1:
        return events
    top = min(staves, key=lambda s: int(s))
    return [e for e in events if e["staff"] == top]


def _segment_phrases(events):
    if not events:
        return []
    phrases = [[events[0]]]
    phrase_start = events[0]["onset"]
    prev_end = events[0]["onset"] + events[0]["duration"]
    for e in events[1:]:
        gap = e["onset"] - prev_end
        too_long = (e["onset"] - phrase_start) > MAX_PHRASE_BEATS
        if gap >= PHRASE_GAP_BEATS or too_long:
            phrases.append([])
            phrase_start = e["onset"]
        phrases[-1].append(e)
        prev_end = max(prev_end, e["onset"] + e["duration"])
    return [p for p in phrases if p]


def _base_dynamic(phrase, piece_mean_pitch, piece_mean_density):
    avg_pitch = statistics.mean(e["midi"] for e in phrase)
    span = phrase[-1]["onset"] + phrase[-1]["duration"] - phrase[0]["onset"]
    density = len(phrase) / span if span > 0 else len(phrase)
    score = (avg_pitch - piece_mean_pitch) * 0.15 + (density - piece_mean_density) * 1.5
    idx = max(0, min(len(DYNAMIC_WORDS) - 1, 3 + round(score)))  # centered on mf
    return DYNAMIC_WORDS[idx]


def _wedge_shape(phrase):
    """('crescendo'|'diminuendo'|'arch'|None, peak_onset)."""
    if len(phrase) < 3:
        return None, None
    peak = max(phrase, key=lambda e: e["midi"])
    peak_pos = phrase.index(peak) / (len(phrase) - 1)
    lo = min(e["midi"] for e in phrase)
    if peak["midi"] - lo < 3:  # near-flat melody: not worth a wedge
        return None, None
    if peak_pos < 0.15:
        return "diminuendo", peak["onset"]
    if peak_pos > 0.85:
        return "crescendo", peak["onset"]
    return "arch", peak["onset"]


def _dynamics_dir(word, staff):
    def build():
        direction = ET.Element("direction", {"placement": "below"})
        dtype = ET.SubElement(direction, "direction-type")
        dyn = ET.SubElement(dtype, "dynamics")
        ET.SubElement(dyn, word)
        if staff is not None:
            ET.SubElement(direction, "staff").text = staff
        return direction
    return build


def _wedge_dir(wtype, staff):
    def build():
        direction = ET.Element("direction", {"placement": "below"})
        dtype = ET.SubElement(direction, "direction-type")
        ET.SubElement(dtype, "wedge", {"type": wtype, "number": "1"})
        if staff is not None:
            ET.SubElement(direction, "staff").text = staff
        return direction
    return build


def suggest_dynamics(root):
    """Insert suggested <dynamics> marks and crescendo/diminuendo <wedge>
    pairs into the score's chosen part. Mutates `root` in place. Returns
    the number of marks added."""
    part = pick_part(root)
    events, bounds = part_timeline(part)
    if not events:
        return 0
    staves_present = {e["staff"] for e in events}
    # Piano engraving convention: one shared dynamics/wedge line under the
    # bottom staff, even though the contour driving it is read from the
    # melody (top staff).
    engrave_staff = max(staves_present, key=lambda s: int(s)) if len(staves_present) > 1 else None
    melody = _melody_events(events)
    phrases = _segment_phrases(melody)
    if not phrases:
        return 0

    piece_mean_pitch = statistics.mean(e["midi"] for e in melody)
    total_span = melody[-1]["onset"] + melody[-1]["duration"] - melody[0]["onset"]
    piece_mean_density = len(melody) / total_span if total_span > 0 else len(melody)

    scheduled = []
    count = 0
    last_word = None
    for phrase in phrases:
        word = _base_dynamic(phrase, piece_mean_pitch, piece_mean_density)
        start = phrase[0]["onset"]
        end = phrase[-1]["onset"] + phrase[-1]["duration"]
        if word != last_word:
            scheduled.append((start, _dynamics_dir(word, engrave_staff)))
            count += 1
            last_word = word

        shape, peak_onset = _wedge_shape(phrase)
        if shape == "crescendo":
            scheduled.append((start, _wedge_dir("crescendo", engrave_staff)))
            scheduled.append((end, _wedge_dir("stop", engrave_staff)))
            count += 2
        elif shape == "diminuendo":
            scheduled.append((start, _wedge_dir("diminuendo", engrave_staff)))
            scheduled.append((end, _wedge_dir("stop", engrave_staff)))
            count += 2
        elif shape == "arch":
            scheduled.append((start, _wedge_dir("crescendo", engrave_staff)))
            scheduled.append((peak_onset, _wedge_dir("stop", engrave_staff)))
            scheduled.append((peak_onset, _wedge_dir("diminuendo", engrave_staff)))
            scheduled.append((end, _wedge_dir("stop", engrave_staff)))
            count += 4

    insert_directions(part, bounds, scheduled)
    return count
