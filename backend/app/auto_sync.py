"""Automatic video sync: how far to delay the MIDI so the piano lands on the
video's own timeline. Two estimators, best one wins:

  * align_audio -- the job still has the audio its notes were transcribed
    from (input mix, or the piano-removed stem when the video is the backing
    track). Matching the video's soundtrack against that same audio is
    near sample-exact: the result is whatever the container added (a
    keyframe-copied chapter cut's lead, AAC priming, a muxed track's start
    offset). Short excerpts at three spots, so a 2-hour movie costs the same
    as a song and a drifting file shows up as disagreement.

  * align_midi -- only notes and the video (library songs, a video picked by
    hand). Pitch-aware: a constant-Q spectral flux of the video audio, one
    row per piano key, is correlated against a piano roll of the notes
    (fundamental + first harmonics). Broadband onset matching locks onto
    drums and cello as readily as piano, which is why the old version was
    hit-or-miss on backing-track videos (piano removed from the audio).

Sign convention matches videoMidiPlayer.js: noteTime = onset + syncSec, so
a positive offsetMs means "delay the MIDI" (the video shows each moment that
much later than the notes' own timeline says).

The physical part of sync (solenoid latency, TV/HDMI delay) is not here --
that is calibrate.js plus the Play tab's room trim.
"""

import os
import subprocess

import numpy as np

from . import pipeline

# librosa (and its numba/soundfile chain) is multiple seconds to import,
# especially in the frozen build. Only align_midi needs it, so it is imported
# lazily there -- main.py imports this module at server boot, and a top-level
# librosa import delays the moment uvicorn binds :8000 ("backend not
# reachable" on every launch).

# --- audio-to-audio --------------------------------------------------------
A_SR = 11025
A_HOP = 32            # envelope hop: 2.9 ms
A_WIN = 256
A_EXCERPT_SEC = 30.0
A_SEARCH_SEC = 8.0
A_MIN_CONF = 0.35

# --- MIDI-to-audio ---------------------------------------------------------
M_SR = 22050
M_HOP = 128           # CQT hop: 5.8 ms (88 bins need a multiple of 2**7)
M_WINDOW_SEC = 25.0
M_WINDOWS = 3
M_SEARCH_SEC = 3.0    # job fallback; library callers pass a wider window
M_MIN_NOTES = 12
# The flux peak trails the transcribed onset by a near-constant few ms (the
# log-energy rise straddles the hammer attack). Measured on a real piano
# recording against its own ByteDance transcription at three known shifts:
# +5.5, +5.8, +5.5 ms. Subtracted so the MIDI path is unbiased.
M_BIAS_MS = 5.5

# Back-compat name: older callers imported this.
SEARCH_WINDOW_SEC = M_SEARCH_SEC


def _decode(path, start, dur, sr):
    """Mono float64 PCM of [start, start+dur) seconds, decoded by ffmpeg.
    -ss before -i seeks the input (fast even 2 hours into a movie) and is
    sample-accurate when decoding."""
    pipeline._ensure_ffmpeg(lambda stage, pct: None)
    cmd = [pipeline.FFMPEG_EXE, "-v", "error", "-nostdin"]
    if start > 0:
        cmd += ["-ss", "%.4f" % start]
    cmd += ["-i", path]
    if dur:
        cmd += ["-t", "%.4f" % dur]
    cmd += ["-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("ffmpeg audio decode failed: "
                           + (tail[-1] if tail else "unknown error"))
    return np.frombuffer(proc.stdout, dtype="<f4").astype(np.float64)


def _envelope(x, hop=A_HOP, win=A_WIN):
    """Rectified rise of log frame energy -- an onset envelope that is cheap,
    level-independent and identical for two decodes of the same audio."""
    if len(x) < win:
        return np.zeros(0)
    from numpy.lib.stride_tricks import sliding_window_view
    frames = sliding_window_view(x, win)[::hop]
    e = (frames * frames) @ np.hanning(win)
    floor = 1e-4 * float(np.mean(e)) + 1e-12
    le = np.log(e + floor)
    d = np.diff(le, prepend=le[0])
    return np.maximum(d, 0.0)


def _ncc_valid(v, r):
    """Normalized cross-correlation of short v against every same-length
    window of long r: c[j] = corr(v, r[j:j+len(v)]), j = 0..len(r)-len(v)."""
    n, m = len(v), len(r)
    if n < 2 or m < n:
        return np.zeros(0)
    v0 = v - v.mean()
    vn = float(np.linalg.norm(v0))
    if vn <= 1e-12:
        return np.zeros(m - n + 1)
    size = 1 << int(np.ceil(np.log2(n + m)))
    c = np.fft.irfft(np.fft.rfft(r, size) * np.conj(np.fft.rfft(v0, size)),
                     size)[:m - n + 1]
    cs = np.concatenate([[0.0], np.cumsum(r)])
    cs2 = np.concatenate([[0.0], np.cumsum(r * r)])
    s = cs[n:] - cs[:-n]
    s2 = cs2[n:] - cs2[:-n]
    rn = np.sqrt(np.maximum(s2 - s * s / n, 1e-12))
    return c / (vn * rn + 1e-12)


