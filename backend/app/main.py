"""PianoForge API server.

Jobs live under backend/jobs/<id>/ :
  input.mp3      uploaded audio
  separated/     BS-Roformer-SW output (piano + no_piano stems)
  events.json    transcribed notes + pedals (spectrally verified)
  output.mid     default-settings MIDI render
  job.json       persisted job metadata/status
"""

import base64
import json
import multiprocessing
import os
import queue as queue_mod
import re
import shutil
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from typing import Optional

from fastapi import (FastAPI, UploadFile, File, Form, Body, HTTPException,
                     Request)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import (pipeline, midi_writer, note_verify, eseq_writer, disk_writer,
               transkun_engine, auto_sync,
               usb, job_runner)
from . import sheet_routes, sheet_to_events
from . import musicxml_io

# A PyInstaller onefile build's __file__ resolves inside the run's temp
# extraction dir (%TEMP%\_MEIxxxxx), which is new and gets wiped every
# launch -- jobs/media stored there would vanish on every relaunch. Persist
# to a stable per-user location instead when frozen; dev mode keeps the
# repo-relative path so `git status` shows local test jobs as usual.
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", "."), "PianoForge", "data")
    os.makedirs(BASE_DIR, exist_ok=True)
else:
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOBS_DIR = os.path.join(BASE_DIR, "jobs")
os.makedirs(JOBS_DIR, exist_ok=True)
# Videos outlive their conversion job here (too big for the cloud library):
# "Move to library" relocates a job's kept video into this folder and the
# Firebase song doc records only the filename.
MEDIA_DIR = os.path.join(BASE_DIR, "media")
os.makedirs(MEDIA_DIR, exist_ok=True)

app = FastAPI(title="PianoForge")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(sheet_routes.router)

# One worker: the models are heavy and CPU-bound; queue jobs serially.
executor = ThreadPoolExecutor(max_workers=1)
jobs_lock = threading.Lock()
jobs = {}
# job_id -> Future, so a still-queued job can be cancelled before it runs.
futures = {}
# job_id -> the child Process running the conversion, so an in-flight job can
# be terminated. job_ids in `cancelled` have a pending cancel request; the
# worker thread that owns the job deletes its temp dir once it observes this.
procs = {}
cancelled = set()


def _job_dir(job_id):
    return os.path.join(JOBS_DIR, job_id)


def _persist(job_id):
    job = jobs.get(job_id)
    if job is None:
        return
    with open(os.path.join(_job_dir(job_id), "job.json"), "w") as f:
        json.dump(job, f)


def _load_jobs_from_disk():
    for entry in os.listdir(JOBS_DIR):
        meta_path = os.path.join(JOBS_DIR, entry, "job.json")
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    job = json.load(f)
            except (ValueError, OSError):
                continue
            # A job that was mid-processing when the server died is dead.
            if job.get("status") == "processing":
                job["status"] = "error"
                job["error"] = "Server restarted during processing. Re-upload."
            # Jobs from before creation-time tracking: job.json's mtime keeps
            # the sort stable across restarts. Persisted on the next rewrite.
            if "createdAt" not in job:
                job["createdAt"] = os.path.getmtime(meta_path)
            jobs[entry] = job


def _cleanup_leftover_stems():
    """One-time sweep for jobs converted before the pipeline deleted the
    separator's 5 individual accompaniment stems (~250MB of dead wavs per
    job). Keep the piano stem + no_piano.wav, drop the rest. Only touches
    finished jobs with a known piano stem, so an in-flight conversion on a
    second server sharing this jobs dir can't lose files mid-run."""
    for job_id, job in jobs.items():
        if job.get("status") != "done" or not job.get("pianoStem"):
            continue
        sep_dir = os.path.join(_job_dir(job_id), "separated")
        if not os.path.isdir(sep_dir):
            continue
        keep = {"no_piano.wav", os.path.basename(job["pianoStem"])}
        for f in os.listdir(sep_dir):
            if f.lower().endswith(".wav") and f not in keep:
                try:
                    os.remove(os.path.join(sep_dir, f))
                except OSError:
                    pass


_load_jobs_from_disk()
_cleanup_leftover_stems()


def _input_path(job_id):
    """Absolute path of a job's source audio. Older jobs predate the
    inputFile field and always used input.mp3."""
    job = jobs.get(job_id) or {}
    return os.path.join(_job_dir(job_id), job.get("inputFile") or "input.mp3")


def _safe_name(title):
    """Make a video title safe to use as a job/file name."""
    out = []
    for ch in title:
        out.append("_" if ch in '<>:"/\\|?*' else ch)
    name = "".join(out).strip()
    return name[:120] or "untitled"


def _process(job_id, kind, source, piano_only=False, include_video=False,
             section=None, track_name=None):
    """Worker-thread body: run the conversion in a killable child process and
    relay its progress/result into the in-memory job. `kind` is 'file' (source
    is an audio path) or 'url' (source is a link the child downloads first).
    include_video keeps the URL download's video for the Play tab.
    section/track_name: album-split job (download only that chapter's
    seconds range, use the chapter title instead of the video's)."""
    job_dir = _job_dir(job_id)
    ctx = multiprocessing.get_context("spawn")
    q = ctx.Queue()
    proc = ctx.Process(
        target=job_runner.run_job_process,
        args=(job_dir, kind, source, piano_only, q, include_video, section,
              track_name))

    with jobs_lock:
        if job_id in cancelled:
            # Cancelled while still queued: never launch the child.
            cancelled.discard(job_id)
            futures.pop(job_id, None)
            jobs.pop(job_id, None)
            shutil.rmtree(job_dir, ignore_errors=True)
            return
        procs[job_id] = proc
    proc.start()
    # Close the window where a cancel landed between the lock release and start.
    with jobs_lock:
        abort = job_id in cancelled
    if abort:
        proc.terminate()

    outcome = None  # ("done", result) or ("error", msg)
    while True:
        try:
            msg = q.get(timeout=0.5)
        except queue_mod.Empty:
            if not proc.is_alive():
                break
            continue
        tag = msg[0]
        if tag == "progress":
            with jobs_lock:
                job = jobs.get(job_id)
                if job is not None:
                    job["stage"] = msg[1]
                    job["progress"] = msg[2]
            continue
        if tag == "meta":  # resolved input filename (+ title for URL jobs)
            with jobs_lock:
                job = jobs.get(job_id)
                if job is not None:
                    job["inputFile"] = msg[1]
                    if msg[2]:  # None = file job re-decoded, keep its name
                        job["name"] = _safe_name(msg[2])
                    if len(msg) > 3 and msg[3]:  # kept video for the Play tab
                        job["videoFile"] = msg[3]
                    _persist(job_id)
            continue
        outcome = msg
        break

    proc.join()
    with jobs_lock:
        procs.pop(job_id, None)
        futures.pop(job_id, None)
        if job_id in cancelled:
            # Cancelled mid-flight: drop the job and its temp files entirely.
            cancelled.discard(job_id)
            jobs.pop(job_id, None)
            shutil.rmtree(job_dir, ignore_errors=True)
            return
        job = jobs.get(job_id)
        if job is None:
            return
        if outcome is None:
            job["status"] = "error"
            job["error"] = "Conversion process exited unexpectedly."
        elif outcome[0] == "done":
            result = outcome[1]
            job["status"] = "done"
            job["stage"] = "done"
            job["progress"] = 100
            job["noteCount"] = result["noteCount"]
            job["pedalCount"] = result["pedalCount"]
            job["ghostCount"] = result.get("ghostCount", 0)
            # The pipeline already ran the spectral verification pass, so
            # the Clean up button never needs to appear for this job.
            job["verified"] = True
            job["pianoStem"] = os.path.relpath(result["pianoStem"], job_dir)
            job["accompaniment"] = (
                os.path.relpath(result["accompaniment"], job_dir)
                if result["accompaniment"] else None)
            job["encoderDelayMs"] = result["encoderDelayMs"]
            job["trimStartSec"] = result["trimStartSec"]
            job["trimEndSec"] = result["trimEndSec"]
        else:  # ("error", msg)
            job["status"] = "error"
            job["error"] = outcome[1]
        _persist(job_id)


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...), piano_only: bool = Form(False)):
    name = file.filename or "untitled.mp3"
    job_id = uuid.uuid4().hex[:12]
    job_dir = _job_dir(job_id)
    os.makedirs(job_dir, exist_ok=True)
    ext = os.path.splitext(name)[1].lower()
    # Video containers welcome too — the worker strips the video stream and
    # decodes the audio to PCM before the pipeline runs (ensure_wav_input).
    if ext not in (".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus",
                   ".wma", ".mp4", ".m4v", ".mkv", ".mov", ".webm"):
        ext = ".mp3"
    dest = os.path.join(job_dir, "input" + ext)
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    job = {
        "id": job_id,
        "name": os.path.splitext(name)[0],
        "status": "processing",
        "stage": "queued",
        "progress": 0,
        "error": None,
        "pianoOnly": piano_only,
        "inputFile": "input" + ext,
        "createdAt": time.time(),
    }
    with jobs_lock:
        jobs[job_id] = job
        _persist(job_id)
    futures[job_id] = executor.submit(_process, job_id, "file", dest, piano_only)
    return job


