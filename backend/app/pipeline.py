"""Processing pipeline: audio (MP3/WAV/M4A/...) -> piano stem
(BS-Roformer-SW) -> note/pedal events (ByteDance high-resolution piano
transcription + Transkun V2 as an independent second engine) -> spectral
verification and two-engine merge against the stem (note_verify)
-> events.json + default MIDI.

Runs on CPU. Each stage reports progress through a callback so the API can
expose it to the frontend.
"""

import json
import os
import urllib.request
import zipfile

from . import midi_writer, note_verify, transkun_engine

# 6-stem model (vocals/drums/bass/guitar/piano/other). Piano SDR ~7.83 vs
# ~2.23 for Demucs' htdemucs_6s -- Demucs' piano stem bleeds badly with
# other sustained/harmonic instruments (e.g. cello), which is exactly the
# failure mode this replaced.
SEPARATION_MODEL = "BS-Roformer-SW.ckpt"

# lameenc has no gapless/LAME-tag support, so decoders (including whatever
# the ENSPIRE uses) get no metadata to trim the codec's algorithmic startup
# delay. Measured empirically with a click-impulse test at our exact encode
# settings (320kbps CBR, quality 2): a click at sample N lands at N+1105..1106
# after encode+decode, constant across 4 positions in a 4s file -- a fixed
# property of the codec, not signal-dependent. Without compensation the piano
# MIDI would play ~25ms ahead of the accompaniment's audible content.
MP3_ENCODER_DELAY_SAMPLES = 1105

# piano_transcription_inference shells out to wget for this download, which
# Windows doesn't have — fetch it ourselves.
CHECKPOINT_URL = ("https://zenodo.org/record/4034264/files/"
                  "CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1")
CHECKPOINT_PATH = os.path.join(
    os.path.expanduser("~"), "piano_transcription_inference_data",
    "note_F1=0.9677_pedal_F1=0.9186.pth")


def _ensure_checkpoint(progress_cb):
    if os.path.exists(CHECKPOINT_PATH):
        return
    progress_cb("transcribing", 10)
    os.makedirs(os.path.dirname(CHECKPOINT_PATH), exist_ok=True)
    tmp = CHECKPOINT_PATH + ".tmp"
    urllib.request.urlretrieve(CHECKPOINT_URL, tmp)
    os.replace(tmp, CHECKPOINT_PATH)


# audio-separator hard-requires ffmpeg on PATH (pydub uses it internally for
# I/O) and raises at construction time if it's missing. Windows has no
# system ffmpeg by default, so fetch a static build ourselves, same as the
# transcription checkpoint above.
FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
FFMPEG_DIR = os.path.join(os.path.expanduser("~"), "pianoforge_ffmpeg")
FFMPEG_EXE = os.path.join(FFMPEG_DIR, "ffmpeg.exe")


def _ensure_ffmpeg(progress_cb):
    if not os.path.exists(FFMPEG_EXE):
        progress_cb("separating", 2)
        os.makedirs(FFMPEG_DIR, exist_ok=True)
        zip_path = FFMPEG_EXE + ".zip"
        urllib.request.urlretrieve(FFMPEG_URL, zip_path)
        with zipfile.ZipFile(zip_path) as zf:
            member = next(n for n in zf.namelist() if n.endswith("bin/ffmpeg.exe"))
            with zf.open(member) as src, open(FFMPEG_EXE, "wb") as dst:
                dst.write(src.read())
        os.remove(zip_path)
    os.environ["PATH"] = FFMPEG_DIR + os.pathsep + os.environ["PATH"]


# A whole-file separation loads the entire stereo waveform (plus the model's
# tensors) into RAM at once. On the CPU path a full-length concert/movie
# (~2.6 GB just for the 44.1k stereo PCM of a 2-hour file) overruns memory and
# the OS kills the worker — which surfaces to the UI as the generic
# "Conversion process exited unexpectedly". Above SEP_LONG_THRESHOLD_SEC the
# audio is separated in overlapping windows and the stems crossfaded back
# together, so peak memory is bounded by the window size no matter how long the
# source runs. Short songs (the common case) still take the single-pass path.
SEP_LONG_THRESHOLD_SEC = 900.0   # 15 min
SEP_CHUNK_SEC = 300.0            # 5-minute separation windows
SEP_OVERLAP_SEC = 6.0           # crossfaded seam between adjacent windows

