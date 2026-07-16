# Accuracy fix plan — note extraction (Sweet Hour of Prayer failure)

Executable plan for the next session. Every change is measured, mechanical,
and validated by a script with hard acceptance numbers. Base branch: current
`master` at `d99136a` (contains the Google OAuth fix — do NOT revert or touch
`frontend/main.js` OAuth code, and do not rebase away `d99136a`).

## Diagnosis (measured 2026-07-15 on job 5fc705e0955a, piano-only, reverb-heavy hymn)

Job result: 2386 raw notes → 1157 deleted → 1229 kept, median duration 0.166s
in the first 30s. A slow hymn should have ~0.4–2s notes. Two causes, both in
`backend/app/note_verify.py`:

1. **Re-strike gate over-kills repeated chords** (31% of all notes on the 60s
   test clip — 120 of 386). Hymns repeat the same chord; with reverb the
   attack is soft, so `rise < RESTRIKE_RISE_MIN` and librosa's broadband
   onset detector (54 onsets/60s vs ~100+ real strike moments) finds no
   support → real repeated chords die. Of the 120 killed, 35 show local
   pitch-bin energy RISING through the onset (d ≥ 1.05) — physically a hammer
   strike, wrongly killed. The other 85 show decay (d median 0.93, velocity
   median 30) — true hallucinated tails, correctly killed.

2. **Transkun offsets collapse durations.** `_merge_alt` adopts Transkun's
   offset for two-engine notes. On reverb material Transkun's key-release
   regression fires far too early: agreed-pair median duration TK 0.218s vs
   ByteDance 0.455s vs ByteDance+envelope-trim 0.425s. The envelope trim
   (`_trim_offset`) already bounds over-long BD offsets, so adopting TK's
   offset only destroys; keep adopting TK's *velocity* only.

Not causes (checked): tuning offset 4 cents (fine); zero same-pitch
duplicates; every librosa-detectable audio onset has a kept note within 80ms;
UNCONF spectral bar killed only 13/386 (leave it alone).

## Fix A — stop adopting Transkun offsets (`note_verify.py::_merge_alt`)

In the matched branch of `_merge_alt` (the `evidence.append("both")` path),
delete the offset adoption line so only velocity is taken:

```python
        out = dict(n)
        if not evidence_only:
            out["velocity"] = a["velocity"]
```

(currently it also sets `out["offset"] = round(max(a["offset"], n["onset"] +
MIN_NOTE_SEC), 4)` — remove exactly that.) Update `_merge_alt`'s docstring
sentence claiming Transkun offsets are adopted. `_trim_offset` still bounds
long BD offsets against the spectral envelope — that is now the only offset
shaping.

## Fix B — re-strike gate needs decay evidence (`note_verify.py`)

A hallucinated re-strike is the tail of a ringing note: pitch-bin energy can
only DECAY through the claimed onset. A real repeated strike adds energy.
Gate must require decay before killing.

1. Add constant next to `RESTRIKE_RISE_MIN`:

```python
# A real hammer strike adds energy: the pitch envelope rises through the
# onset. A hallucinated re-strike is the decaying tail of the previous
# note — energy through its claimed onset can only fall. Only kill when
# the local envelope is NOT rising (post/pre below this ratio). Measured
# on a reverb hymn: true tails median 0.93, real strikes median 4.8 —
# 1.05 rescues every repeated-chord strike and keeps killing the tails.
RESTRIKE_DECAY_MAX = 1.05
```

2. Add helper (module level):

```python
def _local_rise(env, f0):
    """Pitch-envelope energy direction through frame f0 (~±70ms)."""
    pre = env[max(0, f0 - 3):f0]
    post = env[f0 + 1:f0 + 4]
    if pre.size == 0 or post.size == 0:
        return 9.9  # edge of clip: no decay evidence, never gate-kill
    return float(post.mean() / (pre.mean() + 1e-9))
```

3. In `refine()`, extend the gate condition (the `stats["restrikes"] += 1`
   block) with the decay test:

```python
        if (not protected and rise < RESTRIKE_RISE_MIN
                and _local_rise(env, f0) < RESTRIKE_DECAY_MAX
                and not _onset_supported(onset_times, n["onset"],
                                         ONSET_SUPPORT_WINDOW_SEC)):
```

## Validation (must pass before push)

Benchmark data preserved at `C:\Users\justi\pianolift_bench\sweethour\`:
`crop60.wav` (first 60s of the piano-only stem), `raw60.json` (raw ByteDance
+ Transkun outputs for that clip — no model re-run needed), `piano.wav`
(full song), `events.json`/`job.json` (the bad shipped result).

Write `backend/tools/accuracy_check.py` that loads `raw60.json` +
`crop60.wav`, runs `note_verify.refine`-equivalent logic through the real
functions (`_merge_alt`, `_cqt_mag`, `_note_features`, gate, `_trim_offset`),
and asserts:

- kept notes ≥ 270 and ≤ 300 (of 386 merged; current broken code keeps 248)
- median kept duration ≥ 0.40s (current broken: 0.233s)
- every librosa broadband onset in the clip has a kept note within 80ms
- gate still kills ≥ 70 notes (the true hallucinated tails must keep dying;
  velocity median of gate-killed stays < 45)

Run with `backend/.venv/Scripts/python.exe`. Also run the existing synthetic
checks (velocity calibration, `_pitch_envelope`, `_refine_pedals`,
`_peak_normalize`) — they live in this plan's originating session notes; the
quickest re-check is `python -m py_compile` on all `backend/app/*.py` plus
the new tool run.

## Ship

1. Commit on top of `d99136a` (keep the OAuth fix), push `origin master`.
2. CI (`.github/workflows/build.yml`) builds backend.exe + installer on push
   to master and uploads the `PianoLift-Windows` artifact — that's the build
   the user installs. Confirm run green via `gh run watch`.
3. Tell the user to reinstall and reconvert the song (packaged jobs live in
   an ephemeral `%TEMP%\_MEIxxxxx\jobs` dir, so old jobs are gone — that's a
   known, separate packaging issue).

## Explicitly out of scope (future, separate tasks)

- Persistent jobs dir for the packaged exe (`%LOCALAPPDATA%\PianoForge\jobs`)
  — today every app restart loses history.
- Model upgrade (hFT-Transformer / newer checkpoints) — the biggest possible
  accuracy lever, but a large dependency change; only after the above ships.
- Tempo-map MIDI export, quantize-to-beat (needs hardware listen tests).