@app.post("/api/jobs/url")
def create_job_from_url(payload: dict = Body(...)):
    """Create a job from a pasted link (YouTube, Facebook, Instagram, …).
    yt-dlp grabs the best audio stream; we decode it once to WAV so the
    separator/transcriber never see a second lossy encode."""
    url = (payload.get("url") or "").strip()
    piano_only = bool(payload.get("pianoOnly"))
    include_video = bool(payload.get("includeVideo"))
    track_name = (payload.get("trackName") or "").strip() or None
    section = None
    if payload.get("sectionStart") is not None and payload.get("sectionEnd") is not None:
        try:
            section = (float(payload["sectionStart"]), float(payload["sectionEnd"]))
        except (TypeError, ValueError):
            raise HTTPException(400, "invalid sectionStart/sectionEnd")
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "paste a full link starting with http(s)://")
    job_id = uuid.uuid4().hex[:12]
    os.makedirs(_job_dir(job_id), exist_ok=True)
    job = {
        "id": job_id,
        "name": track_name or "Fetching from link…",
        "status": "processing",
        "stage": "downloading",
        "progress": 0,
        "error": None,
        "pianoOnly": piano_only,
        "sourceUrl": url,
        "createdAt": time.time(),
    }
    with jobs_lock:
        jobs[job_id] = job
        _persist(job_id)
    futures[job_id] = executor.submit(
        _process, job_id, "url", url, piano_only, include_video, section,
        track_name)
    return job


@app.post("/api/probe-url")
def probe_url(payload: dict = Body(...)):
    """Look up a link's chapter markers (if any) without downloading, so the
    frontend can offer an album-as-one-video split before conversion starts."""
    url = (payload.get("url") or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "paste a full link starting with http(s)://")
    from . import fetcher
    try:
        title, chapters = fetcher.probe_chapters(url)
    except Exception as e:
        msg = (str(e) or repr(e)).splitlines()[0]
        raise HTTPException(400, "Couldn't read that link: " + msg)
    return {"title": title, "chapters": chapters}


@app.post("/api/jobs/from-library")
def create_job_from_midi(payload: dict = Body(...)):
    """Re-open a library song in the editor. Library songs are stored only as
    baked MIDI, so decode it back into editable note/pedal events and register
    a finished, MIDI-only job (no accompaniment — that was dropped at archive
    time). The result opens straight in the piano-roll editor."""
    name = _safe_name(payload.get("name") or "Library song")
    try:
        raw = base64.b64decode(payload.get("midiBase64") or "", validate=True)
    except (ValueError, TypeError):
        raise HTTPException(400, "invalid midiBase64")
    if not raw:
        raise HTTPException(400, "empty MIDI payload")

    job_id = uuid.uuid4().hex[:12]
    job_dir = _job_dir(job_id)
    os.makedirs(job_dir, exist_ok=True)
    mid_path = os.path.join(job_dir, "input.mid")
    with open(mid_path, "wb") as f:
        f.write(raw)
    try:
        notes, pedals = midi_writer.read_midi(mid_path)
    except Exception as e:  # malformed MIDI -> clean up, report
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(400, "could not parse MIDI: " + str(e))

    # Library MIDI stores *mapped* velocities (map_velocity was applied at
    # render time). Re-exporting would map them again, compressing the
    # dynamic range on every library round trip. Invert the mapping the
    # song was rendered with (its saved settings, pipeline defaults when
    # missing) to recover raw model velocities; the export sliders below
    # re-apply the same curve, so the round trip is lossless (mod rounding).
    settings = payload.get("settings") or {}
    try:
        vel_min = float(settings.get("velMin", 20))
        vel_max = float(settings.get("velMax", 112))
        gamma = float(settings.get("gamma", 1.0))
    except (TypeError, ValueError):
        vel_min, vel_max, gamma = 20.0, 112.0, 1.0
    if vel_max > vel_min and gamma > 0:
        for n in notes:
            norm = (n["velocity"] - vel_min) / (vel_max - vel_min)
            norm = min(1.0, max(0.0, norm))
            n["velocity"] = max(1, min(127, int(round(
                127.0 * norm ** (1.0 / gamma)))))

    with open(os.path.join(job_dir, "events.json"), "w") as f:
        json.dump({"notes": notes, "pedals": pedals}, f)

    # Seed the job's export sliders with the velocity curve the song was
    # archived with, so the default re-export reproduces it exactly.
    # offset/release stay 0: those were already baked into the stored
    # MIDI's event times and must not be applied twice.
    job_settings = {
        "velMin": settings.get("velMin", 20),
        "velMax": settings.get("velMax", 112),
        "gamma": settings.get("gamma", 1.0),
        "offsetMs": 0,
        "releaseMs": 0,
    }

    job = {
        "id": job_id,
        "name": name,
        "status": "done",
        "stage": "done",
        "progress": 100,
        "error": None,
        "pianoOnly": True,
        "noteCount": len(notes),
        "pedalCount": len(pedals),
        "pianoStem": None,
        "accompaniment": None,
        "encoderDelayMs": 0.0,
        "trimStartSec": 0.0,
        "trimEndSec": None,
        "fromLibrary": True,
        "settings": job_settings,
        "createdAt": time.time(),
    }
    with jobs_lock:
        jobs[job_id] = job
        _persist(job_id)
    return job


