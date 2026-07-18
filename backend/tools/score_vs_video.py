"""Score note lists against the video-extracted ground truth
(video_truth.json, see extract_video_truth.py) for the Sweet Hour bench.

Compares four estimates against the video truth for the first 60s:
  1. raw ByteDance alone
  2. BD+Transkun merged, no verification gates
  3. the current full pipeline (note_verify.refine)
  4. the downloaded "truth.mid" (proves it's a transcription, not a source)

For the full pipeline, every false negative is attributed to the stage
that caused it (model never saw it / micro rule / ghost rule / re-strike
gate), and every false positive to its evidence class — that attribution
is the actual "why is the app wrong" answer.

Matching: one-to-one, same pitch, onset within MATCH_WINDOW after
compensating a measured global video-render lag (lit-key rendering trails
the audio by a roughly constant ~70ms, estimated per run as the median
same-pitch onset delta). Durations are reported but not scored: video
durations are key-down times while app offsets model sound-end — under
pedal both produce the same audible result.

Run: backend/.venv/Scripts/python.exe backend/tools/score_vs_video.py
"""
import json
import sys
from pathlib import Path

BENCH_DIR = Path(r"C:\Users\justi\pianolift_bench\sweethour")
MATCH_WINDOW = 0.12
CROP_SEC = 60.0

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import note_verify as nv       # noqa: E402
from app import midi_writer             # noqa: E402


