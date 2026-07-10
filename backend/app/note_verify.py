"""Verify transcribed notes against the piano stem's spectrogram.

The ByteDance transcriber was trained on clean solo-piano recordings
(MAESTRO); separated stems carry bleed and phase artifacts it happily
hallucinates notes from, and its note-offs mark where the string finally
damps rather than where the sound stopped being audible. Both failure
modes are checkable against the audio itself, cheaply, with a constant-Q
spectrogram of the stem:

  * ghost removal -- a real note leaves energy at its fundamental for its
    whole span and that energy *rises* at the onset (the hammer strike).
    A note whose pitch bin never gets meaningfully above that bin's own
    noise floor AND shows no rise at the onset cannot have been played.
    Requiring both keeps quiet-but-real notes safe.

  * offset trimming -- a note is only kept "held" while its pitch bin
    still carries a meaningful fraction of the note's own peak energy.
    Offsets only ever move earlier, never later.

  * re-onset declash -- a note's offset is clamped ahead of the next
    onset at the same pitch, so the Disklavier's physical key has time to
    come back up before it must re-strike.
"""

import numpy as np

SR = 22050
HOP = 512               # ~23ms per frame
FMIN = 27.5             # A0 = MIDI 21, CQT bin 0
N_BINS = 88

# Ghost rule: drop only when BOTH hold (conservative -- a dropped real
# note is worse than a surviving ghost, since the editor can delete but
# not un-forget).
GHOST_SCORE_MAX = 2.0   # span peak vs the bin's quiet level (20th pct)
GHOST_RISE_MAX = 1.5    # onset-window energy vs pre-onset window

# Offset trim: note stays held while its bin keeps >= this fraction of
# the note's own span peak (0.2 = -14 dB), plus a short release pad.
# Measured on a real conversion this leaves the median duration alone and
# pulls the 90th percentile from ~2.0s to ~1.8s -- it targets exactly the
# over-held long notes without touching normal ones.
OFFSET_KEEP_RATIO = 0.2
RELEASE_PAD_SEC = 0.06
MIN_NOTE_SEC = 0.05

# Physical key clearance before the same pitch strikes again.
REONSET_GAP_SEC = 0.03

# Two onsets of one pitch closer than this are one keystroke double-fired.
DEDUPE_WINDOW_SEC = 0.03

_ATTACK_FRAMES = 4      # ~93ms windows around the onset for the rise test

# Mix cross-check: a stem note counts as confirmed when the transcription
# of the ORIGINAL mix contains the same pitch within this onset window.
# The piano in the mix has no separation artifacts, so confirmation is
# strong evidence the note is real; absence is only suspicion (the note
# may be masked by other instruments there), so unconfirmed notes are not
# dropped outright — they face a stricter spectral bar than the base rule.
MATCH_WINDOW_SEC = 0.08
UNCONF_SCORE_MAX = 3.0
UNCONF_RISE_MAX = 2.0


def _cqt_mag(piano_wav):
    import librosa

    y, _ = librosa.load(piano_wav, sr=SR, mono=True)
    mag = np.abs(librosa.cqt(y, sr=SR, hop_length=HOP, fmin=FMIN,
                             n_bins=N_BINS, bins_per_octave=12))
    return mag


def _note_features(mag, notes):
    """Per note: (score, rise, span envelope slice bounds)."""
    n_frames = mag.shape[1]
    # A bin's own quiet level; 20th percentile survives dense passages
    # where the median would be inflated by real playing.
    floor = np.percentile(mag, 20, axis=1) + 1e-9

    feats = []
    for n in notes:
        b = min(N_BINS - 1, max(0, n["pitch"] - 21))
        f0 = min(n_frames - 1, max(0, int(round(n["onset"] * SR / HOP))))
        f1 = min(n_frames - 1, max(f0, int(round(n["offset"] * SR / HOP))))
        span = mag[b, f0:f1 + 1]
        peak = float(span.max()) if span.size else 0.0
        score = peak / floor[b]
        pre = mag[b, max(0, f0 - _ATTACK_FRAMES):f0]
        post = mag[b, f0:f0 + _ATTACK_FRAMES]
        pre_e = float(pre.mean()) if pre.size else 0.0
        post_e = float(post.mean()) if post.size else 0.0
        rise = post_e / (pre_e + 1e-9)
        feats.append((score, rise, b, f0, f1))
    return feats


