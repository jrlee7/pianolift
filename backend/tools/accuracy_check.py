"""Regression check for note_verify against the Sweet Hour of Prayer benchmark.

Loads the frozen raw ByteDance+Transkun outputs for a 60s reverb-heavy hymn
clip (no model re-run needed) and drives them through the real functions
(_merge_alt, _cqt_mag, _note_features, the re-strike gate, _trim_offset) --
the same logic refine() runs, but inlined so this script can also capture
gate-killed notes' velocities, which refine()'s stats dict doesn't expose.

Run: backend/.venv/Scripts/python.exe backend/tools/accuracy_check.py
"""
import json
import statistics
import sys
from pathlib import Path

BENCH_DIR = Path(r"C:\Users\justi\pianolift_bench\sweethour")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import note_verify as nv  # noqa: E402


def main():
    raw = json.loads((BENCH_DIR / "raw60.json").read_text())
    crop_wav = str(BENCH_DIR / "crop60.wav")

    notes, evidence = nv._merge_alt(raw["bd"], raw["tk"], evidence_only=False)

    mag, onset_times = nv._cqt_mag(crop_wav)
    feats = nv._note_features(mag, notes)

    kept = []
    gate_killed_velocities = []
    restrikes = 0
    for i, (n, (score, rise, env, f0, f1)) in enumerate(zip(notes, feats)):
        if (n["offset"] - n["onset"] < nv.MICRO_DUR_SEC
                and score < nv.MICRO_SCORE_MAX):
            continue
        protected = evidence[i] == "both"
        if protected:
            is_ghost = False
        else:
            is_ghost = score < nv.UNCONF_SCORE_MAX and rise < nv.UNCONF_RISE_MAX
        if is_ghost:
            continue
        if (not protected and rise < nv.RESTRIKE_RISE_MIN
                and not nv._onset_supported(onset_times, n["onset"],
                                            nv.ONSET_SUPPORT_WINDOW_SEC)):
            restrikes += 1
            gate_killed_velocities.append(n["velocity"])
            continue
        new_off = nv._trim_offset(env, n, f0, f1)
        if new_off < n["offset"]:
            n = dict(n, offset=new_off)
        kept.append(n)

    failures = []

    # 386 merged; the gate must keep killing the hold-measure re-strikes
    # (verified against the published score: held tied chords in measures
    # 2/4/... must NOT re-strike) while keeping the real 0.45s-grid
    # repeated chords (measures 1/3/... — protected by onset support).
    n_kept = len(kept)
    if not (240 <= n_kept <= 260):
        failures.append(f"kept notes {n_kept} not in [240, 260]")

    durations = [n["offset"] - n["onset"] for n in kept]
    median_dur = statistics.median(durations) if durations else 0.0
    if median_dur < 0.40:
        failures.append(f"median kept duration {median_dur:.3f}s < 0.40s")

    kept_onsets = sorted(n["onset"] for n in kept)
    for t in onset_times:
        if not nv._onset_supported(kept_onsets, t, 0.08):
            failures.append(f"broadband onset at {t:.3f}s has no kept note within 80ms")
            break

    if restrikes < 110:
        failures.append(f"gate killed only {restrikes} notes, expected >= 110")

    gate_vel_median = (statistics.median(gate_killed_velocities)
                        if gate_killed_velocities else 0.0)
    if gate_vel_median >= 45:
        failures.append(
            f"gate-killed velocity median {gate_vel_median:.1f} >= 45 "
            "(gate is no longer killing only quiet tails)")

    # Known fake re-strikes inside the score's held (tied whole-note)
    # measures — heard as extra notes on the Disklavier when a 2026-07-15
    # gate change wrongly rescued them. None may ever be kept again.
    known_bad = [(84, 9.180), (79, 9.995), (76, 10.723), (77, 27.009)]
    for pitch, onset in known_bad:
        if any(k["pitch"] == pitch and abs(k["onset"] - onset) < 0.02
               for k in kept):
            failures.append(
                f"hold-measure re-strike p{pitch}@{onset}s kept — the gate "
                "must kill it (see RESTRIKE_RISE_MIN comment in note_verify)")

    print(f"merged={len(notes)} kept={n_kept} median_dur={median_dur:.3f}s "
          f"restrikes={restrikes} gate_kill_vel_median={gate_vel_median:.1f}")

    if failures:
        print("FAIL:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)

    print("PASS")


if __name__ == "__main__":
    main()
