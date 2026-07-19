"""Cross-correlation auto-sync: aligns transcribed MIDI onsets against the
video's own audio track, so the user doesn't have to hand-tune videoSyncMs
by ear (tap-sync). Works for both job videos and archived library videos —
callers just hand it a video file path and a note list already shifted into
that video's timeline (srcStartSec baked in by the caller, same as the
player does before applying videoSyncMs).

Sign convention matches videoMidiPlayer.js: noteTime = onset + syncSec, so
a positive offsetMs here means "delay the MIDI" (video's audio arrived
later than the transcribed onset), matching what setSyncMs expects.
"""

import os
import subprocess

import numpy as np
import librosa
from scipy.ndimage import gaussian_filter1d

from . import pipeline

HOP_LENGTH = 512
SR = 22050
SEARCH_WINDOW_SEC = 2.5


def _extract_audio(video_path, out_wav):
    pipeline._ensure_ffmpeg(lambda stage, pct: None)
    cmd = [pipeline.FFMPEG_EXE, "-y", "-i", video_path, "-vn",
           "-ac", "1", "-ar", str(SR), out_wav]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(out_wav):
        tail = "\n".join(proc.stderr.splitlines()[-5:])
        raise RuntimeError("ffmpeg audio extract failed: " + (tail or "unknown error"))


def _note_onset_envelope(notes, hop_sec, n_frames):
    env = np.zeros(n_frames, dtype=np.float64)
    for note in notes:
        idx = int(note["onset"] / hop_sec)
        if 0 <= idx < n_frames:
            env[idx] += max(1, note.get("velocity", 64)) / 127.0
    return gaussian_filter1d(env, sigma=2)


def _dot_at_lag(a, m, lag):
    """Dot product of a vs. m shifted later by `lag` frames (lag may be negative)."""
    if lag >= 0:
        L = min(len(a) - lag, len(m))
        if L <= 0:
            return 0.0
        return float(np.dot(a[lag:lag + L], m[:L]))
    else:
        k = -lag
        L = min(len(a), len(m) - k)
        if L <= 0:
            return 0.0
        return float(np.dot(a[:L], m[k:k + L]))


def compute_offset(video_path, notes, search_window_sec=SEARCH_WINDOW_SEC):
    """Returns {"offsetMs": float, "confidenceMs": float} where confidenceMs is
    a 0..1 score (correlation peak sharpness), not a millisecond value despite
    the name suggestion in older drafts -- kept as "confidence" below."""
    if not notes:
        raise ValueError("no notes to sync against")

    tmp_wav = video_path + ".__autosync.wav"
    try:
        _extract_audio(video_path, tmp_wav)
        y, sr = librosa.load(tmp_wav, sr=SR, mono=True)
    finally:
        try:
            os.remove(tmp_wav)
        except OSError:
            pass

    hop_sec = HOP_LENGTH / sr
    audio_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    audio_max = np.max(audio_env)
    if audio_max <= 1e-9:
        raise ValueError("video audio track is silent")
    audio_env = audio_env / audio_max

    duration_sec = len(y) / sr
    n_frames = max(len(audio_env), int(duration_sec / hop_sec) + 1)
    midi_env = _note_onset_envelope(notes, hop_sec, n_frames)
    midi_max = np.max(midi_env)
    if midi_max <= 1e-9:
        raise ValueError("no note onsets in range")
    midi_env = midi_env / midi_max

    a = np.zeros(n_frames)
    a[:len(audio_env)] = audio_env

    max_lag = int(search_window_sec / hop_sec)
    lags = range(-max_lag, max_lag + 1)
    scores = np.array([_dot_at_lag(a, midi_env, lag) for lag in lags])

    best_i = int(np.argmax(scores))
    best_lag = list(lags)[best_i]
    peak = scores[best_i]
    mean = float(np.mean(scores))
    std = float(np.std(scores)) + 1e-9
    confidence = float(np.clip((peak - mean) / (std * 4), 0.0, 1.0))

    offset_ms = best_lag * hop_sec * 1000.0
    return {"offsetMs": offset_ms, "confidence": confidence}