def estimate_offset(truth, est):
    """Median est-minus-truth onset delta over same-pitch pairs within 0.3s."""
    deltas = []
    for t in truth:
        best = None
        for e in est:
            if e["pitch"] != t["pitch"]:
                continue
            d = e["onset"] - t["onset"]
            if abs(d) <= 0.3 and (best is None or abs(d) < abs(best)):
                best = d
        if best is not None:
            deltas.append(best)
    if not deltas:
        return 0.0
    deltas.sort()
    return deltas[len(deltas) // 2]


def match(truth, est, offset):
    """Greedy one-to-one matching by (pitch, onset proximity).
    Returns (pairs, unmatched_truth, unmatched_est)."""
    candidates = []
    for ti, t in enumerate(truth):
        for ei, e in enumerate(est):
            if e["pitch"] != t["pitch"]:
                continue
            d = abs((e["onset"] - offset) - t["onset"])
            if d <= MATCH_WINDOW:
                candidates.append((d, ti, ei))
    candidates.sort()
    used_t, used_e = set(), set()
    pairs = []
    for d, ti, ei in candidates:
        if ti in used_t or ei in used_e:
            continue
        used_t.add(ti)
        used_e.add(ei)
        pairs.append((ti, ei))
    un_t = [i for i in range(len(truth)) if i not in used_t]
    un_e = [i for i in range(len(est)) if i not in used_e]
    return pairs, un_t, un_e


def prf(n_pairs, n_fn, n_fp):
    p = n_pairs / (n_pairs + n_fp) if (n_pairs + n_fp) else 0.0
    r = n_pairs / (n_pairs + n_fn) if (n_pairs + n_fn) else 0.0
    f = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f


def report(name, truth, est):
    offset = estimate_offset(truth, est)
    pairs, un_t, un_e = match(truth, est, offset)
    p, r, f = prf(len(pairs), len(un_t), len(un_e))
    print(f"{name}: n={len(est)} offset={offset * 1000:+.0f}ms "
          f"TP={len(pairs)} FN={len(un_t)} FP={len(un_e)} "
          f"P={p:.3f} R={r:.3f} F1={f:.3f}")
    return offset, pairs, un_t, un_e


def run_pipeline_instrumented(raw, crop_wav):
    """Replicate refine()'s note path (keep in sync with note_verify.refine),
    recording each note's fate."""
    notes, evidence = nv._merge_alt(raw["bd"], raw["tk"], evidence_only=False)
    mag, onset_times = nv._cqt_mag(crop_wav)
    feats = nv._note_features(mag, notes)
    kept, killed = [], []   # killed: (note, reason)
    for i, (n, (score, rise, env, f0, f1)) in enumerate(zip(notes, feats)):
        bd_only = evidence[i] == "bd"
        micro = n["offset"] - n["onset"] < nv.MICRO_DUR_SEC
        if micro and (score < nv.MICRO_SCORE_MAX or bd_only):
            killed.append((n, "micro"))
            continue
        protected = evidence[i] == "both"
        if not protected and score < nv.UNCONF_SCORE_MAX and rise < nv.UNCONF_RISE_MAX:
            killed.append((n, "ghost"))
            continue
        rise_min = nv.BD_ONLY_RISE_MIN if bd_only else nv.RESTRIKE_RISE_MIN
        if not protected and rise < rise_min:
            if bd_only or not nv._onset_supported(onset_times, n["onset"],
                                                  nv.ONSET_SUPPORT_WINDOW_SEC):
                killed.append((n, "restrike_gate"))
                continue
        new_off = nv._trim_offset(env, n, f0, f1)
        if new_off < n["offset"]:
            n = dict(n, offset=new_off)
        kept.append(n)
    return kept, killed


def main():
    truth = json.loads((BENCH_DIR / "video_truth.json").read_text())["notes"]
    truth = [t for t in truth if t["onset"] <= CROP_SEC]
    raw = json.loads((BENCH_DIR / "raw60.json").read_text())
    crop_wav = str(BENCH_DIR / "crop60.wav")

    print(f"video truth: {len(truth)} notes in first {CROP_SEC:.0f}s\n")

    report("raw BD alone      ", truth, raw["bd"])
    merged, _ = nv._merge_alt(raw["bd"], raw["tk"], evidence_only=False)
    report("BD+TK merged      ", truth, merged)

    kept, killed = run_pipeline_instrumented(raw, crop_wav)
    offset, pairs, un_t, un_e = report("current pipeline  ", truth, kept)

    tm = BENCH_DIR / "truth.mid"
    if tm.exists():
        mid_notes, _ = midi_writer.read_midi(str(tm))
        mid_notes = [n for n in mid_notes if n["onset"] <= CROP_SEC + 2]
        report("downloaded MIDI   ", truth, mid_notes)

    # ---- attribution for the current pipeline's errors ----
    print("\n--- current pipeline FN attribution "
          "(truth notes the app failed to play) ---")
    fn_buckets = {}
    fn_detail = []
    for ti in un_t:
        t = truth[ti]
        cause = "model_never_saw"
        for n, reason in killed:
            if (n["pitch"] == t["pitch"]
                    and abs((n["onset"] - offset) - t["onset"]) <= MATCH_WINDOW):
                cause = "killed_" + reason
                break
        fn_buckets[cause] = fn_buckets.get(cause, 0) + 1
        fn_detail.append((t, cause))
    for k, v in sorted(fn_buckets.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")
    print("  detail:")
    for t, cause in fn_detail:
        print(f"    t={t['onset']:.2f} p={t['pitch']} "
              f"dur={t['offset'] - t['onset']:.2f}  {cause}")

    print("\n--- current pipeline FP detail "
          "(kept notes the video says were never played) ---")
    for ei in un_e:
        e = kept[ei]
        print(f"    t={e['onset']:.2f} p={e['pitch']} vel={e['velocity']} "
              f"dur={e['offset'] - e['onset']:.2f}")

    # ---- how many of the gate's kills were CORRECT per the video? ----
    print("\n--- gate-kill audit vs video truth ---")
    audit = {}
    for n, reason in killed:
        real = any(t["pitch"] == n["pitch"]
                   and abs((n["onset"] - offset) - t["onset"]) <= MATCH_WINDOW
                   for t in truth)
        key = (reason, "killed_REAL_note" if real else "killed_fake_ok")
        audit[key] = audit.get(key, 0) + 1
    for (reason, verdict), v in sorted(audit.items()):
        print(f"  {reason} -> {verdict}: {v}")


if __name__ == "__main__":
    main()