@app.post("/api/sheet-jobs/{sheet_job_id}/to-song")
def create_job_from_sheet(sheet_job_id: str):
    """Convert a finished sheet job's working score (MusicXML, including any
    accepted pedal/dynamics suggestions and user edits) into a playable
    note-events job that opens straight in the piano-roll editor — same
    finished-job shape as /api/jobs/from-library above. Lives here rather
    than sheet_routes.py because it needs this module's job store/writers
    (sheet_routes must stay importable by main, not the other way around)."""
    sheet_job = sheet_routes.jobs.get(sheet_job_id)
    if sheet_job is None:
        raise HTTPException(404, "sheet job not found")
    score_path = os.path.join(sheet_routes._job_dir(sheet_job_id),
                              "score.musicxml")
    if sheet_job.get("status") != "done" or not os.path.exists(score_path):
        raise HTTPException(409, "score isn't ready yet")

    try:
        root = musicxml_io.load_musicxml(score_path)
        notes, pedals, warnings = sheet_to_events.convert(root)
    except Exception as e:
        raise HTTPException(400, "could not convert score: " + str(e))
    if not notes:
        raise HTTPException(400, "no playable notes found in this score")

    job_id = uuid.uuid4().hex[:12]
    job_dir = _job_dir(job_id)
    os.makedirs(job_dir, exist_ok=True)
    with open(os.path.join(job_dir, "events.json"), "w") as f:
        json.dump({"notes": notes, "pedals": pedals}, f)
    # Baked default render so the job dir mirrors from-library jobs (some
    # exports read input.mid as the fallback source).
    midi_writer.write_midi(notes, pedals, os.path.join(job_dir, "input.mid"))

    job = {
        "id": job_id,
        "name": sheet_job.get("name") or "Sheet song",
        "status": "done",
        "stage": "done",
        "progress": 100,
        "error": None,
        "pianoOnly": True,
        "noteCount": len(notes),
        "pedalCount": len(pedals),
        "pianoStem": None,
        "accompaniment": None,
        "encoderDelayMs": 0.0,
        "trimStartSec": 0.0,
        "trimEndSec": None,
        "fromSheet": sheet_job_id,
        "warnings": warnings,
        "settings": {
            "velMin": 20, "velMax": 112, "gamma": 1.0,
            "offsetMs": 0, "releaseMs": 0,
        },
        "createdAt": time.time(),
    }
    with jobs_lock:
        jobs[job_id] = job
        _persist(job_id)
    return job


@app.get("/api/jobs")
def list_jobs():
    # Oldest first (ids are random hex, useless for ordering); the frontend
    # reverses, so the newest conversion lands on top of the list.
    with jobs_lock:
        items = sorted(jobs.values(),
                       key=lambda j: (j.get("createdAt") or 0, j["id"]))
    return items


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job["status"] == "processing":
        with jobs_lock:
            cancelled.add(job_id)
        fut = futures.get(job_id)
        # cancel() succeeds only while the job is still queued (never started).
        if fut is not None and fut.cancel():
            with jobs_lock:
                cancelled.discard(job_id)
                futures.pop(job_id, None)
                jobs.pop(job_id, None)
            shutil.rmtree(_job_dir(job_id), ignore_errors=True)
            return {"ok": True}
        # Already running: kill the child; its worker thread deletes the temp
        # dir and drops the job once it sees the cancel flag.
        proc = procs.get(job_id)
        if proc is not None:
            try:
                proc.terminate()
            except (ValueError, AssertionError):
                pass  # not started yet; the worker's post-start check aborts it
        return {"ok": True}
    with jobs_lock:
        jobs.pop(job_id, None)
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
    return {"ok": True}


@app.get("/api/jobs/{job_id}/events")
def get_events(job_id: str):
    path = os.path.join(_job_dir(job_id), "events.json")
    if not os.path.exists(path):
        raise HTTPException(404, "events not ready")
    return FileResponse(path, media_type="application/json")


