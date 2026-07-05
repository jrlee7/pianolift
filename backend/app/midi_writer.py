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


def write_midi(notes, pedals, out_path,
               vel_min=20, vel_max=112, gamma=1.0,
               offset_ms=0, include_pedal=True):
    """notes: [{onset, offset, pitch, velocity}], pedals: [{onset, offset}].

    Times in seconds. offset_ms shifts every event (positive = later).
    Returns number of notes written.
    """
    shift = offset_ms / 1000.0
    events = []  # (tick, priority, mido.Message)

    for n in notes:
        onset = n["onset"] + shift
        offset = n["offset"] + shift
        if offset <= 0:
            continue
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
