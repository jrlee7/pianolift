"""Sheet-music job pipeline: normalize an uploaded score to MusicXML, run
the pedal/dynamics suggestion engines, and persist results. Unlike the
audio pipeline (pipeline.py/job_runner.py) this is plain synchronous
parsing + heuristics on an XML tree, no ML model, so it needs none of the
child-process/queue machinery main.py uses for the heavy audio jobs.
"""

from . import musicxml_io as mxml
from . import pedal_engine
from . import dynamics_engine
from . import omr

SCORE_EXTS = {".musicxml", ".xml", ".mxl"}


def normalize_input(input_path, ext, out_musicxml_path, omr_dir=None):
    """Convert an uploaded score into plain MusicXML at out_musicxml_path.
    A .pdf is run through Audiveris (OMR) first — needs omr_dir for its
    intermediate output. Raises ValueError/omr.OmrError for anything that
    fails (unsupported type, OMR not installed, recognition failure)."""
    if ext == ".pdf":
        mxl_path = omr.run_omr(input_path, omr_dir)
        root = mxml.load_musicxml(mxl_path)
    elif ext in SCORE_EXTS:
        root = mxml.load_musicxml(input_path)
    else:
        raise ValueError("unsupported file type: " + ext)
    mxml.save_musicxml(root, out_musicxml_path)


def count_marks(root):
    """Count pedal marks and dynamics/wedge marks currently in the score
    (any part) — used to refresh a job's displayed stats after a hand-edited
    MusicXML file is re-uploaded, since that bypasses the suggestion
    engines' own counts."""
    pedal_count = 0
    dynamics_count = 0
    for direction in root.iter("direction"):
        for dtype in direction.findall("direction-type"):
            if dtype.find("pedal") is not None:
                pedal_count += 1
            if dtype.find("dynamics") is not None or dtype.find("wedge") is not None:
                dynamics_count += 1
    return pedal_count, dynamics_count


def run_suggestions(src_musicxml_path, out_musicxml_path):
    """Run pedal + dynamics engines on the score at src_musicxml_path,
    write the result to out_musicxml_path (may be the same path). Returns
    {'pedalCount', 'dynamicsCount'}."""
    root = mxml.load_musicxml(src_musicxml_path)
    pedal_count = pedal_engine.suggest_pedal(root)
    dynamics_count = dynamics_engine.suggest_dynamics(root)
    mxml.save_musicxml(root, out_musicxml_path)
    return {"pedalCount": pedal_count, "dynamicsCount": dynamics_count}
