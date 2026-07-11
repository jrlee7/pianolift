"""Second-opinion transcription with Transkun V2 (semi-CRF, MIT).

Runs alongside the ByteDance high-resolution model as an independent
witness. The two models have complementary strengths measured on MAESTRO:
ByteDance leads on onset recall (F1 96.7) but marks note-offs at final
string damp (onset+offset+velocity F1 ~80.9); Transkun V2 regresses
key-release offsets and velocities jointly (onset+offset+velocity F1
93.1) and detects the sustain pedal independently. note_verify merges the
two: agreement is strong evidence a note is real, Transkun supplies the
better offset/velocity for agreed notes, and either model alone must pass
the stricter spectral bar.

The checkpoint ships inside the pip package (~an 18MB 2.0.pt), so unlike
the ByteDance model there is nothing to download at runtime.
"""

import numpy as np

_model = None  # loaded once per job process, reused for stem + any retries
_device = None


def _load_model():
    global _model, _device
    if _model is not None:
        return _model
    import torch
    import moduleconf
    from importlib import resources
    from . import pipeline

    _device = pipeline.compute_device()
    weight = str(resources.files("transkun") / "pretrained" / "2.0.pt")
    conf_path = str(resources.files("transkun") / "pretrained" / "2.0.conf")
    conf_mgr = moduleconf.parseFromFile(conf_path)
    TransKun = conf_mgr["Model"].module.TransKun
    conf = conf_mgr["Model"].config
    checkpoint = torch.load(weight, map_location=_device)
    model = TransKun(conf=conf).to(_device)
    state = checkpoint.get("best_state_dict") or checkpoint.get("state_dict")
    model.load_state_dict(state, strict=False)
    model.eval()
    _model = model
    return model


def transcribe(wav_path):
    """Transcribe a wav to (notes, pedals) event dicts.

    Notes carry Transkun's key-release offsets and velocities; pedals are
    its sustain (CC64) segments. Negative pitches in the raw output are
    control changes; only CC64 (sustain) maps to the Disklavier pedal.
    """
    import soundfile as sf
    import torch

    model = _load_model()
    data, sr = sf.read(wav_path, dtype="float32")
    if data.ndim == 1:
        data = data[:, None]
    peak = float(np.max(np.abs(data))) if len(data) else 0.0
    if peak > 0:  # same normalization the ByteDance pass gets: peak to
        # ~-0.4 dBFS, gain capped at +18 dB (see pipeline._peak_normalize)
        data = data * min(0.95 / peak, 8.0)
    if sr != model.fs:
        import soxr
        data = soxr.resample(data, sr, model.fs)

    with torch.no_grad():
        raw = model.transcribe(torch.from_numpy(data).to(_device),
                               discardSecondHalf=False)

    notes, pedals = [], []
    for ev in raw:
        if ev.pitch > 0:
            notes.append({
                "onset": round(float(ev.start), 4),
                "offset": round(float(ev.end), 4),
                "pitch": int(ev.pitch),
                "velocity": max(1, min(127, int(round(ev.velocity)))),
            })
        elif ev.pitch == -64:  # sustain pedal segment
            pedals.append({
                "onset": round(float(ev.start), 4),
                "offset": round(float(ev.end), 4),
            })
    notes.sort(key=lambda n: n["onset"])
    pedals.sort(key=lambda p: p["onset"])
    return notes, pedals
