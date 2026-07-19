"""Sheet-music (PDF/MusicXML -> pedal+dynamics suggestions) API. Separate
job store and directory tree from the audio-conversion jobs in main.py
(backend/sheet_jobs/<id>/ instead of backend/jobs/<id>/) since the job
shapes don't overlap — no piano stem, no accompaniment, no MIDI render.

Job dir layout:
  input.<ext>            uploaded file, original extension
  score_original.musicxml   normalized upload, before any suggestions
  score_suggested.musicxml  right after the engines ran, before user edits
  score.musicxml             current working copy (what the editor shows)
  job.json                   persisted job metadata/status
"""

import json
import os
import shutil
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse

from . import musicxml_io as mxml
from . import sheet_pipeline

# See main.py's BASE_DIR comment: a PyInstaller onefile build's __file__
# resolves inside a per-run temp extraction dir, so frozen mode persists to
# a stable per-user location instead.
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", "."), "PianoForge", "data")
else:
    BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEET_JOBS_DIR = os.path.join(BASE_DIR, "sheet_jobs")
os.makedirs(SHEET_JOBS_DIR, exist_ok=True)

router = APIRouter(prefix="/api/sheet-jobs", tags=["sheet"])

jobs_lock = threading.Lock()
jobs = {}
# OMR (Audiveris) is a heavy external process — one at a time, off the
# request thread, so a PDF upload doesn't block the HTTP response for
# however long recognition takes.
omr_executor = ThreadPoolExecutor(max_workers=1)


def _job_dir(job_id):
    return os.path.join(SHEET_JOBS_DIR, job_id)


def _persist(job_id):
    job = jobs.get(job_id)
    if job is None:
        return
    with open(os.path.join(_job_dir(job_id), "job.json"), "w") as f:
        json.dump(job, f)


def _load_jobs_from_disk():
    for entry in os.listdir(SHEET_JOBS_DIR):
        meta_path = os.path.join(SHEET_JOBS_DIR, entry, "job.json")
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    jobs[entry] = json.load(f)
            except (ValueError, OSError):
                continue


_load_jobs_from_disk()


def _safe_name(name):
    out = []
    for ch in name or "untitled":
        out.append("_" if ch in '<>:"/\\|?*' else ch)
    return "".join(out).strip()[:120] or "untitled"


def _run_pipeline(job_id, input_path, ext, job_dir):
    job = jobs.get(job_id)
    if job is None:
        return
    original_path = os.path.join(job_dir, "score_original.musicxml")
    suggested_path = os.path.join(job_dir, "score_suggested.musicxml")
    working_path = os.path.join(job_dir, "score.musicxml")
    omr_dir = os.path.join(job_dir, "omr")
    try:
        sheet_pipeline.normalize_input(input_path, ext, original_path, omr_dir=omr_dir)
        counts = sheet_pipeline.run_suggestions(original_path, suggested_path)
        shutil.copyfile(suggested_path, working_path)
        with jobs_lock:
            job["status"] = "done"
            job["pedalCount"] = counts["pedalCount"]
            job["dynamicsCount"] = counts["dynamicsCount"]
            _persist(job_id)
    except ValueError as e:
        with jobs_lock:
            job["status"] = "error"
            job["error"] = str(e)
            _persist(job_id)
    except Exception as e:
        with jobs_lock:
            job["status"] = "error"
            job["error"] = "could not parse score: " + str(e)
            _persist(job_id)


@router.post("")
async def create_sheet_job(file: UploadFile = File(...)):
    name = file.filename or "untitled"
    ext = os.path.splitext(name)[1].lower()
    job_id = uuid.uuid4().hex[:12]
    job_dir = _job_dir(job_id)
    os.makedirs(job_dir, exist_ok=True)
    input_path = os.path.join(job_dir, "input" + ext)
    with open(input_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    job = {
        "id": job_id,
        "name": os.path.splitext(name)[0],
        "status": "processing",
        "error": None,
        "pedalCount": 0,
        "dynamicsCount": 0,
        "edited": False,
        "createdAt": time.time(),
    }
    with jobs_lock:
        jobs[job_id] = job
        _persist(job_id)

    if ext == ".pdf":
        # OMR can take a while on a real score — run off-thread and let the
        # frontend poll, same pattern as the audio jobs in main.py.
        # MusicXML jobs are fast enough to just finish inline.
        omr_executor.submit(_run_pipeline, job_id, input_path, ext, job_dir)
    else:
        _run_pipeline(job_id, input_path, ext, job_dir)
    return jobs[job_id]


@router.get("")
def list_sheet_jobs():
    with jobs_lock:
        items = sorted(jobs.values(), key=lambda j: (j.get("createdAt") or 0, j["id"]))
    return items


@router.get("/{job_id}")
def get_sheet_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


@router.delete("/{job_id}")
def delete_sheet_job(job_id: str):
    with jobs_lock:
        jobs.pop(job_id, None)
    shutil.rmtree(_job_dir(job_id), ignore_errors=True)
    return {"ok": True}


@router.get("/{job_id}/musicxml")
def get_sheet_musicxml(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    path = os.path.join(_job_dir(job_id), "score.musicxml")
    if not os.path.exists(path):
        raise HTTPException(404, "score not ready")
    return FileResponse(path, media_type="application/vnd.recordare.musicxml+xml")


@router.put("/{job_id}/musicxml")
async def save_sheet_musicxml(job_id: str, file: UploadFile = File(...)):
    """Overwrite the working score with an edited MusicXML document (the
    editor re-serializes the whole score after a mark is moved/deleted/
    added and PUTs it back here)."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    path = os.path.join(_job_dir(job_id), "score.musicxml")
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    try:
        # Re-normalize regardless of whether the re-upload is plain XML or a
        # compressed .mxl — score.musicxml must always be plain for the
        # frontend's OSMD viewer to load it as text.
        root = mxml.load_musicxml_bytes(data)
    except Exception as e:
        raise HTTPException(400, "could not parse score: " + str(e))
    mxml.save_musicxml(root, path)
    pedal_count, dynamics_count = sheet_pipeline.count_marks(root)
    with jobs_lock:
        job["edited"] = True
        job["pedalCount"] = pedal_count
        job["dynamicsCount"] = dynamics_count
        _persist(job_id)
    return {"ok": True, "pedalCount": pedal_count, "dynamicsCount": dynamics_count}


@router.post("/{job_id}/reset")
def reset_sheet_job(job_id: str):
    """Discard user edits, restore the score to right-after-suggestions."""
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    job_dir = _job_dir(job_id)
    suggested_path = os.path.join(job_dir, "score_suggested.musicxml")
    if not os.path.exists(suggested_path):
        raise HTTPException(409, "no suggested version to reset to")
    shutil.copyfile(suggested_path, os.path.join(job_dir, "score.musicxml"))
    pedal_count, dynamics_count = sheet_pipeline.count_marks(
        mxml.load_musicxml(suggested_path))
    with jobs_lock:
        job["pedalCount"] = pedal_count
        job["dynamicsCount"] = dynamics_count
        job["edited"] = False
        _persist(job_id)
    return job


@router.get("/{job_id}/export")
def export_sheet_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    path = os.path.join(_job_dir(job_id), "score.musicxml")
    if not os.path.exists(path):
        raise HTTPException(404, "score not ready")
    filename = _safe_name(job["name"]) + ".musicxml"
    return FileResponse(
        path, media_type="application/vnd.recordare.musicxml+xml",
        filename=filename)
