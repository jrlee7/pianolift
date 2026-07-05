"""Processing pipeline: MP3 -> piano stem (Demucs) -> note/pedal events
(ByteDance high-resolution piano transcription) -> events.json + default MIDI.

Runs on CPU. Each stage reports progress through a callback so the API can
expose it to the frontend.
"""

import json
import os
import subprocess
import sys
import urllib.request

from . import midi_writer

DEMUCS_MODEL = "htdemucs_6s"  # 6-stem model with a dedicated piano stem

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


def _find_stem(demucs_out, track_name, stem):
    path = os.path.join(demucs_out, DEMUCS_MODEL, track_name, stem + ".wav")
    if os.path.exists(path):
        return path
    # Demucs sanitizes some characters; fall back to scanning.
    model_dir = os.path.join(demucs_out, DEMUCS_MODEL)
    if os.path.isdir(model_dir):
        for d in os.listdir(model_dir):
            candidate = os.path.join(model_dir, d, stem + ".wav")
            if os.path.exists(candidate):
                return candidate
    return None


def separate_piano(mp3_path, job_dir, progress_cb):
    """Run Demucs, return path to piano stem wav."""
    demucs_out = os.path.join(job_dir, "demucs")
    cmd = [
        sys.executable, "-m", "demucs.separate",
        "-n", DEMUCS_MODEL,
        "--two-stems", "piano",
        "-o", demucs_out,
        mp3_path,
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace")
    log_lines = []
    for line in proc.stdout:
        line = line.strip()
        if line:
            log_lines.append(line)
            # Demucs prints tqdm percentages like " 45%|...".
            pct = _parse_percent(line)
            if pct is not None:
                progress_cb("separating", pct)
    proc.wait()
    if proc.returncode != 0:
        tail = "\n".join(log_lines[-15:])
        raise RuntimeError("Demucs failed (exit %d):\n%s" % (proc.returncode, tail))

    track_name = os.path.splitext(os.path.basename(mp3_path))[0]
    stem = _find_stem(demucs_out, track_name, "piano")
    if stem is None:
        raise RuntimeError("Demucs finished but piano stem not found")
    return stem


def _parse_percent(line):
    idx = line.find("%|")
    if idx <= 0:
        return None
    head = line[:idx].split()
    if not head:
        return None
    token = head[-1]
    try:
        return int(float(token))
    except ValueError:
        return None


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


def transcribe(piano_wav, progress_cb):
    """Transcribe piano stem to note + pedal events (with velocities)."""
    # Imported lazily: heavy modules, and the checkpoint download happens
    # on first construction.
    from piano_transcription_inference import PianoTranscription, sample_rate
    import librosa

    progress_cb("transcribing", 5)
    _ensure_checkpoint(progress_cb)
    # The package's own load_audio needs an audioread backend (ffmpeg),
    # which Windows lacks; the stem is a plain wav so soundfile handles it.
    audio, _ = librosa.load(piano_wav, sr=sample_rate, mono=True)
    progress_cb("transcribing", 15)
    transcriptor = PianoTranscription(
        device="cpu", checkpoint_path=CHECKPOINT_PATH)
    progress_cb("transcribing", 25)
    result = transcriptor.transcribe(audio, None)
    progress_cb("transcribing", 100)

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


def run_job(job_dir, mp3_path, progress_cb):
    """Full pipeline. Writes events.json and output.mid into job_dir."""
    progress_cb("separating", 0)
    piano_wav = separate_piano(mp3_path, job_dir, progress_cb)

    no_piano_wav = os.path.join(os.path.dirname(piano_wav), "no_piano.wav")
    if not os.path.exists(no_piano_wav):
        raise RuntimeError("Demucs finished but no_piano stem not found")

    trim_start, trim_end = detect_dead_space(mp3_path)
    accompaniment, encoder_delay_ms = encode_accompaniment(
        no_piano_wav, job_dir, progress_cb,
        trim_start=trim_start, trim_end=trim_end)

    notes, pedals = transcribe(piano_wav, progress_cb)

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
    }
