"""Optical music recognition: PDF -> MusicXML via Audiveris (external Java
CLI, not a Python dependency — https://github.com/Audiveris/audiveris).
Audiveris must be installed separately; this module just finds and drives it.

Recognition strategy: try the whole PDF in one Audiveris run first (fastest,
and the normal case). Audiveris refuses to export the book when ANY page
fails internally (e.g. a NullPointerException on one messy scanned page kills
the export of all pages), so on whole-book failure we fall back to splitting
the PDF and recognizing page by page: unreadable pages are skipped with a
warning and the surviving pages are merged back into one score
(musicxml_merge.py).

Image-based (scanned) PDFs skip the whole-book path entirely and go
straight to per-page recognition on *preprocessed* page images
(page_image.py) — cleaning/upscaling the embedded scan measurably improves
Audiveris' note and rhythm reading over letting it rasterize a noisy
low-DPI JPEG itself.
"""

import glob
import os
import shutil
import subprocess

from pypdf import PdfReader, PdfWriter

from . import musicxml_io as mxml
from . import musicxml_merge
from . import page_image

_CANDIDATE_PATHS = [
    r"C:\Program Files\Audiveris\Audiveris.exe",
    r"C:\Program Files (x86)\Audiveris\Audiveris.exe",
]

# A single page is a much smaller job than a book; if one page runs this
# long something is wrong with it and the other pages shouldn't wait.
PAGE_TIMEOUT = 240


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


def _find_output(input_path, out_dir):
    """Locate the MusicXML file an Audiveris run left in out_dir, or None."""
    stem = os.path.splitext(os.path.basename(input_path))[0]
    for ext in (".mxl", ".xml", ".musicxml"):
        candidate = os.path.join(out_dir, stem + ext)
        if os.path.exists(candidate):
            return candidate
    # Fall back to whatever landed in out_dir, in case Audiveris sanitized
    # the stem differently than we expect.
    hits = (glob.glob(os.path.join(out_dir, "*.mxl")) +
            glob.glob(os.path.join(out_dir, "*.xml")))
    return hits[0] if hits else None


def _run_audiveris(exe, input_path, out_dir, timeout):
    """One Audiveris batch run. Returns the produced MusicXML path, or None
    when recognition failed or timed out (both are recoverable via the
    per-page fallback). Raises OmrError only when Audiveris can't launch."""
    os.makedirs(out_dir, exist_ok=True)
    try:
        subprocess.run(
            [exe, "-batch", "-export", "-output", out_dir, "--", input_path],
            capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    except OSError as e:
        raise OmrError("Could not run Audiveris: " + str(e))
    return _find_output(input_path, out_dir)


def _log_tail(out_dir, max_lines=5):
    """Last few WARN/error lines from the newest Audiveris log under
    out_dir — appended to total-failure messages so the UI can say *why*."""
    logs = glob.glob(os.path.join(out_dir, "*.log"))
    logs += glob.glob(os.path.join(out_dir, "pages", "*", "*.log"))
    if not logs:
        return ""
    newest = max(logs, key=os.path.getmtime)
    try:
        with open(newest, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return ""
    keep = [ln.strip() for ln in lines
            if ("WARN" in ln or "SEVERE" in ln or "Exception" in ln
                or "Caused by" in ln)]
    if not keep:
        keep = [ln.strip() for ln in lines if ln.strip()]
    tail = keep[-max_lines:]
    return (" Recognizer log: " + " | ".join(tail)) if tail else ""


def run_omr(pdf_path, out_dir, timeout=900, on_progress=None):
    """Run Audiveris on pdf_path, exporting MusicXML into out_dir.

    Returns (musicxml_path, warnings). Tries the whole book first; on
    failure retries page by page, skipping unreadable pages (each skip adds
    a warning) and merging the rest. Raises OmrError with a user-facing
    message when nothing at all could be recognized (missing binary,
    every page failed, ...). on_progress(page, total) is called during the
    per-page fallback so the UI can show which page is being recognized.
    """
    exe = find_audiveris()
    if exe is None:
        raise OmrError(
            "Audiveris (the PDF sheet-music recognizer) isn't installed. "
            "Install it from https://github.com/Audiveris/audiveris/releases "
            "and try again.")
    os.makedirs(out_dir, exist_ok=True)

    # A scanned PDF reads much better page-by-page on cleaned images than as
    # a whole-book raster, so skip straight to the preprocessed per-page
    # path. Native/vector PDFs take the fast whole-book path first.
    try:
        reader = PdfReader(pdf_path)
        scanned = page_image.is_scanned_pdf(reader)
    except Exception:
        reader, scanned = None, False

    if not scanned:
        produced = _run_audiveris(exe, pdf_path, out_dir, timeout)
        if produced is not None:
            return produced, []
    return _run_paged(exe, pdf_path, out_dir, on_progress, reader=reader,
                      preprocess=scanned)


def _run_paged(exe, pdf_path, out_dir, on_progress, reader=None,
               preprocess=False):
    """Per-page fallback: recognize each page in its own Audiveris run and
    merge whatever succeeded. When `preprocess` is set, each page is cleaned
    into an upscaled binarized PNG first (page_image.py) for sharper
    recognition; otherwise Audiveris rasterizes a split-out page PDF.
    Returns (path, warnings)."""
    try:
        if reader is None:
            reader = PdfReader(pdf_path)
        total = len(reader.pages)
    except Exception as e:
        raise OmrError("Could not read the PDF file: " + str(e))

    if total < 1:
        raise OmrError(
            "Recognition failed — the page may not be readable as music "
            "notation (make sure it's an actual PDF containing sheet music, "
            "not a photo saved with the wrong extension)." +
            _log_tail(out_dir))

    pages_dir = os.path.join(out_dir, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    warnings = []
    survivors = []  # (page_number, parsed MusicXML root)

    for i in range(total):
        page_no = i + 1
        if on_progress:
            try:
                on_progress(page_no, total)
            except Exception:
                pass
        page_out = os.path.join(pages_dir, "out%d" % page_no)
        page_input = None
        if preprocess:
            png = os.path.join(pages_dir, "page%d.png" % page_no)
            if page_image.preprocess_page(reader, i, png):
                page_input = png
        if page_input is None:
            # Vector page, or preprocessing didn't find a dominant image:
            # let Audiveris rasterize the split-out single-page PDF.
            page_pdf = os.path.join(pages_dir, "page%d.pdf" % page_no)
            try:
                writer = PdfWriter()
                writer.add_page(reader.pages[i])
                with open(page_pdf, "wb") as f:
                    writer.write(f)
                page_input = page_pdf
            except Exception:
                warnings.append("Page %d couldn't be split out of the PDF — "
                                "skipped." % page_no)
                continue
        produced = _run_audiveris(exe, page_input, page_out, PAGE_TIMEOUT)
        if produced is None:
            warnings.append("Page %d couldn't be read (recognition error) — "
                            "skipped." % page_no)
            continue
        try:
            root = mxml.load_musicxml(produced)
        except Exception:
            warnings.append("Page %d produced an unreadable score — "
                            "skipped." % page_no)
            continue
        survivors.append((page_no, root))

    if not survivors:
        raise OmrError(
            "Recognition failed on every page — the file may not be "
            "readable as music notation (make sure it's an actual PDF "
            "containing sheet music, not a scan/photo saved with the wrong "
            "extension)." + _log_tail(out_dir))

    merged, merge_warnings = musicxml_merge.merge_scores(survivors)
    warnings.extend(merge_warnings)
    merged_path = os.path.join(out_dir, "merged.musicxml")
    mxml.save_musicxml(merged, merged_path)
    return merged_path, warnings