def _peak(c):
    """(index, sub-index via parabolic fit, value) of the curve's maximum."""
    j = int(np.argmax(c))
    frac = 0.0
    if 0 < j < len(c) - 1:
        a, b, d = c[j - 1], c[j], c[j + 1]
        den = a - 2 * b + d
        if den < 0:
            frac = float(np.clip(0.5 * (a - d) / den, -0.5, 0.5))
    return j, j + frac, float(c[j])


def _runner_up(c, j, excl):
    """Highest value of c farther than excl samples from index j."""
    mask = np.ones(len(c), dtype=bool)
    mask[max(0, j - excl):j + excl + 1] = False
    return float(c[mask].max()) if mask.any() else 0.0


def _excerpt_starts(span, length, count, margin):
    lo = margin
    hi = span - length - 1.0
    if hi <= lo:
        return [max(0.5, (span - length) / 2.0)]
    if count == 1:
        return [(lo + hi) / 2.0]
    return [float(lo + (hi - lo) * f) for f in np.linspace(0.15, 0.85, count)]


def align_audio(video_path, ref_path, search_sec=A_SEARCH_SEC, guess_sec=0.0):
    """Offset (ms) that puts ref_path's timeline onto the video's: a sound at
    ref time t plays in the video at t + offset. Searches guess_sec +-
    search_sec. Raises ValueError when the two don't match (different
    recordings, silence)."""
    dv = pipeline.media_duration(video_path)
    dr = pipeline.media_duration(ref_path)
    if not dv or not dr:
        raise ValueError("could not read media length")
    span = min(dv, dr + max(0.0, guess_sec))
    if span < 6.0:
        raise ValueError("too short to align")
    length = min(A_EXCERPT_SEC, max(4.0, span - 2 * search_sec - 3.0))
    h = A_HOP / float(A_SR)
    results = []
    lo_margin = 2.0 + max(0.0, guess_sec)
    for s in _excerpt_starts(span, length, 3, lo_margin):
        v = _decode(video_path, s, length, A_SR)
        r0 = max(0.0, s - guess_sec - search_sec)
        r = _decode(ref_path, r0, (s - guess_sec - r0) + length + search_sec,
                    A_SR)
        ev, er = _envelope(v), _envelope(r)
        if len(ev) < 50 or len(er) <= len(ev):
            continue
        c = _ncc_valid(ev, er)
        if not len(c):
            continue
        j, jf, pk = _peak(c)
        second = _runner_up(c, j, int(0.05 / h))
        lag = s - r0 - jf * h
        conf = float(np.clip(pk, 0, 1) * np.clip((pk - second) / 0.2, 0, 1))
        # Same audio twice (codec aside): the waveforms themselves line up,
        # so refine to the sample within +-3 envelope hops.
        j0 = int(round((s - r0 - lag) * A_SR))
        k = 3 * A_HOP
        if j0 - k >= 0 and j0 + k + len(v) <= len(r):
            cw = _ncc_valid(v, r[j0 - k:j0 + k + len(v)])
            if len(cw):
                _wj, wjf, wpk = _peak(cw)
                if wpk > 0.5:
                    lag = s - r0 - (j0 - k + wjf) / A_SR
                    conf = max(conf, float(np.clip(wpk, 0, 1)))
        results.append((lag, conf))
    good = [x for x in results if x[1] >= A_MIN_CONF]
    if not good:
        raise ValueError("video audio doesn't match the source audio")
    lags = np.array([x[0] for x in good])
    med = float(np.median(lags))
    spread_ms = float(np.max(np.abs(lags - med))) * 1000.0
    conf = float(np.median([x[1] for x in good]))
    if len(good) < len(results) or spread_ms > 5.0:
        conf *= 0.75 if spread_ms <= 20.0 else 0.4
    return {"offsetMs": round(med * 1000.0, 1), "confidence": round(conf, 3),
            "method": "audio", "spreadMs": round(spread_ms, 1),
            "excerpts": len(good)}


def _note_windows(onsets, length, count, limit):
    """Start times of up to `count` non-overlapping windows holding the most
    note onsets (two-pointer density scan), each within [0, limit-length]."""
    on = np.sort(np.asarray(onsets, dtype=np.float64))
    on = on[(on >= 0) & (on < limit)]
    if not len(on):
        return []
    cand = []
    j = 0
    for i in range(len(on)):
        while on[j] < on[i] - length:
            j += 1
        cand.append((i - j + 1,
                     float(max(0.0, min(on[j], limit - length)))))
    cand.sort(key=lambda c: -c[0])
    starts = []
    for n, a in cand:
        if n < M_MIN_NOTES or len(starts) >= count:
            break
        if any(abs(a - b) < length for b in starts):
            continue
        starts.append(a)
    return sorted(starts)


