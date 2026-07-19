"""Child-process entry for a single conversion.

The heavy stages (yt-dlp download, BS-Roformer separation, ByteDance
transcription) are opaque blocking calls that can't be interrupted
cooperatively, so each job runs in its own process the API can terminate
outright. Progress, the resolved name (URL jobs), and the final result flow
back to the parent over a multiprocessing Queue.

Kept in its own module (not app.main) so the "spawn" start method re-imports
only the pipeline here — importing app.main in every child would re-run the
server's module-level setup and spawn a second worker pool.
"""

import os

from . import pipeline

# Uploaded containers that carry a watchable video stream — kept in the job
# dir (as video.<ext>) so the Play tab can use them, instead of being deleted
# after the audio decode.
_VIDEO_EXTS = (".mp4", ".m4v", ".mkv", ".mov", ".webm")


def run_job_process(job_dir, kind, source, piano_only, q, include_video=False,
                     section=None, track_name=None):
    """kind == 'file': source is the absolute audio path.
       kind == 'url' : source is the link; download it first.
       include_video: keep the video stream for the video-sync Play tab.
       section=(start, end) seconds: download only that slice (album-split).
       track_name: fixed job name to use instead of the video's own title
       (album-split jobs share one video title otherwise)."""
    def cb(stage, pct):
        q.put(("progress", stage, pct))

    try:
        if kind == "url":
            from . import fetcher
            try:
                wav_path, title, video_name = fetcher.download_audio(
                    source, job_dir, cb, include_video=include_video,
                    section=section)
            except Exception as e:  # download failures get their own label
                msg = (str(e) or repr(e)).splitlines()[0]
                q.put(("error", "Download failed: " + msg))
                return
            # Let the parent record the resolved title + input filename.
            q.put(("meta", os.path.basename(wav_path), track_name or title,
                    video_name))
            audio_path = wav_path
        else:
            # m4a/aac and video containers decode to PCM once here;
            # soundfile-readable formats pass straight through.
            ext = os.path.splitext(source)[1].lower()
            keep_video = ext in _VIDEO_EXTS
            audio_path = pipeline.ensure_wav_input(
                source, job_dir, cb, keep_original=keep_video)
            video_name = None
            if keep_video and os.path.exists(source):
                video_name = "video" + ext
                os.replace(source, os.path.join(job_dir, video_name))
            if audio_path != source or video_name:
                # New input filename, no title change (None keeps the name).
                q.put(("meta", os.path.basename(audio_path), None, video_name))

        result = pipeline.run_job(job_dir, audio_path, cb, piano_only=piano_only)

        # Kept video + a real separation ran: swap its soundtrack for the
        # piano-removed stem so the TV plays the backing track and the
        # Disklavier supplies the piano. piano_only jobs have no such stem.
        if video_name and not piano_only:
            bg = pipeline.mux_backing_video(job_dir, video_name, cb)
            if bg:
                if bg != video_name:
                    try:
                        os.remove(os.path.join(job_dir, video_name))
                    except OSError:
                        pass
                video_name = bg
                # Point the job at the backing-track video.
                q.put(("meta", os.path.basename(audio_path), None, video_name))

        q.put(("done", result))
    except Exception as e:  # surface any pipeline failure to the UI
        q.put(("error", str(e) or repr(e)))
