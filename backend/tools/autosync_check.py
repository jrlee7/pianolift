"""Synthetic accuracy check for app/auto_sync.py -- no piano, no downloads.

Builds a fake song (piano-like notes + drums + a held cello-ish drone),
muxes it into an mp4 (black video, AAC audio -- the shape of a real kept
video) shifted by a known offset, and checks both estimators recover it:

  audio: video audio vs the source wav           (job videos)
  midi : video audio vs the note list           (library / picked videos)
  midi-bg: backing-track video (piano mostly removed, 15% bleed)

Run:  backend/.venv/Scripts/python.exe backend/tools/autosync_check.py
Exits non-zero if any case misses its tolerance.
"""

import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import auto_sync, pipeline  # noqa: E402

SR = 44100
rng = np.random.default_rng(7)


def tone(pitch, dur, vel):
    f0 = 440.0 * 2 ** ((pitch - 69) / 12.0)
    t = np.arange(int(dur * SR)) / SR
    env = np.exp(-t * (1.5 + pitch / 40.0)) * (1 - np.exp(-t * 400))
    y = sum((0.6 ** k) * np.sin(2 * np.pi * f0 * (k + 1) * t)
            for k in range(6) if f0 * (k + 1) < SR / 2)
    return (vel / 127.0) * env * y


def make_song(length):
    notes = []
    t = 1.0
    while t < length - 3:
        chord = rng.choice([[60, 64, 67], [57, 60, 64], [53, 57, 60],
                            [55, 59, 62]])
        bass = int(chord[0]) - 24
        for p in list(chord) + [bass]:
            notes.append({"onset": round(t + rng.normal(0, 0.004), 4),
                          "pitch": int(p), "velocity": int(rng.integers(50, 100))})
        for k in range(1, 4):  # melody notes between chords
            notes.append({"onset": round(t + k * 0.25, 4),
                          "pitch": int(rng.integers(67, 84)),
                          "velocity": int(rng.integers(40, 90))})
        t += 1.0 + float(rng.choice([0.0, 0.25, 0.5]))
    piano = np.zeros(int(length * SR))
    for n in notes:
        i = int(n["onset"] * SR)
        y = tone(n["pitch"], 2.0, n["velocity"])
        piano[i:i + len(y)] += y[:len(piano) - i]
    other = np.zeros_like(piano)
    for b in np.arange(0.5, length - 0.5, 0.5):  # drums on the beat grid
        i = int(b * SR)
        hit = rng.normal(0, 0.3, 2000) * np.exp(-np.arange(2000) / 300.0)
        other[i:i + 2000] += hit
    tt = np.arange(len(other)) / SR  # cello-ish drone with vibrato
    other += 0.15 * np.sin(2 * np.pi * 130.8 * tt + 0.3 * np.sin(2 * np.pi * 5 * tt))
    return notes, piano, other


def mux(audio, offset_sec, path, tmp):
    """mp4 whose audio is `audio` delayed by offset_sec (negative = advanced)."""
    if offset_sec >= 0:
        a = np.concatenate([np.zeros(int(round(offset_sec * SR))), audio])
    else:
        a = audio[int(round(-offset_sec * SR)):]
    wav = os.path.join(tmp, "mux_in.wav")
    sf.write(wav, (a / (np.max(np.abs(a)) + 1e-9) * 0.8).astype(np.float32), SR)
    dur = len(a) / SR
    subprocess.run([pipeline.FFMPEG_EXE, "-y", "-v", "error",
                    "-f", "lavfi", "-i", "color=c=black:s=160x90:r=25:d=%.3f" % dur,
                    "-i", wav, "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-shortest", path],
                   check=True)


def main():
    pipeline._ensure_ffmpeg(lambda s, p: None)
    tmp = tempfile.mkdtemp(prefix="autosync_")
    length = 75.0
    notes, piano, other = make_song(length)
    mix = piano + other
    src = os.path.join(tmp, "src.wav")
    sf.write(src, (mix / np.max(np.abs(mix)) * 0.8).astype(np.float32), SR)

    cases = []
    fails = 0
    for off in (0.137, -0.042, 1.85):
        vid = os.path.join(tmp, "v_%d.mp4" % int(off * 1000))
        mux(mix, off, vid, tmp)
        r = auto_sync.align_audio(vid, src)
        cases.append(("audio", off, r, 2.0))
        r = auto_sync.align_midi(vid, notes, search_sec=3.0)
        cases.append(("midi", off, r, 8.0))
    bg = other + 0.15 * piano
    vid = os.path.join(tmp, "v_bg.mp4")
    mux(bg, 0.212, vid, tmp)
    nopiano = os.path.join(tmp, "no_piano.wav")
    sf.write(nopiano, (other / np.max(np.abs(other)) * 0.8).astype(np.float32), SR)
    cases.append(("audio-bg", 0.212, auto_sync.align_audio(vid, nopiano), 2.0))
    cases.append(("midi-bg", 0.212, auto_sync.align_midi(vid, notes, 3.0), 15.0))
    vid = os.path.join(tmp, "v_far.mp4")
    mux(mix, 6.4, vid, tmp)
    cases.append(("midi-wide", 6.4, auto_sync.align_midi(vid, notes, 20.0), 8.0))

    for name, off, r, tol in cases:
        err = r["offsetMs"] - off * 1000.0
        ok = abs(err) <= tol
        fails += 0 if ok else 1
        print("%-10s want %+8.1f ms  got %+8.1f  err %+6.1f  conf %.2f  %s"
              % (name, off * 1000, r["offsetMs"], err, r["confidence"],
                 "ok" if ok else "MISS (tol %g)" % tol))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