# Same OOM shape hits transcription: a single ByteDance or Transkun forward
# pass over a whole 2-hour file's worth of frames holds the model's
# internal activations for the entire sequence at once. Separation got
# chunked in 0.1.25; a later addition -- transcribing the original mix a
# second time as note_verify cross-check evidence -- reintroduced a
# whole-file model pass that wasn't there when that fix was validated, and
# now fails the same way, late (mid-"transcribing" stage) and silently
# (child OOM-killed -> queue gets nothing -> generic "exited unexpectedly").
# Above the threshold, each model pass runs in overlapping windows: the
# overlap is context only (for accurate onsets/offsets right at the seam),
# and only the non-overlapping core of each window's events is kept, so
# windows stitch back together with no dedup pass needed. The raw decoded
# audio arrays are loaded once, whole, up front -- that's a few hundred MB
# to a couple GB and isn't what was OOMing; only the model passes are
# chunked.
TRX_LONG_THRESHOLD_SEC = 900.0   # 15 min
TRX_CHUNK_SEC = 240.0            # 4-minute core window per model pass
TRX_PAD_SEC = 20.0               # context on each side, trimmed after
# A pedal held continuously across a chunk seam gets cut into two segments
# (each window only sees its own slice); segments that touch within this
# gap are the same physical hold and get merged back into one.
PEDAL_MERGE_GAP_SEC = 0.5


def _build_separator(job_dir):
    """Create the BS-Roformer separator and load its checkpoint once. Reused
    across every window of a chunked job so the ~700MB model loads a single
    time."""
    from audio_separator.separator import Separator

    sep_out = os.path.join(job_dir, "separated")
    model_dir = os.path.join(os.path.expanduser("~"), "audio_separator_models")
    # overlap 16 (default 8) doubles prediction-window overlap: fewer
    # boundary artifacts in the stem for ~2x separation time. Separation is
    # a fraction of total job time, and stem artifacts are precisely what
    # the transcriber hallucinates notes from, so the trade is worth it.
    # On a GPU the same pass is ~10x faster, so push overlap further; 32 is
    # deep into diminishing returns, anything higher is pure waste.
    overlap = 32 if compute_device() == "cuda" else 16
    separator = Separator(
        output_dir=sep_out, output_format="WAV", model_file_dir=model_dir,
        mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                     "batch_size": 1, "overlap": overlap, "pitch_shift": 0})
    separator.load_model(model_filename=SEPARATION_MODEL)
    return separator, sep_out


def _separate_one(separator, sep_out, in_path):
    """Separate a single file into (piano_path, [accompaniment_paths]).

    audio_separator's separate() catches any exception per file internally and
    only logs it, so a genuine failure (OOM, a corrupt cached checkpoint, a
    disk error) looks identical to "produced nothing" unless we grab its
    suppressed log record ourselves."""
    import logging

    class _CaptureErrors(logging.Handler):
        def __init__(self):
            super().__init__(level=logging.ERROR)
            self.messages = []

        def emit(self, record):
            self.messages.append(record.getMessage())

    capture = _CaptureErrors()
    logging.getLogger().addHandler(capture)
    try:
        # separate() returns bare filenames, not joined with output_dir.
        outs = [os.path.join(sep_out, f) for f in separator.separate(in_path)]
    finally:
        logging.getLogger().removeHandler(capture)

    piano = next(
        (f for f in outs if "piano" in os.path.basename(f).lower()), None)
    if piano is None:
        detail = "; ".join(capture.messages) or "no error logged by the separator"
        raise RuntimeError("Separator finished but piano stem not found (" + detail + ")")
    accomp = [f for f in outs if f != piano]
    if not accomp:
        raise RuntimeError("Separator finished but no accompaniment stems found")
    return piano, accomp


def _sum_stems(paths):
    """Read and sum a window's accompaniment stems into one (frames, ch) array
    — the no_piano mix for that window."""
    import soundfile as sf

    mix = None
    for f in paths:
        data, _ = sf.read(f, dtype="float32", always_2d=True)
        mix = data if mix is None else mix + data
    return mix


