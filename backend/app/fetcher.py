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
# Only used when no real gap between tracks is found near the mark (below).
RING_PAD_SEC = 4.0

# Chapter marks on album uploads are often seconds off, so each split job
# looks for the actual silence between tracks around every mark and cuts
# there instead. Searched further ahead than behind: an early mark (song's
# last notes chopped) is the common failure, and pulling a boundary earlier
# risks cutting a final chord that follows a dramatic pause.
GAP_SEARCH_BACK_SEC = 4.0
GAP_SEARCH_FWD_SEC = 15.0
# Kept after a song's sound has decayed into the gap (unless the next track
# starts sooner), so the last note's ring isn't clipped by the cut.
RING_TAIL_SEC = 2.0
# Kept before the next track's first attack when it becomes a song's start.
GAP_LEAD_SEC = 0.2

_SCAN_SR = 22050
_FRAME_SEC = 0.02
# A frame is gap-quiet this far below the window's loud level (95th pct),
# but anything under the absolute floor always counts (quiet masters).
_GAP_DB = 35.0
_SILENCE_FLOOR_DB = -65.0
_MIN_GAP_SEC = 0.25
_BLIP_SEC = 0.1      # clicks/noise this short inside a gap don't split it
_DIST_DB_PER_SEC = 2.0  # candidate gaps: deeper wins, nearer the mark breaks ties

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


# Hard cap on how many playlist entries we expand. YouTube "Mix"/radio lists
# (list=RD…) are auto-generated and effectively endless; without a ceiling a
# flat extract of one would try to enumerate hundreds of videos.
MAX_PLAYLIST = 200