def _clean_events(payload):
    """Validate and normalize an edited events payload from the editor.

    Returns (notes, pedals) sorted by onset, or raises HTTPException(400).
    Times are clamped to >= 0, pitches to the 88-key range, velocities to
    1-127, and zero/negative-length events get a small minimum duration.
    """
    if not isinstance(payload, dict):
        raise HTTPException(400, "body must be a JSON object")
    raw_notes = payload.get("notes")
    raw_pedals = payload.get("pedals")
    if not isinstance(raw_notes, list) or not isinstance(raw_pedals, list):
        raise HTTPException(400, "body needs 'notes' and 'pedals' lists")

    notes = []
    for n in raw_notes:
        try:
            onset = max(0.0, round(float(n["onset"]), 4))
            offset = round(float(n["offset"]), 4)
            pitch = int(n["pitch"])
            velocity = int(n["velocity"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(400, "bad note entry: %r" % (n,))
        if offset <= onset:
            offset = onset + 0.02
        notes.append({
            "onset": onset,
            "offset": offset,
            "pitch": min(108, max(21, pitch)),
            "velocity": min(127, max(1, velocity)),
        })
    pedals = []
    for p in raw_pedals:
        try:
            onset = max(0.0, round(float(p["onset"]), 4))
            offset = round(float(p["offset"]), 4)
        except (KeyError, TypeError, ValueError):
            raise HTTPException(400, "bad pedal entry: %r" % (p,))
        if offset <= onset:
            continue
        pedals.append({"onset": onset, "offset": offset})

    notes.sort(key=lambda n: n["onset"])
    pedals.sort(key=lambda p: p["onset"])
    return notes, pedals


@app.put("/api/jobs/{job_id}/events")
def save_events(job_id: str, payload: dict = Body(...)):
    """Persist edited events. The pristine transcription is kept once as
    events_original.json so edits can always be reverted. Every later render
    (MIDI/E-SEQ/.hfe/USB) reads events.json, so edits apply everywhere."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    events_path = os.path.join(_job_dir(job_id), "events.json")
    if not os.path.exists(events_path):
        raise HTTPException(404, "events not ready")
    notes, pedals = _clean_events(payload)
    original_path = os.path.join(_job_dir(job_id), "events_original.json")
    if not os.path.exists(original_path):
        shutil.copyfile(events_path, original_path)
    with open(events_path, "w") as f:
        json.dump({"notes": notes, "pedals": pedals}, f)
    with jobs_lock:
        job["noteCount"] = len(notes)
        job["pedalCount"] = len(pedals)
        job["edited"] = True
        _persist(job_id)
    return {"ok": True, "noteCount": len(notes), "pedalCount": len(pedals)}


@app.post("/api/jobs/{job_id}/verify")
def verify_job(job_id: str, deep: bool = False):
    """Run the spectral verification pass (ghost-note removal + over-held
    offset trimming, see note_verify) against the job's piano stem — for
    songs converted before the pipeline did this itself. Repeated runs
    converge fast — spectral features are measured over the (possibly
    already-trimmed) note span, so a second pass may catch a few more weak
    notes, a third essentially none. `verified` on the job records that
    it's been done so the UI can stop offering it. The
    pre-cleanup events are kept via the same events_original.json backup
    the editor uses, so Reset to original still restores them.

    deep=true additionally transcribes the original mix as cross-check
    evidence (same as new conversions do in the pipeline) — minutes, not
    seconds, and needs the source audio still on disk."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.get("status") != "done":
        raise HTTPException(409, "job not finished")
    stem_rel = job.get("pianoStem")
    if not stem_rel:
        raise HTTPException(
            409, "no piano stem kept for this song (library import) — "
                 "nothing to check the notes against")
    job_dir = _job_dir(job_id)
    stem_path = os.path.join(job_dir, stem_rel)
    if not os.path.exists(stem_path):
        raise HTTPException(409, "piano stem file missing; re-convert instead")
    events_path = os.path.join(job_dir, "events.json")
    if not os.path.exists(events_path):
        raise HTTPException(404, "events not ready")

    mix_notes = None
    alt_notes, alt_pedals = None, None
    if deep:
        input_path = _input_path(job_id)
        if not os.path.exists(input_path):
            raise HTTPException(
                409, "source audio missing; deep check needs the original mix")
        mix_notes = pipeline.transcribe_mix_notes(
            input_path, lambda stage, pct: None)
        # Destructively trimmed jobs live on a 0-based timeline but the
        # source audio was never cut — shift the mix onsets to match.
        src_start = job.get("srcStartSec", 0.0) or 0.0
        if src_start:
            mix_notes = [dict(m, onset=round(m["onset"] - src_start, 4))
                         for m in mix_notes]
        # Second-engine evidence on the stem itself (already on the job's
        # timeline, no shift needed). Evidence-only: deep clean-up of
        # possibly-edited events must not retime or add notes.
        alt_notes, alt_pedals = transkun_engine.transcribe(stem_path)

    with open(events_path) as f:
        events = json.load(f)
    notes, pedals, stats = note_verify.refine(
        stem_path, events["notes"], events["pedals"], lambda stage, pct: None,
        mix_notes=mix_notes, alt_notes=alt_notes, alt_pedals=alt_pedals,
        alt_evidence_only=True)

    original_path = os.path.join(job_dir, "events_original.json")
    if not os.path.exists(original_path):
        shutil.copyfile(events_path, original_path)
    with open(events_path, "w") as f:
        json.dump({"notes": notes, "pedals": pedals}, f)
    with jobs_lock:
        job["noteCount"] = len(notes)
        job["pedalCount"] = len(pedals)
        job["ghostCount"] = stats["ghosts"] + stats["restrikes"]
        job["verified"] = True
        _persist(job_id)
    return {"noteCount": len(notes), "pedalCount": len(pedals),
            "ghostCount": stats["ghosts"], "trimmedCount": stats["trimmed"],
            "restrikeCount": stats["restrikes"],
            "rescuedCount": stats["pedalRescued"]}


@app.post("/api/jobs/{job_id}/events/reset")
def reset_events(job_id: str):
    """Throw away all edits and restore the original transcription. If the song
    was destructively trimmed, also restore the full-length piano stem and
    accompaniment from the pristine backups."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    job_dir = _job_dir(job_id)
    original_path = os.path.join(job_dir, "events_original.json")
    if not os.path.exists(original_path):
        raise HTTPException(409, "no saved edits to reset")

    # Destructively trimmed: rebuild the full (0..end) window from the backups,
    # which restores events, stem and accompaniment together.
    if job.get("pianoStemOrig"):
        _regen_from_originals(job, job_dir, 0.0, None)
        with jobs_lock:
            job["edited"] = False
            _persist(job_id)
        with open(os.path.join(job_dir, "events.json")) as f:
            return json.load(f)

    events_path = os.path.join(job_dir, "events.json")
    shutil.copyfile(original_path, events_path)
    with open(events_path) as f:
        events = json.load(f)
    with jobs_lock:
        job["noteCount"] = len(events["notes"])
        job["pedalCount"] = len(events["pedals"])
        job["edited"] = False
        _persist(job_id)
    return events


@app.put("/api/jobs/{job_id}/settings")
def save_settings(job_id: str, payload: dict = Body(...)):
    """Persist the export sliders (velocity/gamma/offset/pedal/release/cap) on
    the job so bulk USB-copy and library-move render each song the way it was
    tuned in the editor, not with pipeline defaults. Stored camelCase to match
    the frontend settings object."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    keys = ("velMin", "velMax", "gamma", "offsetMs",
            "pedal", "releaseMs", "capSustain",
            # video-sync player: per-song piano/pedal timing offsets
            "videoSyncMs", "pedalLagMs")
    settings = {k: payload[k] for k in keys if k in payload}
    with jobs_lock:
        job["settings"] = settings
        _persist(job_id)
    return {"ok": True, "settings": settings}


@app.post("/api/jobs/{job_id}/auto-sync")
def auto_sync_job(job_id: str):
    """Cross-correlate the transcribed notes against the job's kept video's
    own audio track to estimate videoSyncMs automatically (see auto_sync.py).
    Returns the offset for the frontend to preview/apply; it isn't persisted
    here so the user can still nudge/save like with tap-sync."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if not job.get("videoFile"):
        raise HTTPException(404, "no video kept for this song")
    job_dir = _job_dir(job_id)
    video_path = os.path.join(job_dir, job["videoFile"])
    if not os.path.exists(video_path):
        raise HTTPException(404, "video file missing")
    events_path = os.path.join(job_dir, "events.json")
    if not os.path.exists(events_path):
        raise HTTPException(404, "events not ready")
    with open(events_path) as f:
        events = json.load(f)
    shift = job.get("srcStartSec") or 0
    notes = [{"onset": n["onset"] + shift, "velocity": n.get("velocity", 64)}
              for n in events["notes"]]
    try:
        result = auto_sync.compute_offset(video_path, notes)
    except Exception as e:
        raise HTTPException(422, "auto-sync failed: " + str(e))
    return result


@app.post("/api/media/auto-sync")
def auto_sync_media(payload: dict = Body(...)):
    """Library-song variant of auto-sync: video lives in MEDIA_DIR, MIDI is
    the baked base64 blob stored on the Firestore song doc."""
    name = payload.get("filename") or ""
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "bad filename")
    video_path = os.path.join(MEDIA_DIR, name)
    if not os.path.exists(video_path):
        raise HTTPException(404, "video file missing")
    try:
        raw = base64.b64decode(payload.get("midiBase64") or "", validate=True)
    except (ValueError, TypeError):
        raise HTTPException(400, "invalid midiBase64")
    if not raw:
        raise HTTPException(400, "empty MIDI payload")
    tmp = os.path.join(JOBS_DIR, "_autosync_%s.mid" % uuid.uuid4().hex[:8])
    try:
        with open(tmp, "wb") as f:
            f.write(raw)
        notes, _pedals = midi_writer.read_midi(tmp)
    except Exception as e:
        raise HTTPException(400, "could not parse MIDI: " + str(e))
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    try:
        result = auto_sync.compute_offset(video_path, notes)
    except Exception as e:
        raise HTTPException(422, "auto-sync failed: " + str(e))
    return result


def _trim_tail(job, events):
    """Drop notes/pedals that start after the song's trim-end so every export
    ends where the (identically trimmed) accompaniment MP3 ends. The front cut
    is handled by the trimStartSec shift baked into the offset below."""
    trim_end = job.get("trimEndSec")
    if trim_end is None:
        return events["notes"], events["pedals"]
    notes = [n for n in events["notes"] if n["onset"] < trim_end]
    pedals = [p for p in events["pedals"] if p["onset"] < trim_end]
    return notes, pedals


@app.get("/api/jobs/{job_id}/midi")
def get_midi(job_id: str, vel_min: int = 20, vel_max: int = 112,
             gamma: float = 1.0, offset_ms: int = 0, pedal: bool = True,
             release_ms: int = 0, cap_sustain: bool = True):
    """Render MIDI with the given settings from stored events (no re-ML)."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    events_path = os.path.join(_job_dir(job_id), "events.json")
    if not os.path.exists(events_path):
        raise HTTPException(404, "events not ready")
    with open(events_path) as f:
        events = json.load(f)
    notes, pedals = _trim_tail(job, events)
    out = os.path.join(_job_dir(job_id), "render.mid")
    # job["encoderDelayMs"] compensates for the accompaniment MP3's fixed
    # codec startup delay (see pipeline.MP3_ENCODER_DELAY_SAMPLES), and
    # trimStartSec mirrors the dead-space cut applied to the accompaniment,
    # so the user's offset_ms=0 is already correctly synced.
    effective_offset_ms = (offset_ms + job.get("encoderDelayMs", 0.0)
                           - job.get("trimStartSec", 0.0) * 1000.0)
    midi_writer.write_midi(
        notes, pedals, out,
        vel_min=vel_min, vel_max=vel_max, gamma=gamma,
        offset_ms=effective_offset_ms, include_pedal=pedal,
        release_ms=release_ms, cap_sustain=cap_sustain)
    return FileResponse(
        out, media_type="audio/midi",
        filename=job["name"] + ".mid")


@app.get("/api/jobs/{job_id}/audio/original")
def get_original(job_id: str):
    path = _input_path(job_id)
    if not os.path.exists(path):
        raise HTTPException(404, "not found")
    media = "audio/wav" if path.lower().endswith(".wav") else "audio/mpeg"
    return FileResponse(path, media_type=media)


@app.get("/api/jobs/{job_id}/audio/piano")
def get_piano_stem(job_id: str):
    job = jobs.get(job_id)
    if job is None or not job.get("pianoStem"):
        raise HTTPException(404, "stem not ready")
    path = os.path.join(_job_dir(job_id), job["pianoStem"])
    if not os.path.exists(path):
        raise HTTPException(404, "stem file missing")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/jobs/{job_id}/eseq")
def get_eseq(job_id: str, vel_min: int = 20, vel_max: int = 112,
             gamma: float = 1.0, offset_ms: int = 0, pedal: bool = True,
             release_ms: int = 0, cap_sustain: bool = True):
    """Render Yamaha E-SEQ (.FIL) for floppy-era Disklaviers, with the same
    settings and baked offsets as the MIDI render."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    events_path = os.path.join(_job_dir(job_id), "events.json")
    if not os.path.exists(events_path):
        raise HTTPException(404, "events not ready")
    with open(events_path) as f:
        events = json.load(f)
    notes, pedals = _trim_tail(job, events)
    effective_offset_ms = (offset_ms + job.get("encoderDelayMs", 0.0)
                           - job.get("trimStartSec", 0.0) * 1000.0)
    out = os.path.join(_job_dir(job_id), "render.fil")
    eseq_writer.write_eseq(
        notes, pedals, out, title=job["name"],
        vel_min=vel_min, vel_max=vel_max, gamma=gamma,
        offset_ms=effective_offset_ms, include_pedal=pedal,
        dos_name=job["name"], release_ms=release_ms, cap_sustain=cap_sustain)
    return FileResponse(
        out, media_type="application/octet-stream",
        filename=eseq_writer._sanitize_83(job["name"]).strip() + ".FIL")


def _render_hfe(job_id, vel_min, vel_max, gamma, offset_ms, pedal,
                release_ms=0, cap_sustain=True):
    """Build the .hfe disk image for a job; returns (path, dos_base)."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    events_path = os.path.join(_job_dir(job_id), "events.json")
    if not os.path.exists(events_path):
        raise HTTPException(404, "events not ready")
    with open(events_path) as f:
        events = json.load(f)
    notes, pedals = _trim_tail(job, events)
    effective_offset_ms = (offset_ms + job.get("encoderDelayMs", 0.0)
                           - job.get("trimStartSec", 0.0) * 1000.0)
    fil_path = os.path.join(_job_dir(job_id), "render.fil")
    eseq_writer.write_eseq(
        notes, pedals, fil_path, title=job["name"],
        vel_min=vel_min, vel_max=vel_max, gamma=gamma,
        offset_ms=effective_offset_ms, include_pedal=pedal,
        dos_name=job["name"], release_ms=release_ms, cap_sustain=cap_sustain)
    with open(fil_path, "rb") as f:
        fil_bytes = f.read()
    dos_base = eseq_writer._sanitize_83(job["name"])
    hfe = disk_writer.build_disk_hfe(fil_bytes, dos_base)
    out = os.path.join(_job_dir(job_id), "render.hfe")
    with open(out, "wb") as f:
        f.write(hfe)
    return out, dos_base


@app.get("/api/jobs/{job_id}/hfe")
def get_hfe(job_id: str, vel_min: int = 20, vel_max: int = 112,
            gamma: float = 1.0, offset_ms: int = 0, pedal: bool = True,
            release_ms: int = 0, cap_sustain: bool = True):
    """Complete Gotek/Nalbantov floppy image (.hfe): FAT12 disk holding
    PIANODIR.FIL + the E-SEQ song, MFM-encoded. Drop on the emulator USB
    stick as DSKAxxxx.hfe and play."""
    out, dos_base = _render_hfe(job_id, vel_min, vel_max, gamma,
                                offset_ms, pedal, release_ms, cap_sustain)
    return FileResponse(
        out, media_type="application/octet-stream",
        filename=dos_base.strip() + ".hfe")


@app.get("/api/usb")
def usb_status():
    """Detect the emulator stick and report the next free slot."""
    root = usb.find_usb_drive()
    if root is None:
        return {"found": False}
    _used, free = usb.used_and_free(root, scan_from=14, stop_after_free=1)
    return {
        "found": True,
        "drive": root,
        "nextFreeSlot": free[0] if free else None,
    }


@app.get("/api/gotek/catalog")
def gotek_catalog(fast: bool = True):
    """Full contents of the emulator stick: every DSKAxxxx.hfe slot with the
    songs on it (decoded from each disk's FAT/PIANODIR). Powers the Disk tab's
    printable catalog. Blanks are listed too.

    fast=True (default) fingerprints slots and only MFM-decodes the ones that
    aren't the blank template, so a stick full of empty slots scans in a
    fraction of the time. fast=false decodes every slot."""
    root = usb.find_usb_drive()
    if root is None:
        return {"found": False}
    slots = usb.scan_catalog(root, fast=fast)
    used = sum(1 for s in slots if not s.get("blank"))
    total_songs = sum(len(s.get("songs", [])) for s in slots)
    return {
        "found": True,
        "drive": root,
        "slots": slots,
        "usedSlots": used,
        "totalSlots": len(slots),
        "totalSongs": total_songs,
        "fast": fast,
    }


@app.get("/api/drives")
def drives_status():
    """Removable drives currently plugged in, plus whether the Gotek stick
    is present. Cheap (no slot blank-scan) so the UI can poll it."""
    return {
        "removable": usb.list_removable_drives(),
        "gotekRoot": usb.find_usb_drive(),
    }


def _fs_safe_name(name):
    """Strip characters Windows/FAT filesystems reject from a filename."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return cleaned or "song"


@app.post("/api/jobs/{job_id}/export")
def export_job_file(job_id: str, kind: str, dest: str,
                    vel_min: int = 20, vel_max: int = 112,
                    gamma: float = 1.0, offset_ms: int = 0,
                    pedal: bool = True, release_ms: int = 0,
                    cap_sustain: bool = True):
    """Render one deliverable (midi / mp3 / hfe) and copy it into `dest`
    (typically a removable drive root chosen in the UI)."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if not os.path.isdir(dest):
        raise HTTPException(400, "target folder not found: " + dest)

    if kind == "midi":
        # same render path as GET /midi
        get_midi(job_id, vel_min, vel_max, gamma, offset_ms, pedal,
                 release_ms, cap_sustain)
        src = os.path.join(_job_dir(job_id), "render.mid")
        filename = _fs_safe_name(job["name"]) + ".mid"
    elif kind == "mp3":
        if not job.get("accompaniment"):
            raise HTTPException(404, "accompaniment not ready")
        src = os.path.join(_job_dir(job_id), job["accompaniment"])
        if not os.path.exists(src):
            raise HTTPException(404, "accompaniment file missing")
        filename = _fs_safe_name(job["name"]) + " (no piano).mp3"
    elif kind == "hfe":
        src, dos_base = _render_hfe(job_id, vel_min, vel_max, gamma,
                                    offset_ms, pedal, release_ms, cap_sustain)
        filename = dos_base.strip() + ".hfe"
    else:
        raise HTTPException(400, "kind must be midi, mp3 or hfe")

    out_path = os.path.join(dest, filename)
    try:
        with open(src, "rb") as f:
            data = f.read()
        # fsync onto the device: a removable drive pulled before Windows
        # flushes its write cache would otherwise leave a truncated file.
        usb.write_flushed(out_path, data)
    except OSError as e:
        raise HTTPException(500, "write failed: " + str(e))
    return {"path": out_path, "filename": filename}


@app.post("/api/jobs/{job_id}/usb")
def save_job_to_usb(job_id: str, vel_min: int = 20, vel_max: int = 112,
                    gamma: float = 1.0, offset_ms: int = 0,
                    pedal: bool = True, release_ms: int = 0,
                    cap_sustain: bool = True):
    """Render the .hfe and write it straight into the first blank slot on
    the emulator stick. Blankness is verified by decoding each slot's FAT
    root directory, so existing songs can't be overwritten."""
    out, _dos_base = _render_hfe(job_id, vel_min, vel_max, gamma,
                                 offset_ms, pedal, release_ms, cap_sustain)
    with open(out, "rb") as f:
        hfe_bytes = f.read()
    try:
        root, slot = usb.save_to_next_free(hfe_bytes)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except (RuntimeError, OSError) as e:
        raise HTTPException(500, str(e))
    return {
        "drive": root,
        "slot": slot,
        "filename": "DSKA%04d.hfe" % slot,
    }


# ---------------------------------------------------------------- multi-song disk
# One Gotek slot = one .hfe = one 720K floppy. A floppy holds many E-SEQ songs,
# so these endpoints pack several converted jobs (or several library songs) onto
# a single slot instead of one song per slot.

_DISK_DEFAULTS = {"velMin": 20, "velMax": 112, "gamma": 1.0,
                  "offsetMs": 0, "pedal": True, "releaseMs": 0,
                  "capSustain": True}


def _norm_disk_settings(raw):
    """Merge a job/library settings dict over the export defaults."""
    s = dict(_DISK_DEFAULTS)
    if isinstance(raw, dict):
        for k in _DISK_DEFAULTS:
            if raw.get(k) is not None:
                s[k] = raw[k]
    return s


def _disk_dos_bases(names):
    """Unique 8-char DOS base per song: a 2-digit play-order prefix plus up to
    6 alphanumeric chars from the title. The prefix orders the piano's
    song-select menu and guarantees uniqueness — the 1995 firmware refuses a
    disk with two identical 8.3 names."""
    out = []
    for i, nm in enumerate(names):
        core = eseq_writer._sanitize_83(nm or "SONG").rstrip() or "SONG"
        out.append(("%02d" % ((i + 1) % 100)) + core[:6])
    return out


def _eseq_bytes(notes, pedals, title, dos_base, s):
    """Render one E-SEQ .FIL to a temp file and return its bytes. dos_base is
    baked into the .FIL header so it matches the disk's directory entry."""
    fd, tmp = tempfile.mkstemp(suffix=".fil")
    os.close(fd)
    try:
        eseq_writer.write_eseq(
            notes, pedals, tmp, title=title,
            vel_min=int(s["velMin"]), vel_max=int(s["velMax"]),
            gamma=float(s["gamma"]), offset_ms=float(s["offsetMs"]),
            include_pedal=bool(s["pedal"]), dos_name=dos_base,
            release_ms=int(s["releaseMs"]), cap_sustain=bool(s["capSustain"]))
        with open(tmp, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _decode_library_midi(raw, settings):
    """Decode a library song's baked MIDI into events, inverting the velocity
    curve it was archived with so re-rendering re-applies the same curve
    losslessly (mirrors POST /jobs/from-library)."""
    fd, tmp = tempfile.mkstemp(suffix=".mid")
    os.close(fd)
    try:
        with open(tmp, "wb") as f:
            f.write(raw)
        notes, pedals = midi_writer.read_midi(tmp)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    st = settings or {}
    try:
        vmin = float(st.get("velMin", 20))
        vmax = float(st.get("velMax", 112))
        g = float(st.get("gamma", 1.0))
    except (TypeError, ValueError):
        vmin, vmax, g = 20.0, 112.0, 1.0
    if vmax > vmin and g > 0:
        for n in notes:
            norm = (n["velocity"] - vmin) / (vmax - vmin)
            norm = min(1.0, max(0.0, norm))
            n["velocity"] = max(1, min(127, int(round(
                127.0 * norm ** (1.0 / g)))))
    return notes, pedals


def _finish_disk(hfe, payload):
    """Deliver a built multi-song .hfe: stream it back when download is
    requested, otherwise write it to the stick (next free slot by default, or a
    caller-chosen slot — overwriting an occupied one only when overwrite=true)."""
    if payload.get("download"):
        return StreamingResponse(
            BytesIO(hfe), media_type="application/octet-stream",
            headers={"Content-Disposition":
                     'attachment; filename="PIANODISK.hfe"'})
    slot = payload.get("slot")
    if slot is not None:
        try:
            slot = int(slot)
        except (TypeError, ValueError):
            raise HTTPException(400, "slot must be an integer")
    try:
        if slot is not None:
            if not payload.get("overwrite"):
                root = usb.find_usb_drive()
                if root is None:
                    raise FileNotFoundError(
                        "No Gotek/Nalbantov USB stick found. Plug it in and "
                        "try again.")
                path = os.path.join(root, "DSKA%04d.hfe" % slot)
                if os.path.exists(path) and not usb.is_blank_slot(path):
                    raise HTTPException(
                        409, "slot %d already holds a song; resend with "
                        "overwrite to replace it" % slot)
            root, used = usb.save_to_slot(hfe, slot)
        else:
            root, used = usb.save_to_next_free(hfe)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except (RuntimeError, OSError, ValueError) as e:
        raise HTTPException(500, str(e))
    return {"drive": root, "slot": used, "filename": "DSKA%04d.hfe" % used}


@app.post("/api/disk/build")
def build_disk_from_jobs(payload: dict = Body(...)):
    """Pack several converted jobs onto ONE floppy image (many songs per Gotek
    slot). Each job renders with its own saved export settings.
    Body: {jobIds:[...], slot?:int, overwrite?:bool, download?:bool}."""
    job_ids = payload.get("jobIds")
    if not isinstance(job_ids, list) or not job_ids:
        raise HTTPException(400, "jobIds must be a non-empty list")
    prepared = []  # (job, notes, pedals, settings)
    titles = []
    for jid in job_ids:
        job = jobs.get(jid)
        if job is None:
            raise HTTPException(404, "job not found: " + str(jid))
        events_path = os.path.join(_job_dir(jid), "events.json")
        if not os.path.exists(events_path):
            raise HTTPException(404, "events not ready for job " + str(jid))
        with open(events_path) as f:
            events = json.load(f)
        notes, pedals = _trim_tail(job, events)
        prepared.append((job, notes, pedals,
                         _norm_disk_settings(job.get("settings"))))
        titles.append(job.get("name") or "Song")
    bases = _disk_dos_bases(titles)
    songs = []
    for (job, notes, pedals, s), base in zip(prepared, bases):
        eff = dict(s)
        eff["offsetMs"] = (float(s["offsetMs"]) + job.get("encoderDelayMs", 0.0)
                           - job.get("trimStartSec", 0.0) * 1000.0)
        songs.append((_eseq_bytes(notes, pedals, job.get("name") or "",
                                  base, eff), base))
    try:
        hfe = disk_writer.build_disk_hfe_multi(songs)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _finish_disk(hfe, payload)


@app.post("/api/disk/build-midi")
def build_disk_from_midi(payload: dict = Body(...)):
    """Pack several library songs (stored as baked MIDI) onto one floppy image.
    Body: {songs:[{name, midiBase64, settings}], slot?, overwrite?, download?}."""
    items = payload.get("songs")
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "songs must be a non-empty list")
    titles = [it.get("name") or "Song" for it in items]
    bases = _disk_dos_bases(titles)
    built = []
    for it, base in zip(items, bases):
        name = it.get("name") or "song"
        try:
            raw = base64.b64decode(it.get("midiBase64") or "", validate=True)
        except (ValueError, TypeError):
            raise HTTPException(400, "invalid midiBase64 for " + name)
        if not raw:
            raise HTTPException(400, "empty MIDI for " + name)
        try:
            notes, pedals = _decode_library_midi(raw, it.get("settings"))
        except Exception as e:
            raise HTTPException(400, "could not parse MIDI for %s: %s"
                                % (name, e))
        s = _norm_disk_settings(it.get("settings"))
        # Offsets/tail were baked into the stored MIDI's event times; don't
        # apply them a second time on export.
        s["offsetMs"] = 0
        s["releaseMs"] = 0
        built.append((_eseq_bytes(notes, pedals, name, base, s), base))
    try:
        hfe = disk_writer.build_disk_hfe_multi(built)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _finish_disk(hfe, payload)


def _trim_events_window(events, abs_start, abs_end):
    """Cut events to absolute-time [abs_start, abs_end] and shift so the window
    starts at 0. Drops anything wholly outside; clips events straddling the
    start edge. Events straddling the END keep their full offset — chopping
    the final chord's note/pedal tails at the trim line cuts the ring-out
    audibly on the piano (the Disklavier re-creates the ring live, so tails
    past the trimmed audio cost nothing)."""
    def cut(items):
        out = []
        for it in items:
            onset = it["onset"]
            offset = it["offset"]
            if offset <= abs_start:
                continue                      # entirely before the window
            if abs_end is not None and onset >= abs_end:
                continue                      # entirely after the window
            new_on = max(0.0, onset - abs_start)
            new_off = offset - abs_start
            if new_off <= new_on:
                continue
            clone = dict(it)
            clone["onset"] = round(new_on, 4)
            clone["offset"] = round(new_off, 4)
            out.append(clone)
        return out
    return {"notes": cut(events["notes"]), "pedals": cut(events["pedals"])}


def _ensure_trim_originals(job, job_dir):
    """Back up the pristine, full-length sources once, so destructive trims can
    always be recomputed from them (and fully reset). Returns the paths."""
    events_path = os.path.join(job_dir, "events.json")
    original_events = os.path.join(job_dir, "events_original.json")
    if not os.path.exists(original_events):
        if not os.path.exists(events_path):
            raise HTTPException(404, "events not ready")
        shutil.copyfile(events_path, original_events)
    stem_orig = job.get("pianoStemOrig")
    piano_stem = job.get("pianoStem")
    if stem_orig is None and piano_stem:
        stem_path = os.path.join(job_dir, piano_stem)
        stem_orig = "piano_original.wav"
        dst = os.path.join(job_dir, stem_orig)
        if os.path.exists(stem_path) and not os.path.exists(dst):
            shutil.copyfile(stem_path, dst)
        job["pianoStemOrig"] = stem_orig
    return original_events, stem_orig


def _regen_from_originals(job, job_dir, abs_start, abs_end):
    """Rebuild events.json, the piano stem, and the accompaniment MP3 for the
    absolute-time window [abs_start, abs_end] from the pristine backups, then
    shift everything to a 0-based timeline. Composable across repeated trims."""
    import soundfile as sf

    original_events = os.path.join(job_dir, "events_original.json")
    with open(original_events) as f:
        orig = json.load(f)
    trimmed = _trim_events_window(orig, abs_start, abs_end)
    with open(os.path.join(job_dir, "events.json"), "w") as f:
        json.dump(trimmed, f)

    # piano stem, cut from the pristine full-length copy. The cut extends past
    # abs_end to the last kept event offset so the ring-out's audio survives
    # for later Verify passes (events keep their tails past the trim line).
    stem_orig = job.get("pianoStemOrig")
    piano_stem = job.get("pianoStem")
    if stem_orig and piano_stem:
        src = os.path.join(job_dir, stem_orig)
        if os.path.exists(src):
            data, sr = sf.read(src)
            lo = int(abs_start * sr)
            if abs_end is None:
                hi = len(data)
            else:
                tails = [e["offset"] for e in
                         trimmed["notes"] + trimmed["pedals"]]
                keep_end = abs_start + max(tails) if tails else abs_end
                hi = min(len(data), int(max(abs_end, keep_end) * sr))
            sf.write(os.path.join(job_dir, piano_stem), data[lo:hi], sr)

    # accompaniment, re-encoded from the never-cut no_piano stem
    if piano_stem and job.get("accompaniment"):
        no_piano = os.path.join(
            job_dir, os.path.dirname(piano_stem), "no_piano.wav")
        if not os.path.exists(no_piano):
            raise HTTPException(
                409, "accompaniment stem missing; re-convert to change trim")
        accompaniment, encoder_delay_ms = pipeline.encode_accompaniment(
            no_piano, job_dir, lambda stage, pct: None,
            trim_start=abs_start, trim_end=abs_end)
        job["accompaniment"] = os.path.relpath(accompaniment, job_dir)
        job["encoderDelayMs"] = encoder_delay_ms

    with jobs_lock:
        job["srcStartSec"] = round(abs_start, 3)
        job["srcEndSec"] = round(abs_end, 3) if abs_end is not None else None
        job["trimStartSec"] = 0.0
        job["trimEndSec"] = None
        job["noteCount"] = len(trimmed["notes"])
        job["pedalCount"] = len(trimmed["pedals"])
        job["edited"] = True
        _persist(job["id"])
    return trimmed


@app.post("/api/jobs/{job_id}/trim")
def trim_job(job_id: str, trim_start: float = 0.0,
             trim_end: Optional[float] = None):
    """Manually trim the song's start/end (seconds, in the currently displayed
    timeline). Destructive: events outside the window are deleted and the rest
    shifted to start at 0, and the piano stem + accompaniment MP3 are cut to
    match — audio and piano stay locked, the dead space is truly gone. The
    pristine sources are kept, so Reset to original restores everything."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.get("status") != "done":
        raise HTTPException(409, "job not finished")
    trim_start = max(0.0, float(trim_start))
    if trim_end is not None:
        trim_end = float(trim_end)
        if trim_end <= trim_start:
            raise HTTPException(400, "trim end must be after trim start")
    job_dir = _job_dir(job_id)
    _ensure_trim_originals(job, job_dir)
    # Convert from the displayed (0-based) timeline into absolute source time so
    # repeated trims compose correctly.
    src_start = job.get("srcStartSec", 0.0) or 0.0
    abs_start = src_start + trim_start
    abs_end = None if trim_end is None else src_start + trim_end
    _regen_from_originals(job, job_dir, abs_start, abs_end)
    return job


@app.post("/api/jobs/{job_id}/retrim")
def retrim_job(job_id: str):
    """Auto-detect dead space and apply it destructively (from pristine
    sources). For jobs converted before trim support, or to snap to detected
    bounds."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    input_path = _input_path(job_id)
    if not os.path.exists(input_path):
        raise HTTPException(409, "source audio missing; re-convert instead")
    job_dir = _job_dir(job_id)
    _ensure_trim_originals(job, job_dir)
    trim_start, trim_end = pipeline.detect_dead_space(input_path)
    _regen_from_originals(job, job_dir, trim_start, trim_end)
    return job


@app.get("/api/jobs/{job_id}/audio/accompaniment")
def get_accompaniment(job_id: str):
    job = jobs.get(job_id)
    if job is None or not job.get("accompaniment"):
        raise HTTPException(404, "accompaniment not ready")
    path = os.path.join(_job_dir(job_id), job["accompaniment"])
    if not os.path.exists(path):
        raise HTTPException(404, "accompaniment file missing")
    return FileResponse(
        path, media_type="audio/mpeg",
        filename=job["name"] + " (no piano).mp3")


_VIDEO_MEDIA_TYPES = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
    ".mkv": "video/x-matroska", ".mov": "video/quicktime",
}


