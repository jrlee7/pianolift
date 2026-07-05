# PianoLift 🎹

Turn an MP3 into a Yamaha Disklavier ENSPIRE performance: extract the piano part,
transcribe it to MIDI with **dynamics (velocities)** and **sustain pedal (CC64)**,
and play the MIDI on the piano while the original MP3 supplies vocals and the
rest of the band through the ENSPIRE speakers.

## How it works

1. **Separation** — [Demucs](https://github.com/facebookresearch/demucs)
   (`htdemucs_6s`, 6-stem model) isolates the piano from the mix.
2. **Transcription** — ByteDance's
   [high-resolution piano transcription](https://github.com/bytedance/piano_transcription)
   converts the piano stem to note events with per-note velocity **and**
   sustain-pedal events.
3. **MIDI render** — a Type-0 Standard MIDI File is written, zero-aligned to the
   MP3 timeline (second 0 = second 0), so starting both together keeps them in sync.

## Setup

### Backend (Python 3.12)

```cmd
cd backend
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python -m pip install -r requirements.txt
```

First run downloads model checkpoints (~500 MB total).

### Frontend

```cmd
cd frontend
npm install
copy .env.example .env   # fill in Firebase web config (optional — enables cloud library)
```

### Run

```cmd
run-backend.cmd    # FastAPI on :8000
run-frontend.cmd   # Vite on :5173
```

Open http://localhost:5173, drop an MP3, wait (~5–15 min on CPU), tweak the
velocity/pedal/offset controls, download the `.mid`.

## Playing on the Disklavier ENSPIRE

1. Copy the downloaded `.mid` **and** the original `.mp3` to a USB stick.
2. Play the MIDI on the ENSPIRE (keys move) and start the MP3 at the same moment —
   both share the same timeline.
3. If the piano feels early or late, adjust the **Timing offset** slider and
   re-download.

## Controls

| Control | Effect |
|---|---|
| Velocity floor/ceiling | Clamp dynamics into a range the room can take |
| Dynamics curve (gamma) | <1 flattens dynamics, >1 exaggerates them |
| Timing offset | Shift every MIDI event ±500 ms |
| Sustain pedal | Toggle CC64 events on/off |

## Notes on quality

Piano-forward mixes (piano + vocals) transcribe well. Dense mixes leak other
instruments into the piano stem and produce ghost notes — expect to audition the
extracted stem (playable in the result view) to judge before trusting the MIDI.

## Troubleshooting

- **`No module named demucs.separate`** — broken demucs install; run
  `pip install --force-reinstall --no-deps --no-cache-dir --no-binary demucs demucs==4.0.1`
  (same trick with `dora-search` if `dora.explore` is missing).
- **`TorchCodec is required`** — torchaudio too new; this project pins
  torch/torchaudio 2.6.0 (see requirements.txt).
- **Transcription checkpoint** (~165 MB) auto-downloads to
  `~/piano_transcription_inference_data/` on first run.

## Firebase library (optional)

Converted MIDI files (small) can be saved to Firestore for access from any device.
Fill `frontend/.env` with a Firebase web app config. MP3s stay local.
