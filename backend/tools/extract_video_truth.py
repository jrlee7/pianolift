"""Extract ground-truth notes from a Synthesia-style falling-notes video by
tracking lit keyboard keys frame-by-frame.

Why: for the Sweet Hour of Prayer benchmark, the only trustworthy ground
truth is the source video itself — the downloaded "arrangement MIDI"
(bench truth.mid) turned out to contain rapid re-strike hallucinations that
the video's continuous note bars disprove (it is itself an audio
transcription, not the video's source MIDI). The video's lit keys ARE the
arranger's actual notes, frame-accurate at 24fps (~42ms).

Input: a directory of keyboard-strip PNGs extracted with ffmpeg, e.g.
    ffmpeg -i video.mp4 -t 62 -vf "crop=1280:170:0:452" kb_strip/f_%05d.png
(crop numbers are for THIS video's 720p layout: full-width 88-key keyboard
whose strip spans y=452..622 in the frame.)

Output: video_truth.json in the bench dir — {"notes": [{onset, offset,
pitch}, ...]} on the video/audio timeline.

Calibration facts (verified by hand on frame 222, t=9.2s, a known
[60,67,72,76,79,84] chord, plus a C1 bass note at t~4.1-4.9 and the
repeated-chord passage at 6.0-7.5s):
  * 52 white keys span the full 1280px width (24.615 px/key), A0 leftmost.
  * Sample white keys at y=140 (low on the key face, uniformly clear of the
    black keys): every lit key reads ~252 there; unlit reads ~57. y=110 is
    NOT reliable — the lit rendering narrows between black keys, so values
    wander 226-254 with the key's position in the octave and a fixed
    threshold drops real notes.
  * Keys go fully dark between re-strikes (57 vs 246 measured across the
    repeated-chord passage) — no flash-decay handling needed; simple
    thresholding per frame is exact.
  * Black keys occupy the strip's upper half; a lit black key brightens its
    own x-zone at y=30; unlit black keys read near-black (<40).

Run: backend/.venv/Scripts/python.exe backend/tools/extract_video_truth.py <strip_dir>
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

BENCH_DIR = Path(r"C:\Users\justi\pianolift_bench\sweethour")
FPS = 24.0
N_WHITE = 52
STRIP_W = 1280
KEY_W = STRIP_W / N_WHITE

WHITE_Y = 140         # row through white-key lower body (clear of black keys)
BLACK_Y = 30          # row through black-key body
WHITE_LIT_THRESH = 150  # lit ~252, unlit ~57 — huge margin either side
BLACK_LIT_THRESH = 180  # higher: white-key glow bleeds a little at y=30
SAMPLE_HALF_W = 3     # +/- px around each key's sample x
MIN_FRAMES = 2        # a key lit for fewer frames is flicker, not a note

_SEMIS = [0, 2, 4, 5, 7, 9, 11]  # C D E F G A B offsets within an octave


def white_index_to_pitch(w):
    """White key index (0 = A0 leftmost) -> MIDI pitch."""
    if w == 0:
        return 21   # A0
    if w == 1:
        return 23   # B0
    k = w - 2
    octave = k // 7 + 1
    return 12 * octave + 12 + _SEMIS[k % 7]


def build_key_samples():
    """[(pitch, x_center, y, thresh)] for all 88 keys."""
    samples = []
    for w in range(N_WHITE):
        pitch = white_index_to_pitch(w)
        x = (w + 0.5) * KEY_W
        samples.append((pitch, x, WHITE_Y, WHITE_LIT_THRESH))
        # A black key sits at this white key's right boundary when the white
        # note has a sharp (C, D, F, G, A) and we're not at the top of the
        # keyboard.
        letter_semitone = pitch % 12
        if letter_semitone in (0, 2, 5, 7, 9) and pitch + 1 <= 108:
            bx = (w + 1) * KEY_W
            samples.append((pitch + 1, bx, BLACK_Y, BLACK_LIT_THRESH))
    return samples


def lit_keys(img_arr, samples):
    """Set of MIDI pitches lit in one keyboard-strip frame."""
    out = set()
    for pitch, x, y, thresh in samples:
        x0 = max(0, int(round(x)) - SAMPLE_HALF_W)
        x1 = min(img_arr.shape[1], int(round(x)) + SAMPLE_HALF_W + 1)
        patch = img_arr[y, x0:x1, :]
        if float(patch.mean()) > thresh:
            out.add(pitch)
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: extract_video_truth.py <keyboard-strip-png-dir>")
        sys.exit(1)
    strip_dir = Path(sys.argv[1])
    frames = sorted(strip_dir.glob("f_*.png"))
    if not frames:
        print("no f_*.png frames in", strip_dir)
        sys.exit(1)
    print(f"{len(frames)} frames at {FPS}fps "
          f"({len(frames) / FPS:.1f}s of video)")

    samples = build_key_samples()

    # active[pitch] = first_frame_index while lit
    active = {}
    notes = []
    lit_counts = []
    for i, fp in enumerate(frames):
        arr = np.asarray(Image.open(fp).convert("RGB"), dtype=np.float32)
        lit = lit_keys(arr, samples)
        lit_counts.append(len(lit))
        for p in lit:
            if p not in active:
                active[p] = i
        for p in [p for p in active if p not in lit]:
            start = active.pop(p)
            if i - start >= MIN_FRAMES:
                notes.append({
                    "onset": round(start / FPS, 4),
                    "offset": round(i / FPS, 4),
                    "pitch": p,
                })
    n_frames = len(frames)
    for p, start in active.items():
        if n_frames - start >= MIN_FRAMES:
            notes.append({
                "onset": round(start / FPS, 4),
                "offset": round(n_frames / FPS, 4),
                "pitch": p,
            })
    notes.sort(key=lambda n: (n["onset"], n["pitch"]))

    out = BENCH_DIR / "video_truth.json"
    out.write_text(json.dumps({"notes": notes}, indent=1))
    durs = [n["offset"] - n["onset"] for n in notes]
    print(f"extracted {len(notes)} notes -> {out}")
    print(f"median duration {sorted(durs)[len(durs)//2]:.3f}s, "
          f"max simultaneous lit {max(lit_counts)}")
    print("first 12 notes:")
    for n in notes[:12]:
        print(f"  t={n['onset']:.3f}  p={n['pitch']}  "
              f"dur={n['offset'] - n['onset']:.3f}")


if __name__ == "__main__":
    main()
