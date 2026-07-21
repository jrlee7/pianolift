"""Merge per-page MusicXML scores (from the per-page OMR fallback in
omr.py) back into a single <score-partwise> document.

Each page was recognized as its own little score, so each has its own
<part-list>, its own measure numbering, and possibly its own <divisions>
resolution. The merge keeps the first surviving page as the base document
and appends every later page's measures onto the base parts. Parts are
matched **bottom-aligned** (base_parts[-1] takes the page's last part and
so on): engraving keeps the piano grand staff at the bottom of every
system, while OMR sometimes hallucinates an extra empty part at the top
of one page — top-aligned index matching would shift every real part on
the other pages. Base parts a page has no counterpart for are padded with
empty measures so every part keeps the same measure count (viewers like
OSMD require rectangular scores). Each appended chunk's first measure is
made to declare its own <divisions> explicitly — MusicXML allows
mid-score divisions changes, which sidesteps any duration rescaling — and
measures are renumbered sequentially at the end.
"""

import xml.etree.ElementTree as ET


def merge_scores(pages):
    """pages: non-empty list of (page_number, score_root) in page order.
    Returns (merged_root, warnings). Mutates and returns the first page's
    tree; later pages' measure elements are re-parented into it."""
    _, base_root = pages[0]
    base_parts = base_root.findall("part")
    dropped_pages = []   # pages whose extra top parts were discarded
    padded_parts = {}    # base part index -> [page numbers left blank]

    for page_no, root in pages[1:]:
        parts = root.findall("part")
        # Bottom-aligned: base part i pairs with the page part that sits at
        # the same distance from the bottom of the system.
        shift = len(base_parts) - len(parts)
        if shift < 0:
            dropped_pages.append(page_no)
        page_len = _page_measure_count(parts)
        for idx, base_part in enumerate(base_parts):
            page_idx = idx - shift
            if 0 <= page_idx < len(parts):
                _append_part(base_part, parts[page_idx])
            else:
                _append_blank(base_part, page_len)
                padded_parts.setdefault(idx, []).append(page_no)

    for base_part in base_parts:
        for i, measure in enumerate(base_part.findall("measure")):
            measure.set("number", str(i + 1))

    warnings = []
    if dropped_pages:
        warnings.append(
            "Extra staves on page%s %s were dropped during merge."
            % ("" if len(dropped_pages) == 1 else "s",
               ", ".join(str(p) for p in dropped_pages)))
    for idx, page_nos in sorted(padded_parts.items()):
        warnings.append(
            "Staff/part %d wasn't found on page%s %s — left blank there."
            % (idx + 1, "" if len(page_nos) == 1 else "s",
               ", ".join(str(p) for p in page_nos)))
    return base_root, warnings


def _page_measure_count(parts):
    """Measures per part on this page (parts of one score share a count;
    take the max in case OMR disagreed with itself)."""
    count = 0
    for part in parts:
        count = max(count, len(part.findall("measure")))
    return count


def _append_part(base_part, page_part):
    measures = page_part.findall("measure")
    if not measures:
        return
    _ensure_divisions_declared(measures)
    for measure in measures:
        base_part.append(measure)


def _append_blank(base_part, count):
    """Pad with empty measures so every part keeps the same length —
    an empty <measure> reads as a silent bar."""
    for _ in range(count):
        base_part.append(ET.Element("measure"))


def _ensure_divisions_declared(measures):
    """Make the chunk's first measure declare the <divisions> its durations
    are written in, so they aren't reinterpreted under the previous page's
    resolution once concatenated."""
    first = measures[0]
    attributes = first.find("attributes")
    if attributes is not None and attributes.find("divisions") is not None:
        return  # already explicit (the usual Audiveris output)
    value = None
    for measure in measures:
        div = measure.find("attributes/divisions")
        if div is not None and div.text:
            value = div.text
            break
    if value is None:
        value = "1"  # MusicXML's implied default
    if attributes is None:
        attributes = ET.Element("attributes")
        first.insert(0, attributes)
    div = ET.Element("divisions")
    div.text = value
    attributes.insert(0, div)  # DTD wants divisions first inside attributes
