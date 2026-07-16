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

  * re-strike gate -- on reverb-heavy or heavily-pedaled recordings a
    still-ringing pitch carries enough energy that the score/rise ghost
    test alone can't tell a real re-strike from the tail of the previous
    note: score stays high (there IS energy at that pitch) even though no
    hammer struck. A single-engine, unconfirmed note with no attack
    transient (low rise) AND no onset-strength support in the raw audio at
    its claimed onset cannot be a new keystroke -- dropped, regardless of
    its score. Measured on a reverb-heavy solo piano job: ByteDance
    hallucinated 43% of its notes this way (Transkun only 1%); this gate
    removed 315/315 of them in a 120s test clip with zero two-engine notes
    lost. Each fake re-strike was also chopping the real held note via the
    declash rule above, so this one gate fixes both "extra notes" and
    "notes cut short" symptoms at once.
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

# Re-strike gate: a note with no attack transient (rise below this) and no
# onset-strength peak in the raw audio within this window of its claimed
# onset isn't a new keystroke -- see module docstring.
RESTRIKE_RISE_MIN = 2.0
ONSET_SUPPORT_WINDOW_SEC = 0.10

# A real hammer strike adds energy: the pitch envelope rises through the
# onset. A hallucinated re-strike is the decaying tail of the previous
# note — energy through its claimed onset can only fall. Only kill when
# the local envelope is NOT rising (post/pre below this ratio). Measured
# on a reverb hymn: true tails median 0.93, real strikes median 4.8 —
# 1.05 rescues every repeated-chord strike and keeps killing the tails.
RESTRIKE_DECAY_MAX = 1.05

_ATTACK_FRAMES = 4      # ~93ms windows around the onset for the rise test

# Mix cross-check: a stem note counts as confirmed when the transcription
# of the ORIGINAL mix contains the same pitch within this onset window.
# The piano in the mix has no separation artifacts, so confirmation is
# strong evidence the note is real; absence is only suspicion — measured
# on a piano+cello track, 21% of real stem notes went unconfirmed purely
# because the other instrument masked them in the mix, with median
# spectral score 67 (clearly real). Unconfirmed notes therefore face a
# stricter spectral bar than the base rule, never outright deletion.
# The window is insensitive between 0.05 and 0.12 on the same data.
MATCH_WINDOW_SEC = 0.08
UNCONF_SCORE_MAX = 5.0
UNCONF_RISE_MAX = 3.0

# Micro-note rule: a keystroke this short is mechanically impossible
# (a Disklavier action can't articulate it) and at low spectral score is
# always a transient artifact — measured examples sit at 6-15ms with
# velocity 19-39 in cello-bleed register. Independent of confirmation.
MICRO_DUR_SEC = 0.03
MICRO_SCORE_MAX = 10.0

# Ensemble cross-check: same-pitch onsets from the two transcription
# engines (ByteDance high-res + Transkun V2) within this window are the
# same keystroke. Wider than DEDUPE (intra-engine double fire) because the
# engines carry slightly different onset biases; still narrower than any
# musical re-strike at one pitch.
ALT_MATCH_WINDOW_SEC = 0.05

# Two pedal lifts closer than this are re-pedal flutter (or an engine
# double-fire), not a musical re-pedal — a pianist can't cycle the physical
# pedal that fast, and the Disklavier certainly can't.
PEDAL_GAP_MERGE_SEC = 0.05

# Bass fundamentals are weak on real pianos (string inharmonicity +
# soundboard rolloff): below ~C3 most of a note's energy sits in harmonics
# 2-3, so measuring only the fundamental CQT bin under-scores real bass
# notes (false ghost risk) and over-trims their offsets. For those pitches
# the note's envelope is the elementwise max of the fundamental bin and the
# +12/+19-semitone bins (harmonics 2 and 3). Only below BASS_PITCH_MAX:
# higher up fundamentals are strong, and the harmonic bins would inherit
# energy from other notes actually sounding there.
BASS_PITCH_MAX = 48            # C3
_HARMONIC_OFFSETS = (12, 19)   # +1 octave, +1 octave and a fifth


