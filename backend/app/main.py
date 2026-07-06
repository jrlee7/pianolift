"""PianoLift API server.

Jobs live under backend/jobs/<id>/ :
  input.mp3      uploaded audio
  demucs/        Demucs output (piano stem)
  events.json    transcribed notes + pedals (raw model output)
  output.mid     default-settings MIDI render
  job.json       persisted job metadata/status
"""

import json
import os
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import pipeline, midi_writer, eseq_writer

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOBS_DIR = os.path.join(BASE_DIR, "jobs")
os.makedirs(JOBS_DIR, exist_ok=True)

app = FastAPI(title="PianoLift")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# One worker: the models are heavy and CPU-bound; queue jobs serially.
executor = ThreadPoolExecutor(max_workers=1)
jobs_lock = threading.Lock()
jobs = {}


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
            jobs[entry] = job


_load_jobs_from_disk()


def _progress(job_id):
    def cb(stage, pct):
        with jobs_lock:
            job = jobs.get(job_id)
            if job is not None:
                job["stage"] = stage
                job["progress"] = pct
    return cb


def _process(job_id):
    job_dir = _job_dir(job_id)
    mp3_path = os.path.join(job_dir, "input.mp3")
    try:
        result = pipeline.run_job(job_dir, mp3_path, _progress(job_id))
        with jobs_lock:
            job = jobs[job_id]
            job["status"] = "done"
            job["stage"] = "done"
            job["progress"] = 100
            job["noteCount"] = result["noteCount"]
            job["pedalCount"] = result["pedalCount"]
            job["pianoStem"] = os.path.relpath(result["pianoStem"], job_dir)
            job["accompaniment"] = os.path.relpath(
                result["accompaniment"], job_dir)
            job["encoderDelayMs"] = result["encoderDelayMs"]
            job["trimStartSec"] = result["trimStartSec"]
            job["trimEndSec"] = result["trimEndSec"]
            _persist(job_id)
    except Exception as e:  # surface any pipeline failure to the UI
        with jobs_lock:
            job = jobs[job_id]
            job["status"] = "error"
            job["error"] = str(e) or repr(e)
            _persist(job_id)


@app.post("/api/jobs")
async def create_job(file: UploadFile = File(...)):
    name = file.filename or "untitled.mp3"
    job_id = uuid.uuid4().hex[:12]
    job_dir = _job_dir(job_id)
    os.makedirs(job_dir, exist_ok=True)
    dest = os.path.join(job_dir, "input.mp3")
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    job = {
        "id": job_id,
        "name": os.path.splitext(name)[0],
        "status": "processing",
        "stage": "queued",
        "progress": 0,
        "error": None,
    }
    with jobs_lock:
        jobs[job_id] = job
        _persist(job_id)
    executor.submit(_process, job_id)
    return job


@app.get("/api/jobs")
def list_jobs():
    with jobs_lock:
        items = sorted(jobs.values(), key=lambda j: j["id"])
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
        raise HTTPException(409, "job still processing")
    with jobs_lock:
        del jobs[job_id]
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
    return {"ok": True}


@app.get("/api/jobs/{job_id}/events")
def get_events(job_id: str):
    path = os.path.join(_job_dir(job_id), "events.json")
    if not os.path.exists(path):
        raise HTTPException(404, "events not ready")
    return FileResponse(path, media_type="application/json")


@app.get("/api/jobs/{job_id}/midi")
def get_midi(job_id: str, vel_min: int = 20, vel_max: int = 112,
             gamma: float = 1.0, offset_ms: int = 0, pedal: bool = True):
    """Render MIDI with the given settings from stored events (no re-ML)."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    events_path = os.path.join(_job_dir(job_id), "events.json")
    if not os.path.exists(events_path):
        raise HTTPException(404, "events not ready")
    with open(events_path) as f:
        events = json.load(f)
    out = os.path.join(_job_dir(job_id), "render.mid")
    # job["encoderDelayMs"] compensates for the accompaniment MP3's fixed
    # codec startup delay (see pipeline.MP3_ENCODER_DELAY_SAMPLES), and
    # trimStartSec mirrors the dead-space cut applied to the accompaniment,
    # so the user's offset_ms=0 is already correctly synced.
    effective_offset_ms = (offset_ms + job.get("encoderDelayMs", 0.0)
                           - job.get("trimStartSec", 0.0) * 1000.0)
    midi_writer.write_midi(
        events["notes"], events["pedals"], out,
        vel_min=vel_min, vel_max=vel_max, gamma=gamma,
        offset_ms=effective_offset_ms, include_pedal=pedal)
    return FileResponse(
        out, media_type="audio/midi",
        filename=job["name"] + ".mid")


@app.get("/api/jobs/{job_id}/audio/original")
def get_original(job_id: str):
    path = os.path.join(_job_dir(job_id), "input.mp3")
    if not os.path.exists(path):
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="audio/mpeg")


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
             gamma: float = 1.0, offset_ms: int = 0, pedal: bool = True):
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
    effective_offset_ms = (offset_ms + job.get("encoderDelayMs", 0.0)
                           - job.get("trimStartSec", 0.0) * 1000.0)
    out = os.path.join(_job_dir(job_id), "render.fil")
    eseq_writer.write_eseq(
        events["notes"], events["pedals"], out, title=job["name"],
        vel_min=vel_min, vel_max=vel_max, gamma=gamma,
        offset_ms=effective_offset_ms, include_pedal=pedal,
        dos_name=job["name"])
    return FileResponse(
        out, media_type="application/octet-stream",
        filename=eseq_writer._sanitize_83(job["name"]).strip() + ".FIL")


@app.post("/api/jobs/{job_id}/retrim")
def retrim_job(job_id: str):
    """Apply dead-space trimming to a job converted before trim support
    existed (or re-run it). Re-encodes the accompaniment from the kept
    no_piano stem — no separation/transcription re-run needed."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job["status"] != "done":
        raise HTTPException(409, "job not finished")
    job_dir = _job_dir(job_id)
    piano_stem = job.get("pianoStem")
    if not piano_stem:
        raise HTTPException(409, "stems missing")
    no_piano = os.path.join(
        job_dir, os.path.dirname(piano_stem), "no_piano.wav")
    input_path = os.path.join(job_dir, "input.mp3")
    if not os.path.exists(no_piano) or not os.path.exists(input_path):
        raise HTTPException(409, "source files missing; re-convert instead")

    trim_start, trim_end = pipeline.detect_dead_space(input_path)
    accompaniment, encoder_delay_ms = pipeline.encode_accompaniment(
        no_piano, job_dir, lambda stage, pct: None,
        trim_start=trim_start, trim_end=trim_end)
    with jobs_lock:
        job["accompaniment"] = os.path.relpath(accompaniment, job_dir)
        job["encoderDelayMs"] = encoder_delay_ms
        job["trimStartSec"] = trim_start
        job["trimEndSec"] = trim_end
        _persist(job_id)
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


@app.get("/api/health")
def health():
    return {"ok": True}
