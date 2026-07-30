"""Fetch audio from a URL (YouTube, Facebook, Instagram — anything yt-dlp
supports) and decode it once to WAV for the pipeline.

WAV instead of MP3: the platform stream (usually Opus or AAC) is already
lossy; decoding straight to PCM avoids a second lossy generation that would
smear the transients the transcription model keys on, and sidesteps MP3
encoder start-delay on the input entirely.

include_video=True additionally keeps the full video (muxed mp4) in the job
dir for the video-sync Play tab — the WAV is decoded from that same download,
so audio and video can never come from different renditions/timelines.
"""

import os
import subprocess
import sys

from . import pipeline

# Extra seconds downloaded past a chapter's end so the final chord's pedal
# ring-out (which decays across the chapter boundary) reaches transcription.
RING_PAD_SEC = 4.0

# A user-exported cookies.txt (Netscape format) lives beside the jobs dir, so
# the same path works in dev and in the packaged exe. Mirrors main.BASE_DIR;
# not imported from there because app.main pulls in the whole server.
if getattr(sys, "frozen", False):
    _DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", "."),
                             "PianoForge", "data")
else:
    _DATA_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COOKIES_TXT = os.path.join(_DATA_DIR, "cookies.txt")

# Substrings of the errors platforms return when they want proof of a
# logged-in human rather than the media: YouTube's bot check, age gates,
# members-only videos, and the bare 403 its gated format URLs answer with.
_GATE_SIGNS = (
    "not a bot", "sign in to confirm", "sign in to view", "login required",
    "confirm your age", "age-restricted", "members-only", "private video",
    "account cookies", "http error 403", "use --cookies",
)

_COOKIE_HINT = (
    "YouTube is asking this machine to prove it's a signed-in human. "
    "Log into YouTube in Firefox (Chrome/Edge cookies are locked on Windows), "
    "or export a cookies.txt from a logged-in browser to " + COOKIES_TXT
)


# How yt-dlp complains about the cookie source itself (browser absent,
# profile missing, DB locked or App-Bound encrypted) rather than the site.
_COOKIE_SOURCE_SIGNS = (
    "could not find", "unsupported browser", "cookies database",
    "failed to decrypt", "no such file", "permission denied", "keyring",
    "does not support", "profile",
)


def _is_gated(msg):
    low = msg.lower()
    return any(s in low for s in _GATE_SIGNS)


def _is_cookie_source_error(msg):
    low = msg.lower()
    return any(s in low for s in _COOKIE_SOURCE_SIGNS)


def _cookie_sources():
    """Cookie fallbacks to try, best first.

    An explicit cookies.txt beats guessing. Browser extraction is a coin
    flip on Windows: Chrome 127+ (and Edge/Brave, same engine) seal the
    cookie DB with App-Bound Encryption that yt-dlp can't open while the
    browser holds the key, so Firefox is the one that usually works.
    """
    if os.path.exists(COOKIES_TXT):
        yield {"cookiefile": COOKIES_TXT}
    for browser in ("firefox", "chrome", "edge", "brave", "chromium",
                    "opera", "vivaldi"):
        yield {"cookiesfrombrowser": (browser, None, None, None)}


def _extract(opts, url, download):
    """yt-dlp extract_info, retried with each cookie source when the site
    answers with a sign-in/bot gate instead of the media.

    Cookie attempts swallow their own failures (browser not installed,
    profile missing, cookie DB locked) and move on; only the original
    gate error is reported, with instructions, if every source is exhausted.
    """
    import yt_dlp  # lazy: heavy import, keeps server startup fast

    def run(extra):
        with yt_dlp.YoutubeDL(dict(opts, **extra)) as ydl:
            return ydl.extract_info(url, download=download)

    try:
        return run({})
    except Exception as e:
        first = (str(e) or repr(e)).splitlines()[0]
        if not _is_gated(first):
            raise

    for extra in _cookie_sources():
        try:
            return run(extra)
        except Exception as e:
            msg = (str(e) or repr(e)).splitlines()[0]
            if _is_gated(msg) or _is_cookie_source_error(msg):
                continue  # still gated, or that source is unreadable
            raise  # the cookies got us past the gate onto a real failure
    raise RuntimeError(_COOKIE_HINT)