def _cqt_mag(piano_wav):
    """Constant-Q magnitude spectrogram plus broadband onset times, from a
    single audio load of the stem (onset detection is cheap next to the
    CQT, so folding it in here costs nothing extra)."""
    import librosa

    y, _ = librosa.load(piano_wav, sr=SR, mono=True)
    mag = np.abs(librosa.cqt(y, sr=SR, hop_length=HOP, fmin=FMIN,
                             n_bins=N_BINS, bins_per_octave=12))
    onset_env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=SR,
                                        hop_length=HOP, units="time",
                                        backtrack=False)
    return mag, sorted(onsets.tolist())


def _onset_supported(sorted_onsets, t, window):
    """Is there a broadband onset within `window` seconds of time `t`?"""
    from bisect import bisect_left

    if not sorted_onsets:
        return False
    i = bisect_left(sorted_onsets, t)
    for j in (i - 1, i):
        if 0 <= j < len(sorted_onsets) and abs(sorted_onsets[j] - t) <= window:
            return True
    return False


def _local_rise(env, f0):
    """Pitch-envelope energy direction through frame f0 (~±70ms)."""
    pre = env[max(0, f0 - 3):f0]
    post = env[f0 + 1:f0 + 4]
    if pre.size == 0 or post.size == 0:
        return 9.9  # edge of clip: no decay evidence, never gate-kill
    return float(post.mean() / (pre.mean() + 1e-9))


def _pitch_envelope(mag, pitch, cache):
    """Time envelope for a pitch: its fundamental bin, max-combined with the
    harmonic-2/3 bins for bass pitches (see BASS_PITCH_MAX). Cached per pitch
    with its own 20th-percentile quiet level (survives dense passages where
    the median would be inflated by real playing)."""
    hit = cache.get(pitch)
    if hit is not None:
        return hit
    b = min(N_BINS - 1, max(0, pitch - 21))
    rows = [b]
    if pitch < BASS_PITCH_MAX:
        rows += [b + h for h in _HARMONIC_OFFSETS if b + h < N_BINS]
    env = mag[b] if len(rows) == 1 else np.max(mag[rows], axis=0)
    floor = float(np.percentile(env, 20)) + 1e-9
    cache[pitch] = (env, floor)
    return env, floor


def _note_features(mag, notes):
    """Per note: (score, rise, pitch envelope, span frame bounds)."""
    n_frames = mag.shape[1]
    cache = {}

    feats = []
    for n in notes:
        env, floor = _pitch_envelope(mag, n["pitch"], cache)
        f0 = min(n_frames - 1, max(0, int(round(n["onset"] * SR / HOP))))
        f1 = min(n_frames - 1, max(f0, int(round(n["offset"] * SR / HOP))))
        span = env[f0:f1 + 1]
        peak = float(span.max()) if span.size else 0.0
        score = peak / floor
        pre = env[max(0, f0 - _ATTACK_FRAMES):f0]
        post = env[f0:f0 + _ATTACK_FRAMES]
        pre_e = float(pre.mean()) if pre.size else 0.0
        post_e = float(post.mean()) if post.size else 0.0
        rise = post_e / (pre_e + 1e-9)
        feats.append((score, rise, env, f0, f1))
    return feats


def _trim_offset(env, note, f0, f1):
    """Move the offset back to where the pitch envelope last held
    OFFSET_KEEP_RATIO of the note's own peak. Never extends."""
    span = env[f0:f1 + 1]
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


def _match_indices(notes, others, window):
    """For each note: index of the nearest same-pitch onset in `others`
    within `window` seconds, else None."""
    from bisect import bisect_left

    by_pitch = {}
    for idx, m in enumerate(others):
        by_pitch.setdefault(m["pitch"], []).append((m["onset"], idx))
    for lst in by_pitch.values():
        lst.sort()

    matches = []
    for n in notes:
        cands = by_pitch.get(n["pitch"])
        best = None
        if cands:
            onsets = [c[0] for c in cands]
            i = bisect_left(onsets, n["onset"])
            for j in (i - 1, i):
                if 0 <= j < len(cands):
                    dist = abs(cands[j][0] - n["onset"])
                    if dist <= window and (best is None or dist < best[0]):
                        best = (dist, cands[j][1])
        matches.append(best[1] if best else None)
    return matches


def _confirmed_mask(notes, mix_notes):
    """For each stem note: does the mix transcription have the same pitch
    within MATCH_WINDOW_SEC of its onset?"""
    return [m is not None
            for m in _match_indices(notes, mix_notes, MATCH_WINDOW_SEC)]


