"""Build a Standard MIDI File from transcribed note/pedal events.

The MIDI timeline is zero-aligned to the source MP3: second 0 of the MIDI
equals second 0 of the audio, so starting both together keeps them in sync
on the Disklavier.
"""

import mido

TICKS_PER_BEAT = 480
TEMPO = 500000  # 120 bpm -> 1 beat = 0.5 s -> 960 ticks per second
TICKS_PER_SECOND = TICKS_PER_BEAT * (1000000.0 / TEMPO)


def _sec_to_ticks(sec):
    if sec < 0:
        sec = 0
    return int(round(sec * TICKS_PER_SECOND))


# The ByteDance transcriber marks note-off where the string finally damps
# (natural decay + sustain ring), not where a finger would lift, so raw note
# durations run long and keys stay depressed longer than they need to.
# release_ms trims a fixed amount off each note's tail; MIN_NOTE_SEC keeps a
# note from collapsing to nothing so it still sounds.
MIN_NOTE_SEC = 0.03

# Longest a struck string can audibly ring on a concert grand, by pitch. Bass
# strings (long, heavy, high energy) sustain on the order of 30 s with the key
# held; the top octave (short strings, and no dampers at all above ~C7) barely
# rings 1 s. Between the anchors sustain falls off roughly geometrically per
# octave, so a smooth exponential fit tracks the real instrument. A note the
# transcriber marks longer than this could never have been physically sounding,
# so capping it there removes stuck-key artifacts without touching real holds.
_SUSTAIN_LOW_SEC = 30.0   # pitch 21 (A0)
_SUSTAIN_HIGH_SEC = 1.0   # pitch 108 (C8)
_PITCH_LOW = 21
_PITCH_HIGH = 108


def max_sustain_sec(pitch):
    """Physical audible-ring ceiling for a held key at this MIDI pitch."""
    p = min(_PITCH_HIGH, max(_PITCH_LOW, pitch))
    frac = (p - _PITCH_LOW) / float(_PITCH_HIGH - _PITCH_LOW)
    return _SUSTAIN_LOW_SEC * (_SUSTAIN_HIGH_SEC / _SUSTAIN_LOW_SEC) ** frac


def shape_note_end(onset, offset, pitch, release_ms, cap_sustain):
    """Trim a note's end by release_ms and, if cap_sustain, clamp it to the
    physical sustain ceiling for its pitch. Floored to MIN_NOTE_SEC length."""
    end = offset - release_ms / 1000.0
    if cap_sustain:
        cap = onset + max_sustain_sec(pitch)
        if end > cap:
            end = cap
    floor = onset + MIN_NOTE_SEC
    return end if end > floor else floor


def map_velocity(raw, vel_min, vel_max, gamma):
    """Map raw model velocity (1-127) onto a playable Disklavier range.

    gamma < 1 lifts quiet notes, gamma > 1 exaggerates dynamics.
    """
    norm = raw / 127.0
    if norm < 0.0:
        norm = 0.0
    if norm > 1.0:
        norm = 1.0
    shaped = norm ** gamma
    out = int(round(vel_min + shaped * (vel_max - vel_min)))
    if out < 1:
        out = 1
    if out > 127:
        out = 127
    return out


def read_midi(path):
    """Parse a Standard MIDI File back into (notes, pedals) events — the
    inverse of write_midi, used to pull a library song (stored only as baked
    MIDI) back into the editor. Iterating the MidiFile yields per-message delta
    times already in seconds (mido applies the tempo map), so absolute onset/
    offset times fall out by accumulation. Note velocities come back as-is
    (already mapped when the file was written); pedal = CC64 >= 64 held."""
    import mido

    mid = mido.MidiFile(path)
    abs_t = 0.0
    active = {}      # pitch -> (onset_sec, velocity)
    ped_on = None    # onset_sec while CC64 is held down, else None
    notes = []
    pedals = []
    for msg in mid:
        abs_t += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            active[msg.note] = (abs_t, msg.velocity)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            st = active.pop(msg.note, None)
            if st is not None:
                onset, vel = st
                notes.append({
                    "onset": round(onset, 4), "offset": round(abs_t, 4),
                    "pitch": msg.note, "velocity": vel,
                })
        elif msg.type == "control_change" and msg.control == 64:
            if msg.value >= 64:
                if ped_on is None:
                    ped_on = abs_t
            elif ped_on is not None:
                pedals.append({"onset": round(ped_on, 4), "offset": round(abs_t, 4)})
                ped_on = None
    # Close anything left hanging at end-of-file so nothing is dropped.
    for pitch, (onset, vel) in active.items():
        notes.append({
            "onset": round(onset, 4), "offset": round(abs_t, 4),
            "pitch": pitch, "velocity": vel,
        })
    if ped_on is not None:
        pedals.append({"onset": round(ped_on, 4), "offset": round(abs_t, 4)})
    notes.sort(key=lambda n: n["onset"])
    pedals.sort(key=lambda p: p["onset"])
    return notes, pedals


def write_midi(notes, pedals, out_path,
               vel_min=20, vel_max=112, gamma=1.0,
               offset_ms=0, include_pedal=True, release_ms=0,
               cap_sustain=True):
    """notes: [{onset, offset, pitch, velocity}], pedals: [{onset, offset}].

    Times in seconds. offset_ms shifts every event (positive = later).
    release_ms trims each note's tail so keys don't hold too long; cap_sustain
    clamps any note to its pitch's physical sustain ceiling.
    Returns number of notes written.
    """
    shift = offset_ms / 1000.0
    events = []  # (tick, priority, mido.Message)

    for n in notes:
        onset = n["onset"] + shift
        offset = n["offset"] + shift
        if offset <= 0:
            continue
        offset = shape_note_end(onset, offset, n["pitch"], release_ms,
                                cap_sustain)
        vel = map_velocity(n["velocity"], vel_min, vel_max, gamma)
        on_tick = _sec_to_ticks(onset)
        off_tick = _sec_to_ticks(offset)
        if off_tick <= on_tick:
            off_tick = on_tick + 1
        events.append((on_tick, 2, mido.Message(
            "note_on", note=n["pitch"], velocity=vel, channel=0)))
        events.append((off_tick, 0, mido.Message(
            "note_off", note=n["pitch"], velocity=0, channel=0)))

    if include_pedal:
        for p in pedals:
            onset = p["onset"] + shift
            offset = p["offset"] + shift
            if offset <= 0:
                continue
            on_tick = _sec_to_ticks(onset)
            off_tick = _sec_to_ticks(offset)
            if off_tick <= on_tick:
                off_tick = on_tick + 1
            events.append((on_tick, 1, mido.Message(
                "control_change", control=64, value=127, channel=0)))
            events.append((off_tick, 1, mido.Message(
                "control_change", control=64, value=0, channel=0)))

    events.sort(key=lambda e: (e[0], e[1]))

    mid = mido.MidiFile(type=0, ticks_per_beat=TICKS_PER_BEAT)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=TEMPO, time=0))
    track.append(mido.Message("program_change", program=0, channel=0, time=0))

    last_tick = 0
    for tick, _prio, msg in events:
        msg.time = tick - last_tick
        track.append(msg)
        last_tick = tick

    track.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(out_path)
    note_count = sum(1 for n in notes if n["offset"] + shift > 0)
    return note_count