def probe_chapters(url):
    """Return (title, [{"title", "start", "end"}, ...]) for `url` without
    downloading anything. Empty chapter list means the video has none (or
    the platform doesn't expose them) — caller should fall back to a single
    whole-video job."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "js_runtimes": {"node": {}, "deno": {}},
    }
    info = _extract(opts, url, download=False)
    if info is None:
        raise RuntimeError("nothing found at that link")
    if "entries" in info:
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise RuntimeError("nothing found at that link")
        info = entries[0]
    title = (info.get("title") or "untitled").strip()
    chapters = []
    for ch in (info.get("chapters") or []):
        start = ch.get("start_time")
        end = ch.get("end_time")
        if start is None or end is None:
            continue
        chapters.append({
            "title": (ch.get("title") or "").strip() or None,
            "start": start,
            "end": end,
        })
    return title, chapters


def download_audio(url, job_dir, progress_cb, include_video=False,
                    section=None):
    """Download `url` into job_dir and decode audio to input.wav (44.1 kHz
    stereo PCM). Returns (wav_path, title, video_name) — video_name is the
    kept video file's basename (include_video=True), else None.

    section=(start, end) seconds restricts the download to that slice of the
    source (used to split an album-as-one-video into per-chapter jobs). The
    slice is padded past `end` by RING_PAD_SEC so the final chord's pedal
    ring-out — which crosses the chapter boundary — is present in the audio
    for transcription; the pipeline caps the export window at the unpadded
    boundary so any next-track notes caught in the pad never play."""
    from yt_dlp.utils import download_range_func  # lazy: heavy import

    pipeline._ensure_ffmpeg(lambda stage, pct: None)

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes")
            if total and done is not None:
                progress_cb("downloading", min(90, int(done * 90 / total)))

    opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(job_dir, "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "ffmpeg_location": pipeline.FFMPEG_DIR,
        # YouTube gates format URLs behind JS challenges; without a JS
        # runtime yt-dlp falls back to clients that 403 on many videos.
        # Enable whichever of node/deno exists (unavailable ones are
        # skipped). Needs yt-dlp[default] for the bundled EJS solver.
        "js_runtimes": {"node": {}, "deno": {}},
    }
    if section:
        start, end = section
        opts["download_ranges"] = download_range_func(
            None, [(start, end + RING_PAD_SEC)])
        opts["force_keyframes_at_cuts"] = True
    if include_video:
        # Best video+audio muxed into mp4 (Chromium-playable, incl. vp9).
        # Cap at 1080p — the TV doesn't need 4K and the files quadruple.
        opts["format"] = ("bestvideo[height<=1080]+bestaudio"
                          "/best[height<=1080]/best")
        opts["merge_output_format"] = "mp4"

    info = _extract(opts, url, download=True)
    if info is None:
        raise RuntimeError("nothing downloadable at that link")
    if "entries" in info:  # playlist page despite noplaylist
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise RuntimeError("nothing downloadable at that link")
        info = entries[0]
    title = (info.get("title") or "untitled").strip()

    # A gated first attempt can leave half-written source.<ext>.part /
    # .ytdl scratch files behind; only a finished download is the media.
    source = None
    for f in os.listdir(job_dir):
        if f.startswith("source.") and not f.endswith((".part", ".ytdl")):
            source = os.path.join(job_dir, f)
            break
    if source is None:
        raise RuntimeError("download finished but media file missing")

    progress_cb("downloading", 92)
    wav_path = os.path.join(job_dir, "input.wav")
    proc = subprocess.run(
        [pipeline.FFMPEG_EXE, "-y", "-i", source, "-vn",
         "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav_path],
        capture_output=True)
    if proc.returncode != 0 or not os.path.exists(wav_path):
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("audio decode failed: " +
                           (tail[-1] if tail else "ffmpeg error"))

    video_name = None
    if include_video:
        # Keep the download itself as the job's video, under a stable name.
        video_name = "video" + os.path.splitext(source)[1].lower()
        os.replace(source, os.path.join(job_dir, video_name))
    else:
        os.remove(source)
    progress_cb("downloading", 100)
    return wav_path, title, video_name