def _merge_alt(notes, alt_notes, evidence_only):
    """Fold Transkun's transcription into the ByteDance note list.

    Returns (merged_notes, evidence) where evidence[i] is "both" when the
    two engines agree on the keystroke, "bd"/"alt" when only one saw it.
    Agreed notes take Transkun's velocity only -- its offsets mark key
    release but fire far too early on reverb-heavy material, collapsing
    durations, so ByteDance's offset (already bounded by `_trim_offset`
    against the spectral envelope) is kept instead. Notes only Transkun
    heard join the list as candidates.

    evidence_only=True (the retroactive clean-up path, where `notes` may
    carry user edits) suppresses both — Transkun then only *confirms*
    existing notes, never retimes them or adds new ones.

    Velocity calibration: agreed notes take Transkun's velocity, so a
    ByteDance-only note keeping its raw velocity would leave one song
    mixing two engines' (slightly different) dynamics scales. The matched
    pairs give the mapping for free — fit ByteDance→Transkun linearly and
    push bd-only velocities through it. Skipped when there are too few
    pairs, no velocity spread, or the fit comes out implausible.
    """
    matches = _match_indices(notes, alt_notes, ALT_MATCH_WINDOW_SEC)

    cal = None
    if not evidence_only:
        pairs = [(n["velocity"], alt_notes[m]["velocity"])
                 for n, m in zip(notes, matches) if m is not None]
        if len(pairs) >= 8:
            bd = np.array([p[0] for p in pairs], dtype=float)
            tk = np.array([p[1] for p in pairs], dtype=float)
            if float(bd.std()) > 3.0:
                slope, intercept = np.polyfit(bd, tk, 1)
                if 0.3 <= slope <= 3.0:
                    cal = (float(slope), float(intercept))

    def bd_vel(v):
        if cal is None:
            return v
        return max(1, min(127, int(round(cal[0] * v + cal[1]))))

    merged, evidence = [], []
    matched_alt = set()
    for n, m in zip(notes, matches):
        if m is None:
            out = dict(n)
            out["velocity"] = bd_vel(n["velocity"])
            merged.append(out)
            evidence.append("bd")
            continue
        matched_alt.add(m)
        a = alt_notes[m]
        out = dict(n)
        if not evidence_only:
            out["velocity"] = a["velocity"]
        merged.append(out)
        evidence.append("both")
    if not evidence_only:
        for idx, a in enumerate(alt_notes):
            if idx not in matched_alt:
                merged.append(dict(a))
                evidence.append("alt")
    order = sorted(range(len(merged)), key=lambda i: merged[i]["onset"])
    return [merged[i] for i in order], [evidence[i] for i in order]


def _refine_pedals(pedals, alt_pedals, notes, stats, add_alt=False):
    """Verify sustain-pedal segments instead of passing them through.

    * silence rule -- a pedal segment overlapping no note interval at all
      sustains nothing audible; it can only be separation-bleed fallout.
    * cross-check rule -- with a second engine's pedal list in hand, a
      segment neither engine agrees on AND containing no note onset is
      dropped (a real "catch the chord" pedal always covers ringing notes
      whose intervals overlap it, and near-always a fresh onset).
    * alt recall (add_alt=True) -- a segment only Transkun heard joins as a
      candidate under the same silence rule; ByteDance's pedal detector
      misses some catches Transkun's gets. Off in evidence-only mode (deep
      clean-up of possibly user-edited events must not inject segments).
    * flutter merge -- lifts shorter than PEDAL_GAP_MERGE_SEC between two
      segments can't be played on the physical pedal; merged into one.
    """
    if not pedals and not (add_alt and alt_pedals):
        return pedals

    spans = [(n["onset"], n["offset"]) for n in notes]
    spans.sort()

    def overlaps_note(p):
        return any(s < p["offset"] and e > p["onset"] for s, e in spans)

    def onset_inside(p):
        return any(p["onset"] <= s <= p["offset"] for s, _ in spans)

    def alt_overlap(p):
        return any(a["onset"] < p["offset"] and a["offset"] > p["onset"]
                   for a in alt_pedals)

    kept = []
    for p in pedals:
        if not overlaps_note(p):
            stats["pedalsDropped"] += 1
            continue
        if (alt_pedals is not None and not alt_overlap(p)
                and not onset_inside(p)):
            stats["pedalsDropped"] += 1
            continue
        kept.append(dict(p))

    if add_alt and alt_pedals:
        def bd_overlap(a):
            return any(p["onset"] < a["offset"] and p["offset"] > a["onset"]
                       for p in kept)

        for a in alt_pedals:
            if not bd_overlap(a) and overlaps_note(a):
                kept.append({"onset": round(float(a["onset"]), 4),
                             "offset": round(float(a["offset"]), 4)})
                stats["pedalsAdded"] += 1

    merged = []
    for p in sorted(kept, key=lambda p: p["onset"]):
        if merged and p["onset"] - merged[-1]["offset"] < PEDAL_GAP_MERGE_SEC:
            merged[-1]["offset"] = max(merged[-1]["offset"], p["offset"])
            continue
        merged.append(p)
    return merged