def _video_media_type(path):
    return _VIDEO_MEDIA_TYPES.get(
        os.path.splitext(path)[1].lower(), "video/mp4")


def _serve_video(path, request):
    """Stream a video file honoring HTTP Range requests. Starlette's
    FileResponse ignores Range; without 206 responses the <video> element
    can't seek beyond what it has already buffered."""
    size = os.path.getsize(path)
    media = _video_media_type(path)
    rng = request.headers.get("range")
    m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
    if not m or (not m.group(1) and not m.group(2)):
        return FileResponse(
            path, media_type=media, headers={"Accept-Ranges": "bytes"})
    if m.group(1):
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
    else:  # suffix form: bytes=-N (last N bytes)
        start = max(0, size - int(m.group(2)))
        end = size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        raise HTTPException(416, "range out of bounds")

    def stream():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(512 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(stream(), status_code=206, media_type=media, headers={
        "Content-Range": "bytes %d-%d/%d" % (start, end, size),
        "Content-Length": str(end - start + 1),
        "Accept-Ranges": "bytes",
    })


@app.get("/api/jobs/{job_id}/video")
def get_job_video(job_id: str, request: Request):
    """The video kept with this conversion (URL fetch with 'include video',
    or an uploaded video file), for the Play tab."""
    job = jobs.get(job_id)
    if job is None or not job.get("videoFile"):
        raise HTTPException(404, "no video kept for this song")
    path = os.path.join(_job_dir(job_id), job["videoFile"])
    if not os.path.exists(path):
        raise HTTPException(404, "video file missing")
    return _serve_video(path, request)


@app.get("/api/media/{name}")
def get_media(name: str, request: Request):
    """Serve an archived video from the local media folder (library songs)."""
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "bad name")
    path = os.path.join(MEDIA_DIR, name)
    if not os.path.exists(path):
        raise HTTPException(404, "not found")
    return _serve_video(path, request)


