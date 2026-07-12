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

from . import pipeline


def download_audio(url, job_dir, progress_cb, include_video=False):
    """Download `url` into job_dir and decode audio to input.wav (44.1 kHz
    stereo PCM). Returns (wav_path, title, video_name) — video_name is the
    kept video file's basename (include_video=True), else None."""
    import yt_dlp  # lazy: heavy import, keeps server startup fast

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
    if include_video:
        # Best video+audio muxed into mp4 (Chromium-playable, incl. vp9).
        # Cap at 1080p — the TV doesn't need 4K and the files quadruple.
        opts["format"] = ("bestvideo[height<=1080]+bestaudio"
                          "/best[height<=1080]/best")
        opts["merge_output_format"] = "mp4"

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    if info is None:
        raise RuntimeError("nothing downloadable at that link")
    if "entries" in info:  # playlist page despite noplaylist
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise RuntimeError("nothing downloadable at that link")
        info = entries[0]
    title = (info.get("title") or "untitled").strip()

    source = None
    for f in os.listdir(job_dir):
        if f.startswith("source."):
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
