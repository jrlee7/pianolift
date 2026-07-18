"""Regression check for note_verify against the Sweet Hour of Prayer benchmark.

Loads the frozen raw ByteDance+Transkun outputs for a 60s reverb-heavy hymn
clip (no model re-run needed), runs the REAL note_verify.refine(), and pins
the outcome against the video-extracted ground truth
(C:\\Users\\justi\\pianolift_bench\\sweethour\\video_truth.json — see
tools/extract_video_truth.py; the source video's lit-key rendering is the
arranger's actual note list, frame-accurate at 24fps).

History (why these pins):
  * v0.1.4 (2026-07-15): an envelope-rise "rescue" for gate kills shipped
    and was reverted next day — it rescued exactly the fake re-strikes in
    held measures. Do not reintroduce (see RESTRIKE_RISE_MIN comment).
  * 2026-07-17: ground truth extracted from the source video itself
    exposed the remaining failure class: BD-only notes with no attack
    surviving via pitch-agnostic broadband onset support (31 kept fakes,
    0 missed real notes). BD_ONLY_RISE_MIN + the strict BD-only micro rule
    fixed it: P 0.875 -> 0.982, R stays 1.000, F1 0.933 -> 0.991.
    (The previously-pinned counts kept=248 / median-dur checks were
    replaced by direct truth-scored pins below. NOTE: an earlier
    "truth.mid" downloaded alongside the source video scored F1 0.741
    against the video — it is itself an audio transcription with fake
    re-strikes, NOT ground truth; never validate against it.)

Run: backend/.venv/Scripts/python.exe backend/tools/accuracy_check.py
"""
import json
import sys
from pathlib import Path

BENCH_DIR = Path(r"C:\Users\justi\pianolift_bench\sweethour")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import note_verify as nv       # noqa: E402
from score_vs_video import (            # noqa: E402
    estimate_offset, match, prf, CROP_SEC)


def main():
    raw = json.loads((BENCH_DIR / "raw60.json").read_text())
    truth = json.loads((BENCH_DIR / "video_truth.json").read_text())["notes"]
    truth = [t for t in truth if t["onset"] <= CROP_SEC]

    kept, _pedals, stats = nv.refine(
        str(BENCH_DIR / "crop60.wav"), raw["bd"], raw["bd_ped"],
        progress_cb=lambda *a: None,
        alt_notes=raw["tk"], alt_pedals=raw["tk_ped"], alt_evidence_only=False)

    offset = estimate_offset(truth, kept)
    pairs, un_t, un_e = match(truth, kept, offset)
    p, r, f1 = prf(len(pairs), len(un_t), len(un_e))

    failures = []

    # Recall is sacred: the pipeline currently plays EVERY real note in the
    # clip. Any change that loses one is a regression, full stop.
    if len(un_t) > 0:
        failures.append(f"{len(un_t)} real (video-verified) notes missed; "
                        "recall must stay 1.000")

    # Precision floor: at most 6 kept fakes in the 60s clip (current: 4).
    if len(un_e) > 6:
        failures.append(f"{len(un_e)} kept hallucinations > 6 allowed")

    if f1 < 0.985:
        failures.append(f"F1 {f1:.3f} < 0.985")

    # Known fake re-strikes inside the score's held (tied whole-note)
    # measures — confirmed fake by BOTH the user's Disklavier listening
    # test (v0.1.4 postmortem) and the video (continuous bars, no
    # re-strike). None may ever be kept again.
    known_bad = [(84, 9.180), (79, 9.995), (76, 10.723), (77, 27.009)]
    for pitch, onset in known_bad:
        if any(k["pitch"] == pitch and abs(k["onset"] - onset) < 0.02
               for k in kept):
            failures.append(
                f"hold-measure re-strike p{pitch}@{onset}s kept — the gate "
                "must kill it (see RESTRIKE_RISE_MIN comment in note_verify)")

    print(f"kept={len(kept)} TP={len(pairs)} FN={len(un_t)} FP={len(un_e)} "
          f"P={p:.3f} R={r:.3f} F1={f1:.3f} "
          f"(ghosts={stats['ghosts']} restrikes={stats['restrikes']})")

    if failures:
        print("FAIL:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)

    print("PASS")


if __name__ == "__main__":
    main()