@app.post("/api/jobs/{job_id}/archive-video")
def archive_video(job_id: str):
    """Move the job's kept video into the local media folder so it survives
    the job's deletion when the song moves to the (cloud) library — video
    files are far too big for Firebase, so they live on this computer and
    the library entry stores just the filename."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    video_rel = job.get("videoFile")
    if not video_rel:
        raise HTTPException(404, "no video kept for this song")
    src = os.path.join(_job_dir(job_id), video_rel)
    if not os.path.exists(src):
        raise HTTPException(404, "video file missing")
    ext = os.path.splitext(video_rel)[1].lower()
    base = _fs_safe_name(job["name"])
    name = base + ext
    n = 2
    while os.path.exists(os.path.join(MEDIA_DIR, name)):
        name = "%s (%d)%s" % (base, n, ext)
        n += 1
    shutil.move(src, os.path.join(MEDIA_DIR, name))
    with jobs_lock:
        job.pop("videoFile", None)
        _persist(job_id)
    return {"file": name}


@app.post("/api/midi/decode")
def decode_midi(payload: dict = Body(...)):
    """Decode a base64 MIDI blob into note/pedal events — the video-sync
    player uses this to play library songs (stored as baked MIDI) without
    creating a throwaway job. Velocities come back as stored (already
    velocity-mapped at render time), so the player must not re-map them."""
    try:
        raw = base64.b64decode(payload.get("midiBase64") or "", validate=True)
    except (ValueError, TypeError):
        raise HTTPException(400, "invalid midiBase64")
    if not raw:
        raise HTTPException(400, "empty MIDI payload")
    tmp = os.path.join(JOBS_DIR, "_decode_%s.mid" % uuid.uuid4().hex[:8])
    try:
        with open(tmp, "wb") as f:
            f.write(raw)
        notes, pedals = midi_writer.read_midi(tmp)
    except Exception as e:
        raise HTTPException(400, "could not parse MIDI: " + str(e))
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return {"notes": notes, "pedals": pedals}


@app.get("/api/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