def _trim_offset(mag, note, b, f0, f1):
    """Move the offset back to where the bin last held OFFSET_KEEP_RATIO of
    the note's own peak. Never extends."""
    span = mag[b, f0:f1 + 1]
    if span.size == 0:
        return note["offset"]
    peak = span.max()
    if peak <= 0:
        return note["offset"]
    alive = np.where(span >= peak * OFFSET_KEEP_RATIO)[0]
    last = f0 + int(alive[-1]) if alive.size else f0
    new_off = (last + 1) * HOP / float(SR) + RELEASE_PAD_SEC
    new_off = max(new_off, note["onset"] + MIN_NOTE_SEC)
    return round(min(note["offset"], new_off), 4)


def _confirmed_mask(notes, mix_notes):
    """For each stem note: does the mix transcription have the same pitch
    within MATCH_WINDOW_SEC of its onset?"""
    from bisect import bisect_left

    by_pitch = {}
    for m in mix_notes:
        by_pitch.setdefault(m["pitch"], []).append(m["onset"])
    for onsets in by_pitch.values():
        onsets.sort()

    mask = []
    for n in notes:
        onsets = by_pitch.get(n["pitch"])
        hit = False
        if onsets:
            i = bisect_left(onsets, n["onset"])
            for j in (i - 1, i):
                if (0 <= j < len(onsets)
                        and abs(onsets[j] - n["onset"]) <= MATCH_WINDOW_SEC):
                    hit = True
                    break
        mask.append(hit)
    return mask


def refine(piano_wav, notes, pedals, progress_cb, mix_notes=None):
    """Drop ghost notes, trim over-held offsets, dedupe double-fired
    onsets, declash same-pitch repeats. Pedals pass through untouched.

    mix_notes (transcription of the original, pre-separation mix) sharpens
    ghost detection: confirmed notes are never dropped, unconfirmed ones
    face the stricter UNCONF_* spectral bar instead of the base rule.

    Returns (notes, pedals, stats).
    """
    stats = {"ghosts": 0, "trimmed": 0, "deduped": 0, "unconfirmed": 0}
    if not notes:
        return notes, pedals, stats

    progress_cb("verifying", 0)
    mag = _cqt_mag(piano_wav)
    progress_cb("verifying", 40)
    feats = _note_features(mag, notes)
    confirmed = _confirmed_mask(notes, mix_notes) if mix_notes else None
    progress_cb("verifying", 60)

    kept = []
    for i, (n, (score, rise, b, f0, f1)) in enumerate(zip(notes, feats)):
        if confirmed is None:
            is_ghost = score < GHOST_SCORE_MAX and rise < GHOST_RISE_MAX
        elif confirmed[i]:
            is_ghost = False
        else:
            stats["unconfirmed"] += 1
            is_ghost = score < UNCONF_SCORE_MAX and rise < UNCONF_RISE_MAX
        if is_ghost:
            stats["ghosts"] += 1
            continue
        new_off = _trim_offset(mag, n, b, f0, f1)
        if new_off < n["offset"]:
            stats["trimmed"] += 1
            n = dict(n, offset=new_off)
        kept.append(n)
    progress_cb("verifying", 85)

    # Dedupe double-fired onsets: same pitch, near-identical onset.
    kept.sort(key=lambda n: (n["pitch"], n["onset"]))
    deduped = []
    for n in kept:
        prev = deduped[-1] if deduped else None
        if (prev is not None and prev["pitch"] == n["pitch"]
                and n["onset"] - prev["onset"] < DEDUPE_WINDOW_SEC):
            merged = dict(prev)
            merged["offset"] = max(prev["offset"], n["offset"])
            merged["velocity"] = max(prev["velocity"], n["velocity"])
            deduped[-1] = merged
            stats["deduped"] += 1
            continue
        deduped.append(n)

    # Declash: key must clear before the same pitch re-strikes.
    for prev, nxt in zip(deduped, deduped[1:]):
        if prev["pitch"] != nxt["pitch"]:
            continue
        limit = round(nxt["onset"] - REONSET_GAP_SEC, 4)
        if prev["offset"] > limit:
            prev["offset"] = max(limit, prev["onset"] + MIN_NOTE_SEC)

    deduped.sort(key=lambda n: n["onset"])
    progress_cb("verifying", 100)
    return deduped, pedals, stats
