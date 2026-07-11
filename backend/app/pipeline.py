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
FFMPEG_DIR = os.path.join(os.path.expanduser("~"), "pianolift_ffmpeg")
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


def separate_piano(audio_path, job_dir, progress_cb):
    """Run BS-Roformer-SW, return path to the piano stem wav.

    The model has no Demucs-style "--two-stems" complement, so we also sum
    the other 5 stems it produces into no_piano.wav -- the accompaniment
    that plays through the ENSPIRE speakers.
    """
    from audio_separator.separator import Separator
    import soundfile as sf

    progress_cb("separating", 0)
    _ensure_ffmpeg(progress_cb)
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
    progress_cb("separating", 5)  # first run downloads a ~700MB checkpoint
    separator.load_model(model_filename=SEPARATION_MODEL)
    # separate() returns bare filenames, not joined with output_dir.
    output_files = [os.path.join(sep_out, f) for f in separator.separate(audio_path)]
    progress_cb("separating", 100)

    piano_wav = next(
        (f for f in output_files if "piano" in os.path.basename(f).lower()), None)
    if piano_wav is None:
        raise RuntimeError("Separator finished but piano stem not found")

    accompaniment_stems = [f for f in output_files if f != piano_wav]
    if not accompaniment_stems:
        raise RuntimeError("Separator finished but no accompaniment stems found")
    mix = None
    sr = None
    for f in accompaniment_stems:
        data, sr = sf.read(f, dtype="float32")
        mix = data if mix is None else mix + data
    no_piano_wav = os.path.join(os.path.dirname(piano_wav), "no_piano.wav")
    sf.write(no_piano_wav, mix, sr)

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


def ensure_wav_input(audio_path, job_dir, progress_cb):
    """Return a path every pipeline stage can read: the file itself when
    soundfile handles the container, else a one-time ffmpeg decode to
    input.wav (44.1 kHz stereo PCM; -vn strips video streams). The original
    container is deleted after a successful decode."""
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
    os.remove(audio_path)
    return wav_path


def detect_dead_space(audio_path):
    """Find leading/trailing silence in the original mix.

    Returns (trim_start_sec, trim_end_sec) in the original timeline, with a
    0.2s pre-roll before the first sound and a 0.5s tail after the last so
    attacks and reverb decays aren't clipped.
    """
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(audio_path)
    mono = data.mean(axis=1) if data.ndim > 1 else data
    total = len(mono) / float(sr)
    peak = float(np.max(np.abs(mono)))
    if peak <= 0:
        return 0.0, total
    # ~-34 dB below the track's own peak counts as "sound"
    loud = np.where(np.abs(mono) > peak * 0.02)[0]
    if len(loud) == 0:
        return 0.0, total
    start = max(0.0, loud[0] / float(sr) - 0.2)
    end = min(total, loud[-1] / float(sr) + 0.5)
    return round(start, 3), round(end, 3)


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
        data, _ = sf.read(path, dtype="float32")
        mono = data.mean(axis=1) if data.ndim > 1 else data
        if len(mono) == 0:
            return 0.0
        return float(np.sqrt(np.mean(np.square(mono))))

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
    data, sr = sf.read(no_piano_wav, dtype="int16")
    if data.ndim == 1:
        data = np.column_stack([data, data])
    lo = int(trim_start * sr)
    hi = len(data) if trim_end is None else min(len(data), int(trim_end * sr))
    data = data[lo:hi]
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(320)
    encoder.set_in_sample_rate(sr)
    encoder.set_channels(2)
    encoder.set_quality(2)
    encoder.silence()
    mp3_bytes = encoder.encode(data.tobytes())
    mp3_bytes += encoder.flush()
    out = os.path.join(job_dir, "accompaniment.mp3")
    with open(out, "wb") as f:
        f.write(bytes(mp3_bytes))
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

    Returns (notes, pedals, mix_notes, alt_notes, alt_pedals).
    """
    from piano_transcription_inference import sample_rate
    import librosa

    progress_cb("transcribing", 5)
    transcriptor = _load_transcriptor(progress_cb)
    # The package's own load_audio needs an audioread backend (ffmpeg),
    # which Windows lacks; the stem is a plain wav so soundfile handles it.
    audio, _ = librosa.load(piano_wav, sr=sample_rate, mono=True)
    audio = _peak_normalize(audio)
    progress_cb("transcribing", 15)
    result = transcriptor.transcribe(audio, None)
    notes, pedals = _events_from_result(result)

    # Second engine on the same stem (Transkun normalizes internally).
    progress_cb("transcribing", 45)
    alt_notes, alt_pedals = transkun_engine.transcribe(piano_wav)

    mix_notes = None
    if mix_path is not None:
        progress_cb("transcribing", 60)
        # Compressed inputs (mp3/m4a) decode through audioread+ffmpeg;
        # separation always runs first and puts our ffmpeg on PATH.
        mix_audio, _ = librosa.load(mix_path, sr=sample_rate, mono=True)
        progress_cb("transcribing", 65)
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


def run_job(job_dir, audio_path, progress_cb, piano_only=False):
    """Full pipeline. Writes events.json and output.mid into job_dir."""
    if piano_only:
        piano_wav = _decode_piano_only(audio_path, job_dir, progress_cb)
        accompaniment, encoder_delay_ms = None, 0.0
        trim_start, trim_end = 0.0, None
    else:
        progress_cb("separating", 0)
        piano_wav = separate_piano(audio_path, job_dir, progress_cb)

        no_piano_wav = os.path.join(os.path.dirname(piano_wav), "no_piano.wav")
        if not os.path.exists(no_piano_wav):
            raise RuntimeError("Separator finished but no_piano stem not found")

        trim_start, trim_end = detect_dead_space(audio_path)
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
        "ghostCount": verify_stats["ghosts"],
        "trimmedCount": verify_stats["trimmed"],
    }