def _write_stitch(writer, chunk, prev_tail, over_fr, is_last):
    """Append one window's audio to a streaming SoundFile, crossfading its head
    against the previous window's held-back tail so window seams are inaudible.
    Returns this window's own tail (last over_fr frames) to hand to the next
    call, or None on the final window. Only a few seconds of audio are ever
    held in memory, which is what keeps a multi-hour stitch bounded."""
    import numpy as np

    n = len(chunk)
    start = 0
    if prev_tail is not None and over_fr > 0:
        o = min(over_fr, n, len(prev_tail))
        if o > 0:
            ramp = np.linspace(0.0, 1.0, o, dtype=np.float32).reshape(-1, 1)
            writer.write(prev_tail[-o:] * (1.0 - ramp) + chunk[:o] * ramp)
            start = o
    if is_last:
        if start < n:
            writer.write(chunk[start:])
        return None
    tail_len = min(over_fr, n - start)
    body_end = n - tail_len
    if body_end > start:
        writer.write(chunk[start:body_end])
    return chunk[body_end:].copy() if tail_len > 0 else None


def _separate_piano_chunked(audio_path, sep_out, separator, info, progress_cb):
    """Separate a long file window-by-window, streaming the crossfaded piano
    and no_piano stems straight to disk. Returns the piano stem path; writes
    no_piano.wav beside it — same contract as the single-pass path."""
    import soundfile as sf

    sr = info.samplerate
    total = info.frames
    chunk_fr = int(SEP_CHUNK_SEC * sr)
    over_fr = int(SEP_OVERLAP_SEC * sr)
    n_chunks = max(1, (total + chunk_fr - 1) // chunk_fr)

    piano_out = os.path.join(sep_out, "piano_full.wav")
    nopiano_out = os.path.join(sep_out, "no_piano.wav")
    piano_w = nopiano_w = None
    tail_p = tail_n = None
    try:
        for i in range(n_chunks):
            start = i * chunk_fr
            if start >= total:
                break
            end = min(total, (i + 1) * chunk_fr + over_fr)
            chunk, _ = sf.read(audio_path, start=start, frames=end - start,
                               dtype="float32", always_2d=True)
            tmp_in = os.path.join(sep_out, "chunk_%03d.wav" % i)
            sf.write(tmp_in, chunk, sr)
            del chunk

            piano_p, accomp = _separate_one(separator, sep_out, tmp_in)
            p, _ = sf.read(piano_p, dtype="float32", always_2d=True)
            npmix = _sum_stems(accomp)

            if piano_w is None:
                piano_w = sf.SoundFile(piano_out, mode="w", samplerate=sr,
                                       channels=p.shape[1], subtype="PCM_16")
                nopiano_w = sf.SoundFile(nopiano_out, mode="w", samplerate=sr,
                                         channels=npmix.shape[1], subtype="PCM_16")

            # end can reach the file end early when a window's overlap padding
            # spills past `total`; that window already covers the rest, so stop
            # rather than emit a spurious tiny trailing window.
            is_last = end >= total
            tail_p = _write_stitch(piano_w, p, tail_p, over_fr, is_last)
            tail_n = _write_stitch(nopiano_w, npmix, tail_n, over_fr, is_last)

            for f in [tmp_in, piano_p] + accomp:
                try:
                    os.remove(f)
                except OSError:
                    pass
            progress_cb("separating", min(99, 5 + int(94 * (i + 1) / n_chunks)))
            if is_last:
                break
    finally:
        if piano_w is not None:
            piano_w.close()
        if nopiano_w is not None:
            nopiano_w.close()

    progress_cb("separating", 100)
    return piano_out


def separate_piano(audio_path, job_dir, progress_cb):
    """Run BS-Roformer-SW, return path to the piano stem wav.

    The model has no Demucs-style "--two-stems" complement, so we also sum
    the other 5 stems it produces into no_piano.wav -- the accompaniment
    that plays through the ENSPIRE speakers. Long inputs are separated in
    windows (see _separate_piano_chunked) to keep memory bounded.
    """
    import soundfile as sf

    progress_cb("separating", 0)
    _ensure_ffmpeg(progress_cb)
    info = sf.info(audio_path)
    duration = info.frames / float(info.samplerate) if info.samplerate else 0.0
    separator, sep_out = _build_separator(job_dir)
    progress_cb("separating", 5)  # first run downloads a ~700MB checkpoint

    if duration > SEP_LONG_THRESHOLD_SEC:
        return _separate_piano_chunked(audio_path, sep_out, separator, info,
                                       progress_cb)

    piano_wav, accompaniment_stems = _separate_one(separator, sep_out, audio_path)
    progress_cb("separating", 100)

    mix = _sum_stems(accompaniment_stems)
    no_piano_wav = os.path.join(os.path.dirname(piano_wav), "no_piano.wav")
    sf.write(no_piano_wav, mix, info.samplerate)

    # The 5 individual stems (~50MB each) are never read again once summed:
    # every later step (trim re-encode, verify, playback) uses only the
    # piano stem and no_piano.wav. Deleting them here cuts a job's disk
    # footprint by more than half.
    for f in accompaniment_stems:
        try:
            os.remove(f)
        except OSError:
            pass

    return piano_wav


# Containers libsndfile reads directly. Anything else (m4a/aac audio, video
# files) must be decoded to PCM first: detect_dead_space and the piano-only
# path use soundfile, which has no AAC/MP4 support — an .m4a upload used to
# crash only *after* minutes of separation.
_SOUNDFILE_EXTS = (".wav", ".flac", ".mp3", ".ogg")


def ensure_wav_input(audio_path, job_dir, progress_cb, keep_original=False):
    """Return a path every pipeline stage can read: the file itself when
    soundfile handles the container, else a one-time ffmpeg decode to
    input.wav (44.1 kHz stereo PCM; -vn strips video streams). The original
    container is deleted after a successful decode unless keep_original
    (uploaded videos the Play tab streams later)."""
    import subprocess

    if os.path.splitext(audio_path)[1].lower() in _SOUNDFILE_EXTS:
        return audio_path
    _ensure_ffmpeg(progress_cb)
    wav_path = os.path.join(job_dir, "input.wav")
    proc = subprocess.run(
        [FFMPEG_EXE, "-y", "-i", audio_path, "-vn",
         "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav_path],
        capture_output=True)
    if proc.returncode != 0 or not os.path.exists(wav_path):
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("audio decode failed: " +
                           (tail[-1] if tail else "ffmpeg error"))
    if not keep_original:
        os.remove(audio_path)
    return wav_path


def detect_dead_space(audio_path):
    """Find leading silence in the original mix.

    Returns (trim_start_sec, trim_end_sec) in the original timeline, with a
    0.2s pre-roll before the first sound. No automatic trailing cut: any
    quiet-tail threshold reliably chops ring-out on some recordings, so the
    end is left full-length for the user to trim manually if they want to.
    """
    import numpy as np
    import soundfile as sf

    # Streamed in blocks so a multi-hour mix never loads whole into RAM (a
    # full sf.read of a 2-hour file is gigabytes of float). Pass 1 finds the
    # track's peak; pass 2 finds the first frame that clears the threshold.
    sr = sf.info(audio_path).samplerate
    BLK = 1 << 20  # ~1M frames/block

    peak = 0.0
    for block in sf.blocks(audio_path, blocksize=BLK, dtype="float32"):
        mono = block.mean(axis=1) if block.ndim > 1 else block
        if len(mono):
            peak = max(peak, float(np.max(np.abs(mono))))
    if peak <= 0:
        return 0.0, None

    # ~-34 dB below the track's own peak counts as "sound"
    thr = peak * 0.02
    pos = 0
    first = None
    for block in sf.blocks(audio_path, blocksize=BLK, dtype="float32"):
        mono = block.mean(axis=1) if block.ndim > 1 else block
        idx = np.where(np.abs(mono) > thr)[0]
        if len(idx):
            first = pos + int(idx[0])
            break
        pos += len(mono)
    if first is None:
        return 0.0, None
    start = max(0.0, first / float(sr) - 0.2)
    return round(start, 3), None


def has_real_accompaniment(no_piano_wav, piano_wav):
    """True when the piano-removed stem holds actual content (vocals/other
    instruments), not just separation bleed.

    A song that's really piano-only still runs through the separator when the
    user doesn't tick "piano-only"; its no_piano stem then comes out
    near-silent (residual bleed only). We treat that as no accompaniment so a
    silent MP3 never gets encoded, saved to the library, or copied to the USB.

    Scale-invariant: compares the accompaniment's RMS to the piano stem's, so
    it works on quiet and loud masters alike. The stem is bleed if it's below
    an absolute silence floor (~-46 dBFS) or under ~5% of the piano's energy.
    """
    import numpy as np
    import soundfile as sf

    def rms(path):
        # Block-streamed so long stems don't load whole into RAM.
        total = 0.0
        count = 0
        for block in sf.blocks(path, blocksize=1 << 20, dtype="float32"):
            mono = block.mean(axis=1) if block.ndim > 1 else block
            if len(mono):
                total += float(np.sum(np.square(mono)))
                count += len(mono)
        return float(np.sqrt(total / count)) if count else 0.0

    acc = rms(no_piano_wav)
    piano = rms(piano_wav)
    return acc > 0.005 and acc > 0.05 * piano


def encode_accompaniment(no_piano_wav, job_dir, progress_cb,
                         trim_start=0.0, trim_end=None):
    """Encode the piano-less stem to MP3 — this is what plays through the
    ENSPIRE speakers while the piano itself plays the MIDI.

    trim_start/trim_end cut dead space; the MIDI render applies the same
    trim_start shift so the two stay locked.
    """
    import lameenc
    import numpy as np
    import soundfile as sf

    progress_cb("encoding", 0)
    info = sf.info(no_piano_wav)
    sr = info.samplerate
    lo = int(trim_start * sr)
    hi = info.frames if trim_end is None else min(info.frames,
                                                  int(trim_end * sr))
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(320)
    encoder.set_in_sample_rate(sr)
    encoder.set_channels(2)
    encoder.set_quality(2)
    encoder.silence()
    out = os.path.join(job_dir, "accompaniment.mp3")
    # Stream the trimmed window [lo, hi) through the encoder in blocks: a
    # 2-hour stem is >1 GB of int16, and .tobytes() would double it — the old
    # whole-file read OOM'd on long inputs. lameenc keeps state across encode()
    # calls, so block-by-block output is identical to one big call.
    with open(out, "wb") as f:
        pos = lo
        BLK = 1 << 20
        while pos < hi:
            n = min(BLK, hi - pos)
            data, _ = sf.read(no_piano_wav, start=pos, frames=n,
                              dtype="int16", always_2d=True)
            if data.shape[1] == 1:
                data = np.column_stack([data[:, 0], data[:, 0]])
            f.write(bytes(encoder.encode(data.tobytes())))
            pos += n
        f.write(bytes(encoder.flush()))
    progress_cb("encoding", 100)
    delay_ms = MP3_ENCODER_DELAY_SAMPLES / sr * 1000.0
    return out, delay_ms


def compute_device():
    """"cuda" when a usable NVIDIA GPU + CUDA torch build are present,
    else "cpu". A CPU-only torch wheel (this repo's default install)
    reports cuda unavailable, so the CPU path needs no special casing —
    installing the CUDA wheel on a GPU machine is the only switch.
    audio-separator does its own equivalent detection for separation."""
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def _load_transcriptor(progress_cb):
    # Imported lazily: heavy modules, and the checkpoint download happens
    # on first construction.
    from piano_transcription_inference import PianoTranscription

    _ensure_checkpoint(progress_cb)
    return PianoTranscription(device=compute_device(),
                              checkpoint_path=CHECKPOINT_PATH)


def _events_from_result(result):
    notes = []
    for ev in result["est_note_events"]:
        notes.append({
            "onset": round(float(ev["onset_time"]), 4),
            "offset": round(float(ev["offset_time"]), 4),
            "pitch": int(ev["midi_note"]),
            "velocity": int(ev["velocity"]),
        })
    pedals = []
    for ev in result.get("est_pedal_events", []):
        pedals.append({
            "onset": round(float(ev["onset_time"]), 4),
            "offset": round(float(ev["offset_time"]), 4),
        })
    notes.sort(key=lambda n: n["onset"])
    pedals.sort(key=lambda p: p["onset"])
    return notes, pedals


def _peak_normalize(audio):
    """Lift a quiet stem to ~-0.4 dBFS peak (and pull a hot one down to the
    same level). Both transcribers trained on full-level MAESTRO recordings;
    a piano mixed low in the source comes out of the separator quiet, and
    soft notes then sit below the models' onset sensitivity. Gain is capped
    at +18 dB so a near-silent stem (wrong "piano-only" tick, instrumental
    with no piano) doesn't get its noise floor blasted into fake notes."""
    import numpy as np

    peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
    if peak > 0:
        return audio * min(0.95 / peak, 8.0)
    return audio


def _chunk_windows(duration_sec, chunk_sec, pad_sec):
    """Yield (window_start, window_end, core_start, core_end) in seconds
    covering [0, duration_sec) in non-overlapping cores, each window padded
    with context on both sides (clamped to the file's bounds)."""
    core_start = 0.0
    while core_start < duration_sec:
        core_end = min(core_start + chunk_sec, duration_sec)
        window_start = max(0.0, core_start - pad_sec)
        window_end = min(duration_sec, core_end + pad_sec)
        yield window_start, window_end, core_start, core_end
        core_start = core_end


def _keep_core_events(notes, pedals, window_start, core_start, core_end,
                       out_notes, out_pedals):
    """Shift a window's locally-timed events to absolute time and keep
    only those whose onset falls in the window's non-overlapping core —
    the padding on either side exists purely for model context."""
    for n in notes:
        onset = n["onset"] + window_start
        if core_start <= onset < core_end:
            n2 = dict(n)
            n2["onset"] = round(onset, 4)
            n2["offset"] = round(n["offset"] + window_start, 4)
            out_notes.append(n2)
    for p in pedals:
        onset = p["onset"] + window_start
        if core_start <= onset < core_end:
            p2 = dict(p)
            p2["onset"] = round(onset, 4)
            p2["offset"] = round(p["offset"] + window_start, 4)
            out_pedals.append(p2)


def _merge_touching_pedals(pedals, gap_sec=PEDAL_MERGE_GAP_SEC):
    """A pedal held across a chunk seam is split into two segments (each
    window only sees its own slice); segments that touch within gap_sec
    are one physical hold and get merged back together."""
    if not pedals:
        return pedals
    pedals = sorted(pedals, key=lambda p: p["onset"])
    merged = [dict(pedals[0])]
    for p in pedals[1:]:
        last = merged[-1]
        if p["onset"] - last["offset"] <= gap_sec:
            last["offset"] = max(last["offset"], p["offset"])
        else:
            merged.append(dict(p))
    return merged


def _bd_transcribe_chunked(transcriptor, audio, sr, progress_cb, lo, hi):
    duration = len(audio) / sr
    windows = list(_chunk_windows(duration, TRX_CHUNK_SEC, TRX_PAD_SEC))
    notes, pedals = [], []
    for i, (ws, we, cs, ce) in enumerate(windows):
        result = transcriptor.transcribe(audio[int(ws * sr):int(we * sr)], None)
        w_notes, w_pedals = _events_from_result(result)
        _keep_core_events(w_notes, w_pedals, ws, cs, ce, notes, pedals)
        if progress_cb:
            progress_cb("transcribing", lo + (hi - lo) * (i + 1) / len(windows))
    notes.sort(key=lambda n: n["onset"])
    pedals = _merge_touching_pedals(pedals)
    return notes, pedals


def _transkun_transcribe_chunked(data, sr, progress_cb, lo, hi):
    duration = len(data) / sr
    windows = list(_chunk_windows(duration, TRX_CHUNK_SEC, TRX_PAD_SEC))
    notes, pedals = [], []
    for i, (ws, we, cs, ce) in enumerate(windows):
        w_notes, w_pedals = transkun_engine.transcribe_array(
            data[int(ws * sr):int(we * sr)], sr)
        _keep_core_events(w_notes, w_pedals, ws, cs, ce, notes, pedals)
        if progress_cb:
            progress_cb("transcribing", lo + (hi - lo) * (i + 1) / len(windows))
    notes.sort(key=lambda n: n["onset"])
    pedals = _merge_touching_pedals(pedals)
    return notes, pedals


def transcribe(piano_wav, progress_cb, mix_path=None):
    """Transcribe piano stem to note + pedal events (with velocities),
    with two engines: ByteDance high-res (primary) and Transkun V2
    (independent second witness; better offsets/velocities, own pedal
    detector). note_verify merges the two.

    With mix_path, the original (pre-separation) mix is transcribed too and
    its note list returned as cross-check evidence for note_verify: the
    piano in the mix has no separation artifacts, so a stem note with no
    counterpart there is suspect. Non-piano instruments the model picks up
    from the mix don't matter — they were never in the stem's list, so they
    can't add notes, only confirm. Roughly doubles transcription time.

    Above TRX_LONG_THRESHOLD_SEC each model pass runs chunked (see
    TRX_CHUNK_SEC comment) to bound peak RAM; the decoded audio itself is
    still loaded whole, once, up front.

    Returns (notes, pedals, mix_notes, alt_notes, alt_pedals).
    """
    from piano_transcription_inference import sample_rate
    import librosa
    import soundfile as sf

    progress_cb("transcribing", 5)
    transcriptor = _load_transcriptor(progress_cb)
    # The package's own load_audio needs an audioread backend (ffmpeg),
    # which Windows lacks; the stem is a plain wav so soundfile handles it.
    audio, _ = librosa.load(piano_wav, sr=sample_rate, mono=True)
    audio = _peak_normalize(audio)
    duration = len(audio) / sample_rate
    chunked = duration > TRX_LONG_THRESHOLD_SEC

    progress_cb("transcribing", 15)
    if chunked:
        notes, pedals = _bd_transcribe_chunked(
            transcriptor, audio, sample_rate, progress_cb, 15, 45)
    else:
        result = transcriptor.transcribe(audio, None)
        notes, pedals = _events_from_result(result)

    # Second engine on the same stem (Transkun normalizes internally).
    progress_cb("transcribing", 45)
    if chunked:
        tk_data, tk_sr = sf.read(piano_wav, dtype="float32")
        alt_notes, alt_pedals = _transkun_transcribe_chunked(
            tk_data, tk_sr, progress_cb, 45, 60)
    else:
        alt_notes, alt_pedals = transkun_engine.transcribe(piano_wav)

    mix_notes = None
    if mix_path is not None:
        progress_cb("transcribing", 60)
        # Compressed inputs (mp3/m4a) decode through audioread+ffmpeg;
        # separation always runs first and puts our ffmpeg on PATH.
        mix_audio, _ = librosa.load(mix_path, sr=sample_rate, mono=True)
        progress_cb("transcribing", 65)
        if chunked:
            mix_notes, _ = _bd_transcribe_chunked(
                transcriptor, mix_audio, sample_rate, progress_cb, 65, 100)
        else:
            mix_result = transcriptor.transcribe(mix_audio, None)
            mix_notes, _ = _events_from_result(mix_result)

    progress_cb("transcribing", 100)
    return notes, pedals, mix_notes, alt_notes, alt_pedals


def transcribe_mix_notes(mix_path, progress_cb):
    """Note list of the original mix only — cross-check evidence for a
    retroactive deep clean-up of an already-converted job."""
    from piano_transcription_inference import sample_rate
    import librosa

    _ensure_ffmpeg(progress_cb)  # compressed inputs need it; wav doesn't care
    transcriptor = _load_transcriptor(progress_cb)
    audio, _ = librosa.load(mix_path, sr=sample_rate, mono=True)
    notes, _ = _events_from_result(transcriptor.transcribe(audio, None))
    return notes


def _decode_piano_only(audio_path, job_dir, progress_cb):
    """Skip separation entirely -- the input is already just piano. Decode
    straight to wav for the transcriber; no accompaniment to encode."""
    import soundfile as sf

    progress_cb("separating", 0)
    data, sr = sf.read(audio_path)
    out = os.path.join(job_dir, "piano.wav")
    sf.write(out, data, sr)
    progress_cb("separating", 100)
    return out


def run_job(job_dir, audio_path, progress_cb, piano_only=False,
            max_end_sec=None):
    """Full pipeline. Writes events.json and output.mid into job_dir.

    max_end_sec: the song's true end within the audio (album-split jobs pad
    the download past the chapter boundary for ring-out; see fetcher
    RING_PAD_SEC). Caps the non-destructive trim window so notes struck
    after the boundary never play, while tails crossing it survive."""
    if piano_only:
        piano_wav = _decode_piano_only(audio_path, job_dir, progress_cb)
        accompaniment, encoder_delay_ms = None, 0.0
        trim_start, trim_end = 0.0, max_end_sec
    else:
        progress_cb("separating", 0)
        piano_wav = separate_piano(audio_path, job_dir, progress_cb)

        no_piano_wav = os.path.join(os.path.dirname(piano_wav), "no_piano.wav")
        if not os.path.exists(no_piano_wav):
            raise RuntimeError("Separator finished but no_piano stem not found")

        trim_start, trim_end = detect_dead_space(audio_path)
        if max_end_sec is not None and (trim_end is None
                                        or trim_end > max_end_sec):
            trim_end = max_end_sec
        # A near-silent no_piano stem means the song is really piano-only:
        # skip the accompaniment MP3 entirely (nothing to play through the
        # ENSPIRE speakers, nothing worth uploading to the cloud library).
        if has_real_accompaniment(no_piano_wav, piano_wav):
            accompaniment, encoder_delay_ms = encode_accompaniment(
                no_piano_wav, job_dir, progress_cb,
                trim_start=trim_start, trim_end=trim_end)
        else:
            accompaniment, encoder_delay_ms = None, 0.0

    # piano_only inputs ARE the mix, so there is nothing to cross-check.
    notes, pedals, mix_notes, alt_notes, alt_pedals = transcribe(
        piano_wav, progress_cb, mix_path=None if piano_only else audio_path)

    # The transcriber hallucinates notes from separation bleed and marks
    # note-offs at final string damp; both are checked against the stem's
    # own spectrogram, the original mix's transcription (when there is
    # one), and Transkun's independent transcription, then corrected
    # before anything is persisted.
    notes, pedals, verify_stats = note_verify.refine(
        piano_wav, notes, pedals, progress_cb, mix_notes=mix_notes,
        alt_notes=alt_notes, alt_pedals=alt_pedals)

    events = {"notes": notes, "pedals": pedals}
    with open(os.path.join(job_dir, "events.json"), "w") as f:
        json.dump(events, f)

    # Bake in encoder-delay compensation and the dead-space trim so a "0 ms"
    # timing offset is already correctly synced against the trimmed
    # accompaniment; the user's slider is then pure room/feel adjustment.
    midi_path = os.path.join(job_dir, "output.mid")
    baked_offset_ms = encoder_delay_ms - trim_start * 1000.0
    midi_writer.write_midi(notes, pedals, midi_path, offset_ms=baked_offset_ms)

    return {
        "pianoStem": piano_wav,
        "accompaniment": accompaniment,
        "encoderDelayMs": encoder_delay_ms,
        "trimStartSec": trim_start,
        "trimEndSec": trim_end,
        "noteCount": len(notes),
        "pedalCount": len(pedals),
        "ghostCount": verify_stats["ghosts"] + verify_stats["restrikes"],
        "trimmedCount": verify_stats["trimmed"],
    }


def mux_backing_video(job_dir, video_name, progress_cb):
    """Replace a kept video's audio with the piano-removed stem, so the Play
    tab (video on the TV) plays the backing track while the real Disklavier
    plays the piano — no need to mute the video's own piano.

    The no_piano stem is full-length and on the original mix's timeline (both
    it and the video derive from the same download), so audio lines up 1:1
    with the picture and with the events the video-sync player schedules.

    Returns the new video's basename ("video_bg.mp4") on success, else None
    (piano-only jobs, missing stem, or a codec the mp4 container can't hold
    by stream-copy — the caller keeps the original video in that case).
    """
    import subprocess

    src = os.path.join(job_dir, video_name)
    no_piano = os.path.join(job_dir, "separated", "no_piano.wav")
    if not os.path.exists(src) or not os.path.exists(no_piano):
        return None
    _ensure_ffmpeg(progress_cb)
    progress_cb("muxing video", 0)
    out = os.path.join(job_dir, "video_bg.mp4")
    # -c:v copy: never re-encode the picture (fast, lossless). URL downloads
    # are H.264 mp4 (merge_output_format=mp4, height<=1080), which the mp4
    # container copies cleanly; an uploaded VP9/AV1 file may not, so a copy
    # failure just falls back to the original video below.
    proc = subprocess.run(
        [FFMPEG_EXE, "-y", "-i", src, "-i", no_piano,
         "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
         "-c:a", "aac", "-b:a", "256k", "-shortest", out],
        capture_output=True)
    if proc.returncode != 0 or not os.path.exists(out):
        if os.path.exists(out):
            os.remove(out)
        return None
    progress_cb("muxing video", 100)
    return "video_bg.mp4"
