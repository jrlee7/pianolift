"""Scan preprocessing for OMR.

Scanned sheet-music PDFs (the "Acrobat Image Conversion" kind) embed one
lossy grayscale JPEG per page, often only ~200 DPI. Audiveris rasterizes
and binarizes that internally, but on a noisy low-DPI JPEG its glyph and
rhythm recognition degrades badly (misread beams/flags/dots -> "no correct
rhythm", "time inconsistency"). Feeding Audiveris a cleaned, upscaled,
pre-binarized image instead measurably improves recognition and even
sidesteps some internal crashes on messy pages.

Pipeline per page: pull the embedded raster, grayscale, 2x Lanczos upscale
(more pixels for the classifier — doesn't add real detail but helps glyph
shaping), a light median denoise, then a global Otsu threshold to crisp
black-on-white. Saved as a PNG tagged 400 DPI so Audiveris scales staff
spacing sensibly.

Best-effort: if a page has no single dominant embedded image (vector PDFs,
multi-tile scans), the caller falls back to letting Audiveris rasterize
the page PDF itself.
"""

import numpy as np
from PIL import Image, ImageFilter, ImageOps

UPSCALE = 2
OUTPUT_DPI = 400
# A page is "image-based" (a scan) if the embedded raster covers most of
# it; below this the extracted image is probably a logo/decoration, not
# the page, so we leave rasterizing to Audiveris.
MIN_IMAGE_MEGAPIXELS = 1.0


def is_scanned_pdf(reader):
    """True when the PDF looks like a page-image scan rather than a
    native/vector score: its first page carries a big embedded raster and
    little or no extractable text."""
    try:
        page = reader.pages[0]
    except (IndexError, Exception):
        return False
    img = _dominant_image(page)
    if img is None:
        return False
    try:
        text = (page.extract_text() or "").strip()
    except Exception:
        text = ""
    # A real engraved/native PDF exposes its note/lyric text; a scan is a
    # flat image with essentially none.
    return len(text) < 40


def preprocess_page(reader, index, out_path):
    """Extract + clean page `index`'s embedded scan image to a PNG at
    out_path. Returns True on success, False if the page has no usable
    dominant image (caller should fall back to the page PDF)."""
    try:
        page = reader.pages[index]
        img = _dominant_image(page)
        if img is None:
            return False
        img = ImageOps.grayscale(img)
        w, h = img.size
        img = img.resize((w * UPSCALE, h * UPSCALE), Image.LANCZOS)
        img = img.filter(ImageFilter.MedianFilter(3))
        arr = np.asarray(img, dtype=np.uint8)
        thr = _otsu_threshold(arr)
        binar = np.where(arr > thr, 255, 0).astype(np.uint8)
        Image.fromarray(binar, "L").save(out_path, dpi=(OUTPUT_DPI, OUTPUT_DPI))
        return True
    except Exception:
        return False


def _dominant_image(page):
    """The one big embedded image that IS the page, or None. Picks the
    largest by pixel area and requires it to be sizable, so decorative
    images on a native PDF don't get mistaken for a scan."""
    try:
        images = list(page.images)
    except Exception:
        return None
    best = None
    best_px = 0
    for im in images:
        try:
            pil = im.image
            px = pil.size[0] * pil.size[1]
        except Exception:
            continue
        if px > best_px:
            best_px = px
            best = pil
    if best is None or best_px < MIN_IMAGE_MEGAPIXELS * 1_000_000:
        return None
    return best


def _otsu_threshold(arr):
    """Classic Otsu: the gray level that maximizes between-class variance."""
    hist = np.bincount(arr.reshape(-1), minlength=256).astype(np.float64)
    total = arr.size
    sum_all = np.dot(np.arange(256), hist)
    sum_b = 0.0
    w_b = 0.0
    best_var = 0.0
    threshold = 127
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        mean_b = sum_b / w_b
        mean_f = (sum_all - sum_b) / w_f
        var_between = w_b * w_f * (mean_b - mean_f) ** 2
        if var_between > best_var:
            best_var = var_between
            threshold = t
    return threshold
