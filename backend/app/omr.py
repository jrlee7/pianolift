"""Optical music recognition: PDF -> MusicXML via Audiveris (external Java
CLI, not a Python dependency — https://github.com/Audiveris/audiveris).
Audiveris must be installed separately; this module just finds and drives it.
"""

import glob
import os
import shutil
import subprocess

_CANDIDATE_PATHS = [
    r"C:\Program Files\Audiveris\Audiveris.exe",
    r"C:\Program Files (x86)\Audiveris\Audiveris.exe",
]


def find_audiveris():
    """Path to the Audiveris executable, or None if it isn't installed."""
    on_path = shutil.which("Audiveris") or shutil.which("Audiveris.exe")
    if on_path:
        return on_path
    for path in _CANDIDATE_PATHS:
        if os.path.exists(path):
            return path
    return None


class OmrError(ValueError):
    """A recognition failure with a message that's safe to show the user
    (subclasses ValueError so sheet_routes' existing error handling, which
    treats ValueError messages as user-facing, picks it up for free)."""


def run_omr(pdf_path, out_dir, timeout=900):
    """Run Audiveris on pdf_path in batch mode, exporting MusicXML into
    out_dir. Returns the path to the produced .mxl/.xml file. Raises
    OmrError with a message safe to show the user on any failure (missing
    binary, timeout, recognition failure, no output produced)."""
    exe = find_audiveris()
    if exe is None:
        raise OmrError(
            "Audiveris (the PDF sheet-music recognizer) isn't installed. "
            "Install it from https://github.com/Audiveris/audiveris/releases "
            "and try again.")
    os.makedirs(out_dir, exist_ok=True)
    try:
        result = subprocess.run(
            [exe, "-batch", "-export", "-output", out_dir, "--", pdf_path],
            capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise OmrError(
            "Recognition took too long (over %d minutes) and was stopped — "
            "the file may be too large or too complex." % (timeout // 60))
    except OSError as e:
        raise OmrError("Could not run Audiveris: " + str(e))

    stem = os.path.splitext(os.path.basename(pdf_path))[0]
    for ext in (".mxl", ".xml", ".musicxml"):
        candidate = os.path.join(out_dir, stem + ext)
        if os.path.exists(candidate):
            return candidate
    # Fall back to whatever landed in out_dir, in case Audiveris sanitized
    # the stem differently than we expect.
    hits = (glob.glob(os.path.join(out_dir, "*.mxl")) +
            glob.glob(os.path.join(out_dir, "*.xml")))
    if hits:
        return hits[0]

    raise OmrError(
        "Recognition finished but produced no MusicXML — the file may not "
        "be readable as music notation (make sure it's an actual PDF "
        "containing sheet music, not a scan/photo saved with the wrong "
        "extension).")
