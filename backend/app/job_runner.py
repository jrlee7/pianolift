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


def run_job_process(job_dir, kind, source, piano_only, q):
    """kind == 'file': source is the absolute audio path.
       kind == 'url' : source is the link; download it first."""
    def cb(stage, pct):
        q.put(("progress", stage, pct))

    try:
        if kind == "url":
            from . import fetcher
            try:
                wav_path, title = fetcher.download_audio(source, job_dir, cb)
            except Exception as e:  # download failures get their own label
                msg = (str(e) or repr(e)).splitlines()[0]
                q.put(("error", "Download failed: " + msg))
                return
            # Let the parent record the resolved title + input filename.
            q.put(("meta", os.path.basename(wav_path), title))
            audio_path = wav_path
        else:
            # m4a/aac and video containers decode to PCM once here;
            # soundfile-readable formats pass straight through.
            audio_path = pipeline.ensure_wav_input(source, job_dir, cb)
            if audio_path != source:
                # New input filename, no title change (None keeps the name).
                q.put(("meta", os.path.basename(audio_path), None))

        result = pipeline.run_job(job_dir, audio_path, cb, piano_only=piano_only)
        q.put(("done", result))
    except Exception as e:  # surface any pipeline failure to the UI
        q.put(("error", str(e) or repr(e)))