def probe_playlist(url):
    """Return (playlist_title, [{"url", "title"}, ...]) for a playlist link
    without downloading any media. Uses a *flat* extract — it reads only the
    playlist page(s), not each video — so it stays fast even for long lists.

    Empty list means the link isn't a playlist (or exposes no entries); the
    caller should fall back to the single-video path."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",  # don't recurse into each video
        "playlistend": MAX_PLAYLIST,
        "skip_download": True,
        "js_runtimes": {"node": {}, "deno": {}},
    }
    info = _extract(opts, url, download=False)
    if info is None or "entries" not in info:
        return "", []  # a bare video link, not a playlist
    title = (info.get("title") or "playlist").strip()
    entries = []
    for e in info.get("entries") or []:
        if not e:
            continue
        u = e.get("url") or ""
        if not (u.startswith("http://") or u.startswith("https://")):
            vid = e.get("id")
            if not vid:
                continue  # nothing addressable
            u = "https://www.youtube.com/watch?v=" + vid
        entries.append({
            "url": u,
            "title": (e.get("title") or "").strip() or None,
        })
    return title, entries


def find_track_gap(x, sr, t0, mark):
    """Locate the silence between two tracks near a chapter mark.

    x: mono float samples starting at absolute time t0 (seconds), covering a
    window around `mark`. Returns (quiet_from, next_at) in absolute seconds —
    where the outgoing track's sound has decayed into the gap, and where the
    next track's first attack lands (None if nothing starts again before the
    window ends) — or None when there's no convincing gap (crossfaded tracks,
    applause, or a window too short to judge); callers keep the mark then.

    Deterministic in the window's audio alone, so the job ending at a mark
    and the job starting at it agree on the same gap.
    """
    import numpy as np

    hop = int(sr * _FRAME_SEC)
    n = len(x) // hop
    if n < int(1.0 / _FRAME_SEC):
        return None
    frames = np.asarray(x[:n * hop], dtype=np.float64).reshape(n, hop)
    db = 10.0 * np.log10(np.mean(frames * frames, axis=1) + 1e-12)
    ref = float(np.percentile(db, 95))
    thr = max(ref - _GAP_DB, _SILENCE_FLOOR_DB)
    if thr >= ref - 10.0:
        return None  # nothing loud in the window to separate

    quiet = db < thr
    runs = []
    i = 0
    while i < n:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < n and quiet[j]:
            j += 1
        if runs and (i - runs[-1][1]) * _FRAME_SEC <= _BLIP_SEC:
            runs[-1][1] = j
        else:
            runs.append([i, j])
        i = j

    best, best_score = None, None
    for i0, i1 in runs:
        if (i1 - i0) * _FRAME_SEC < _MIN_GAP_SEC:
            continue
        a = t0 + i0 * _FRAME_SEC
        b = t0 + i1 * _FRAME_SEC
        dist = max(0.0, a - mark, mark - b)
        depth = max(float(np.percentile(db[i0:i1], 10)), -100.0)
        score = depth + _DIST_DB_PER_SEC * dist
        if best_score is None or score < best_score:
            best, best_score = (i0, i1), score
    if best is None:
        return None
    i0, i1 = best
    quiet_from = t0 + i0 * _FRAME_SEC
    next_at = t0 + i1 * _FRAME_SEC if i1 < n else None
    return round(quiet_from, 3), (round(next_at, 3) if next_at is not None
                                  else None)


def _scan_mono(source, t0, t1):
    """Decode [t0, t1) seconds of `source` to mono float32 at _SCAN_SR for
    gap analysis. Returns (samples, actual_t0) or None on failure."""
    import numpy as np

    t0 = max(0.0, t0)
    if t1 <= t0:
        return None
    proc = subprocess.run(
        [pipeline.FFMPEG_EXE, "-v", "error", "-ss", "%.3f" % t0, "-i", source,
         "-t", "%.3f" % (t1 - t0), "-vn", "-ac", "1", "-ar", str(_SCAN_SR),
         "-f", "f32le", "-"],
        capture_output=True)
    if proc.returncode != 0 or not proc.stdout:
        return None
    return np.frombuffer(proc.stdout, dtype=np.float32), t0


def _gap_near(source, mark):
    scan = _scan_mono(source, mark - GAP_SEARCH_BACK_SEC,
                      mark + GAP_SEARCH_FWD_SEC)
    if scan is None:
        return None
    x, t0 = scan
    return find_track_gap(x, _SCAN_SR, t0, mark)


def refine_section(source, start, end):
    """Snap an album chapter's marks to the real gaps between tracks.

    Returns (song_start, song_end, keep_end) in source seconds: decode
    [song_start, keep_end); notes struck at/after song_end never play.
    With a gap found, the song ends RING_TAIL_SEC after its sound decays
    (or just before the next track, if sooner) and nothing past that is
    kept. Without one, the marks stand and RING_PAD_SEC of audio is kept
    past the end so the ring-out still reaches transcription.
    """
    song_start, song_end, keep_end = start, end, end + RING_PAD_SEC
    try:
        if start >= 0.5:  # first track has nothing before it to split from
            gap = _gap_near(source, start)
            if gap and gap[1] is not None and gap[1] < end:
                song_start = max(0.0, gap[1] - GAP_LEAD_SEC)
        gap = _gap_near(source, end)
        if gap:
            quiet_from, next_at = gap
            cut = quiet_from + RING_TAIL_SEC
            if next_at is not None:
                cut = min(cut, next_at - 0.1)
            if cut > song_start + 1.0:
                song_end = keep_end = cut
    except Exception:
        pass  # best-effort: a failed scan just keeps the marks as given
    return song_start, song_end, keep_end


def download_audio(url, job_dir, progress_cb, include_video=False,
                    section=None):
    """Download `url` into job_dir and decode audio to input.wav (44.1 kHz
    stereo PCM). Returns (wav_path, title, video_name, song_len) —
    video_name is the kept video file's basename (include_video=True), else
    None; song_len is the section's playable length (None without one).

    section=(start, end) seconds selects one chapter of an album-as-one-video
    (per-chapter split jobs). The whole source is still downloaded; the slice
    is cut locally afterwards (see below), with the marks first snapped to the
    real gaps between tracks (refine_section). When no gap is found the kept
    slice is padded past `end` by RING_PAD_SEC so the final chord's ring-out
    is present for transcription; the pipeline caps the export window at
    song_len so any next-track notes caught in the pad never play."""
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
    # A section job downloads the whole source, not just the slice: yt-dlp's
    # range download hands the raw googlevideo URL to a bare ffmpeg, which
    # YouTube now 403s — that URL is bound to the extractor client's
    # User-Agent and ffmpeg sends the generic web one. The full download uses
    # yt-dlp's native HTTP path (correct per-format headers); the chapter is
    # cut locally below, where no 403 is possible.
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

    # Chapter slice cut from the local file. -ss before -i seeks the input
    # and -t bounds the decoded duration, so the WAV starts at the song's
    # start (t=0 in the output), exactly as the old range download produced.
    seek, dur = [], []
    song_len = None
    if section:
        song_start, song_end, keep_end = refine_section(source, *section)
        song_len = song_end - song_start
        seek = ["-ss", "%.3f" % song_start]
        dur = ["-t", "%.3f" % (keep_end - song_start)]

    progress_cb("downloading", 92)
    wav_path = os.path.join(job_dir, "input.wav")
    proc = subprocess.run(
        [pipeline.FFMPEG_EXE, "-y", *seek, "-i", source, *dur, "-vn",
         "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav_path],
        capture_output=True)
    if proc.returncode != 0 or not os.path.exists(wav_path):
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("audio decode failed: " +
                           (tail[-1] if tail else "ffmpeg error"))

    video_name = None
    if include_video:
        # Keep the download as the job's video, under a stable name.
        video_name = "video" + os.path.splitext(source)[1].lower()
        video_path = os.path.join(job_dir, video_name)
        if section:
            # Match the video to the chapter so the Play tab and the
            # backing-track mux line up with the sliced audio. Keyframe
            # stream-copy (fast, lossless); any sub-keyframe lead is absorbed
            # by the Play tab's sync-offset control.
            vproc = subprocess.run(
                [pipeline.FFMPEG_EXE, "-y", *seek, "-i", source, *dur,
                 "-c", "copy", video_path],
                capture_output=True)
            if vproc.returncode != 0 or not os.path.exists(video_path):
                os.replace(source, video_path)  # untrimmed beats failing
            else:
                os.remove(source)
        else:
            os.replace(source, video_path)
    else:
        os.remove(source)
    progress_cb("downloading", 100)
    return wav_path, title, video_name, song_len
