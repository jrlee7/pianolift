# Note accuracy plan — wav → notes, end to end (2026-07-17)

> **RESOLVED (2026-07-17, later the same day).** The definitive ground
> truth turned out to be the source video itself (Synthesia-style lit-key
> rendering) — extracted frame-by-frame by `tools/extract_video_truth.py`
> into `pianolift_bench/sweethour/video_truth.json`. Measured against it
> (`tools/score_vs_video.py`):
>
> * The pipeline missed **zero** real notes (recall 1.000) — the
>   "gate kills real notes" hypothesis below was an artifact of scoring
>   against a downloaded `truth.mid` that is itself an audio transcription
>   (it scores F1 0.741 vs the video — full of fake re-strikes; never
>   validate against it).
> * The real defect: **31 kept hallucinations**, all ByteDance-only notes
>   with no attack of their own, surviving via pitch-agnostic broadband
>   onset support (a ringing tail "re-heard" at the moment a different
>   chord lands). Transkun alone scored P=1.000/R=0.986.
> * Fix shipped in `note_verify.py`: `BD_ONLY_RISE_MIN = 2.5` (BD-only
>   notes need their own clear attack; onset support can't rescue them)
>   plus an unconditional BD-only micro-note kill.
>   **P 0.875 → 0.982, R 1.000, F1 0.933 → 0.991.**
> * `tools/accuracy_check.py` now pins recall=1.000 / FP≤6 / F1≥0.985
>   against the video truth, plus the four hold-measure re-strikes that
>   must always die (confirmed fake by both the Disklavier listening test
>   and the video's continuous bars).
> * Phase 1 (preview synth honors sustain pedal) also shipped — the
>   "synth sounds nothing like the preview" complaint was this playback
>   gap plus the 31 fakes, not missing notes.
>
> Remaining ideas below (score-guided mode, onset-detector upgrade) stay
> valid as future work but are no longer the priority — blind-mode F1 on
> the bench is 0.991.

Goal stated by the user: 100% note accuracy on material like *Sweet Hour of
Prayer* (slow hymn, held/tied chords, heavy pedal). This plan maps the whole
pipeline, names where accuracy is lost, and sequences fixes. It is written to
be executed by a smaller model; every step has a file anchor and a measurable
acceptance test.

## Honest ceiling, and how to actually reach ~100%

Blind audio→MIDI transcription cannot promise 100%: the primary model's own
published note F1 is 96.8% on *clean, unseparated* MAESTRO audio, and our
input is a separated stem with bleed and reverb. Every gate we've built
(ghosts, re-strikes, offsets) is spent recovering from that gap, and the
v0.1.4→v0.1.5 history proves the gates trade one error class for another.

The only honest path to ~100% **note** accuracy is to stop guessing notes
from audio when the notes are already known: **score-guided mode** (Phase 3).
This app now contains an OMR/MusicXML ingestion pipeline (Sheet tab,
`backend/app/sheet_pipeline.py`) — for hymns the user owns sheet music for
(e.g. musicnotes MK0066954, already used to verify v0.1.5), the score IS the
note ground truth. Audio then supplies only what the score doesn't: timing,
velocities, pedal. Note accuracy becomes exact by construction; the audio
alignment only affects *when*, never *which*.

## What exists today (map)

```
input audio
  └─ separate_piano()            pipeline.py:75    BS-Roformer-SW → piano stem + no_piano
  └─ transcribe()                pipeline.py:311   ByteDance CRNN (primary) + Transkun V2 (witness)
       └─ _peak_normalize()      pipeline.py:296   stem lifted to -0.4 dBFS
  └─ note_verify.refine()        note_verify.py:378
       ├─ _merge_alt()           two-engine merge; TK velocity adopted, TK offsets NOT (fix A, stands)
       ├─ micro-note rule        <30ms + low score → dead
       ├─ ghost rule             score+rise thresholds, protected if both engines or mix confirm
       ├─ re-strike gate         no rise AND no broadband onset support → dead (v0.1.5 state:
       │                         no envelope-rise rescue — see postmortem in ACCURACY_FIX_PLAN.md)
       ├─ _trim_offset()         offset pulled back to 20% of span peak
       ├─ dedupe / declash
       └─ _refine_pedals()       pedal segments verified/merged
  └─ events.json → midi_writer (CC64 pedal included) → Disklavier / exports
  └─ previewSynth.js (frontend)  ← **ignores pedal entirely** ← tonight's complaint
```

## Diagnosis of tonight's symptom (synth ≠ stem preview on held notes)

The v0.1.5 note list was verified against the published score on the real
piano (accuracy_check.py pins it: kept=248, restrikes≥110, median dur
≥0.40s, four named hold-measure fakes must die). The extraction is not what
regressed tonight.

`previewSynth.js:synthNote()` computes duration as `note.offset - release`
(capped). It never reads the pedal list. On pedaled material, key-release
offsets are short (a repeated chord under pedal holds the key ~0.45s) while
the *sound* rings until pedal-up — the stem recording and the Disklavier
both sustain; the synth chops. The comparison the user made (synth vs stem
audio) is dominated by this, not by wrong notes.

**Corollary check (must verify during Phase 1):** the exported MIDI and the
video-sync player DO carry CC64 (`midi_writer.write_midi(include_pedal=…)`,
`videoMidiPlayer.js`) — confirm the Disklavier path sustains correctly, so
the fix is preview-only.

## Phase 1 — Make the preview tell the truth (frontend, small)

`frontend/src/previewSynth.js`:
1. Pass the job's pedal segments into `createPreviewPlayer` / `createNotePlayer`
   (callers: `ResultView.jsx`, `PlayerView.jsx` — thread `events.pedals`).
2. In `synthNote`, compute the *sounding* end: if any pedal segment is down at
   the note's `offset`, extend the audible end to that segment's `offset`
   (pedal-up), still subject to `maxSustainSec` and `capSustain`. Key-release
   stays the MIDI truth; this is playback-only.
3. Damper behavior on re-strike: if the same pitch re-strikes before pedal-up,
   the old voice ends at the re-strike (matches a real string being re-hammered).
4. Acceptance: A/B the synth against the stem on the Sweet Hour job — held
   measures ring; no change to events.json, exports, or the Disklavier path.

Also correct the synth's misleading comment ("for judging sync and dynamics")
— after this it is also for judging sustain.

## Phase 2 — Measured evaluation harness (turn pinned counts into scores)

Today `backend/tools/accuracy_check.py` pins counts for one clip. Build real
metrics so every later change is provable:

1. Encode ground truth for the Sweet Hour benchmark from the score the user
   already owns: `C:\Users\justi\pianolift_bench\sweethour\truth.json` —
   list of {pitch, onset_beat, duration_beats}, first 60s worth of measures,
   plus the song's tempo map (constant tempo is fine to start).
2. Extend accuracy_check.py to score events.json against truth:
   - note precision / recall / F1 (pitch match within ±80ms after best global
     offset+tempo fit),
   - duration: median |dur_est − dur_truth| on matched notes,
   - list every FP and FN with timestamps (the audit trail for listening).
3. Gate all later phases on: recall does not drop, F1 must rise.

## Phase 3 — Score-guided mode (the actual 100% route)

New optional input on the Convert tab: attach a score (PDF via existing
Audiveris OMR, or MusicXML directly) to an audio conversion.

1. `backend/app/score_align.py` (new):
   - Parse score → note list with beat times (reuse `musicxml_io.part_timeline`).
   - Synthesize a chroma/CQT template from score notes; DTW-align against the
     stem's CQT (librosa `dtw`, beat-synchronous features) → beat→seconds map.
   - Emit notes: **pitches/durations from the score**, onsets/offsets through
     the alignment map, velocities from the nearest transcribed note match
     (fallback: phrase-level dynamics from the audio's RMS envelope), pedal
     from the transcriber (verified as today) or from score pedal marks when
     present.
2. Wire as `run_job(..., score_path=...)`: when present, skip the ghost/
   re-strike gauntlet entirely — alignment replaces it.
3. UI: "🎼 Attach sheet music (optional — locks notes to the score)" on the
   upload zone; store which mode produced the job.
4. Acceptance: on Sweet Hour with the user's PDF, F1 vs truth.json = 1.0 by
   construction; listening test on the Disklavier confirms timing feels human
   (DTW alignment error < 50ms median against the audio).

Failure modes to design for: OMR errors (surface the Sheet tab's existing
correction/re-upload loop before alignment), repeats/verses (DTW path
constraint: allow but flag large skips), rubato (beat-synchronous DTW handles
gradual tempo; sudden fermatas need a wider step constraint).

## Phase 4 — Blind-mode accuracy raise (when no score exists)

Ranked by measured leverage, using the Phase 2 harness:

1. **Onset evidence upgrade** (biggest known deficit): the broadband detector
   found 54 onsets/60s where the score has ~100+ strikes (ACCURACY_FIX_PLAN
   diagnosis) — soft hymn strikes fall below `librosa.onset_detect` defaults.
   The re-strike gate's exemption is only as good as this detector. Try:
   superflux onset function, per-register onset bands, lower delta with median
   filtering — measured target: ≥90% of truth onsets detected on the bench
   clip with <10% spurious. Every recovered onset is a real repeated chord
   that can never be gate-killed again. Do NOT resurrect the envelope-rise
   rescue (see postmortem).
2. **Second witness weighting**: Transkun hallucinated ~1% where ByteDance hit
   43% on reverb material (note_verify.py docstring) — trial: alt-only notes
   currently join as candidates; measure making TK the *primary* note source
   on high-reverb material (pick by measured hallucination rate per job:
   fraction of BD notes failing onset support), BD demoted to witness.
3. **Model upgrade** (hFT-Transformer or kong-2024 checkpoint): largest
   dependency risk, only after 1-2 measured; keep behind the same harness.

## Explicitly do not repeat

- No envelope-rise re-strike rescue (v0.1.4 postmortem — pedal wash pulses
  held pitches upward with no hammer).
- Do not adopt Transkun offsets (fix A stands; durations collapsed).
- Do not loosen the four named hold-measure kills pinned in accuracy_check.py.

## Suggested order & sizing

| Phase | What | Size | Risk |
|-------|------|------|------|
| 1 | Synth honors pedal | small, frontend-only | none to data |
| 2 | truth.json + scored harness | small, tooling | none |
| 3 | Score-guided mode | medium-large | DTW tuning |
| 4.1 | Onset detector upgrade | medium | regression (harness gates it) |
| 4.2 | Witness weighting | small trial | measured only |
| 4.3 | Model upgrade | large | last |

Phase 1 alone should resolve what the user heard tonight. Phase 3 is what
"100% accuracy" actually means in practice.