def refine(piano_wav, notes, pedals, progress_cb, mix_notes=None,
           alt_notes=None, alt_pedals=None, alt_evidence_only=False):
    """Drop ghost notes, trim over-held offsets, dedupe double-fired
    onsets, declash same-pitch repeats, verify pedals.

    mix_notes (transcription of the original, pre-separation mix) sharpens
    ghost detection: confirmed notes are never dropped, unconfirmed ones
    face the stricter UNCONF_* spectral bar instead of the base rule.

    alt_notes/alt_pedals (Transkun V2's independent transcription of the
    same stem) sharpen it further: a keystroke both engines report is
    never a ghost and takes Transkun's offset + velocity; a keystroke only
    one engine reports faces the stricter bar unless the mix confirms it.
    alt_evidence_only=True (retroactive clean-up of possibly user-edited
    events) keeps Transkun as pure confirmation evidence — no retiming, no
    injected notes.

    Returns (notes, pedals, stats).
    """
    stats = {"ghosts": 0, "trimmed": 0, "deduped": 0, "unconfirmed": 0,
             "altOnly": 0, "pedalsDropped": 0, "pedalsAdded": 0,
             "restrikes": 0}
    if not notes and not alt_notes:
        return notes, pedals, stats

    evidence = None
    if alt_notes is not None:
        notes, evidence = _merge_alt(notes, alt_notes, alt_evidence_only)
        stats["altOnly"] = sum(1 for e in evidence if e == "alt")

    progress_cb("verifying", 0)
    mag, onset_times = _cqt_mag(piano_wav)
    progress_cb("verifying", 40)
    feats = _note_features(mag, notes)
    confirmed = _confirmed_mask(notes, mix_notes) if mix_notes else None
    progress_cb("verifying", 60)

    kept = []
    for i, (n, (score, rise, env, f0, f1)) in enumerate(zip(notes, feats)):
        if (n["offset"] - n["onset"] < MICRO_DUR_SEC
                and score < MICRO_SCORE_MAX):
            stats["ghosts"] += 1
            continue
        protected = ((evidence is not None and evidence[i] == "both")
                    or (confirmed is not None and confirmed[i]))
        if protected:
            is_ghost = False
        elif evidence is None and confirmed is None:
            # No cross-evidence at all: the original conservative rule.
            is_ghost = score < GHOST_SCORE_MAX and rise < GHOST_RISE_MAX
        else:
            # Single-engine note that no other evidence source backs up.
            stats["unconfirmed"] += 1
            is_ghost = score < UNCONF_SCORE_MAX and rise < UNCONF_RISE_MAX
        if is_ghost:
            stats["ghosts"] += 1
            continue
        if (not protected and rise < RESTRIKE_RISE_MIN
                and _local_rise(env, f0) < RESTRIKE_DECAY_MAX
                and not _onset_supported(onset_times, n["onset"],
                                         ONSET_SUPPORT_WINDOW_SEC)):
            stats["restrikes"] += 1
            continue
        new_off = _trim_offset(env, n, f0, f1)
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
    pedals = _refine_pedals(
        pedals, alt_pedals, deduped, stats,
        add_alt=alt_pedals is not None and not alt_evidence_only)
    progress_cb("verifying", 100)
    return deduped, pedals, stats