def _pitch_flux(y, sr):
    """Per-key spectral flux: rows = MIDI 21..108, frames every M_HOP."""
    import librosa
    C = np.abs(librosa.cqt(y, sr=sr, hop_length=M_HOP,
                           fmin=librosa.midi_to_hz(21), n_bins=88,
                           bins_per_octave=12))
    mx = float(C.max())
    if mx <= 1e-9:
        return None
    L = np.log1p(100.0 * C / mx)
    F = np.maximum(np.diff(L, axis=1, prepend=L[:, :1]), 0.0)
    return np.sqrt(F)


def _piano_roll(notes, a, length, h):
    """Onset roll (88 x frames) for notes in [a, a+length): fundamental plus
    octave / twelfth / double octave, velocity-weighted, lightly smoothed so
    a few ms of transcription jitter doesn't split the peak."""
    from scipy.ndimage import gaussian_filter1d
    K = int(round(length / h)) + 1
    R = np.zeros((88, K))
    for n in notes:
        t = n["onset"] - a
        if t < 0 or t >= length:
            continue
        k = int(round(t / h))
        p = int(n.get("pitch", 60)) - 21
        w = (max(1, n.get("velocity", 64)) / 127.0) ** 0.5
        for dp, g in ((0, 1.0), (12, 0.5), (19, 0.33), (24, 0.25)):
            if 0 <= p + dp < 88:
                R[p + dp, k] += w * g
    return gaussian_filter1d(R, sigma=1.0, axis=1)


def align_midi(video_path, notes, search_sec=M_SEARCH_SEC):
    """Offset (ms) that puts the notes onto the video: a note at time t should
    sound at t + offset. notes: [{onset, pitch, velocity}] on the caller's
    best-guess video timeline. Raises ValueError if nothing matches."""
    if not notes:
        raise ValueError("no notes to sync against")
    dv = pipeline.media_duration(video_path)
    if not dv:
        raise ValueError("could not read video length")
    length = min(M_WINDOW_SEC, max(6.0, dv - 1.0))
    starts = _note_windows([n["onset"] for n in notes], length, M_WINDOWS, dv)
    if not starts:
        raise ValueError("not enough notes inside the video to sync on")
    h = M_HOP / float(M_SR)
    grid = np.arange(-search_sec, search_sec + h / 2, h)
    total = np.zeros(len(grid))
    used = 0
    for a in starts:
        base = max(0.0, a - search_sec)
        y = _decode(video_path, base, (a - base) + length + search_sec, M_SR)
        F = _pitch_flux(y, M_SR) if len(y) > M_SR else None
        if F is None:
            continue
        R = _piano_roll(notes, a, length, h)
        K, T = R.shape[1], F.shape[1]
        if T <= K:
            continue
        size = 1 << int(np.ceil(np.log2(T + K)))
        S = np.fft.irfft(np.sum(np.fft.rfft(F, size, axis=1)
                                * np.conj(np.fft.rfft(R, size, axis=1)),
                                axis=0), size)[:T - K + 1]
        # Normalize by the flux energy under each placement so a loud passage
        # can't win on loudness alone.
        e = np.concatenate([[0.0], np.cumsum(np.sum(F * F, axis=0))])
        E = np.sqrt(np.maximum(e[K:K + len(S)] - e[:len(S)], 1e-12))
        curve = S / E
        lags = base + np.arange(len(curve)) * h - a
        z = (curve - np.median(curve)) / (np.std(curve) + 1e-12)
        total += np.interp(grid, lags, z, left=0.0, right=0.0)
        used += 1
    if not used:
        raise ValueError("video audio is silent where the notes are")
    total /= used
    j, jf, pk = _peak(total)
    second = _runner_up(total, j, int(0.08 / h))
    lag = float(np.interp(jf, np.arange(len(grid)), grid))
    # pk is a z-score; a clean lock sits far above the next-best lag.
    conf = float(np.clip((pk - 3.0) / 6.0, 0, 1)
                 * np.clip((pk - second) / 2.0, 0, 1))
    return {"offsetMs": round(lag * 1000.0 - M_BIAS_MS, 1),
            "confidence": round(conf, 3), "method": "midi", "windows": used}


def compute_offset(video_path, notes, ref_path=None,
                   search_sec=M_SEARCH_SEC):
    """Best available estimate: audio-to-audio when a reference is given and
    matches, else the pitch-aware MIDI match. Returns
    {offsetMs, confidence (0..1), method, ...}."""
    best = None
    errors = []
    if ref_path and os.path.exists(ref_path):
        try:
            best = align_audio(video_path, ref_path)
        except Exception as e:
            errors.append("audio: " + str(e))
    if best is None or best["confidence"] < 0.6:
        try:
            m = align_midi(video_path, notes, search_sec=search_sec)
            if best is None or m["confidence"] > best["confidence"]:
                best = m
        except Exception as e:
            errors.append("midi: " + str(e))
    if best is None:
        raise ValueError("; ".join(errors) or "nothing to sync against")
    return best
