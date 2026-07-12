# PianoForge 🎹

Turn an MP3 into a Yamaha Disklavier ENSPIRE performance: extract the piano part,
transcribe it to MIDI with **dynamics (velocities)** and **sustain pedal (CC64)**,
and play the MIDI on the piano while the original MP3 supplies vocals and the
rest of the band through the ENSPIRE speakers.

## How it works

1. **Separation** — [BS-Roformer-SW](https://huggingface.co/lainlives/audio-separator-models)
   (6-stem model, via [audio-separator](https://github.com/nomadkaraoke/python-audio-separator))
   isolates the piano from the mix.
2. **Transcription** — ByteDance's
   [high-resolution piano transcription](https://github.com/bytedance/piano_transcription)
   converts the piano stem to note events with per-note velocity **and**
   sustain-pedal events.
3. **Accompaniment** — the piano-less stem (vocals + band) is encoded to a
   320 kbps MP3; this is what plays through the ENSPIRE speakers so the real
   piano isn't doubled by a recorded one.
4. **MIDI render** — a Type-0 Standard MIDI File is written, zero-aligned to the
   MP3 timeline (second 0 = second 0), so starting both together keeps them in sync.

If the source is already piano-only (no accompaniment to remove), check
**"This file is piano-only"** on upload to skip separation entirely — the file
is transcribed directly, which is much faster and skips the ffmpeg/model
download on first use.

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

1. Copy the downloaded `.mid` **and** the accompaniment `.mp3` (piano removed)
   to a USB stick.
2. Play the MIDI on the ENSPIRE (keys move) and start the MP3 at the same moment —
   both share the same timeline.
3. If the piano feels early or late, adjust the **Timing offset** slider and
   re-download.

## E-SEQ output (floppy-era Disklaviers)

Alongside MIDI, each conversion can be downloaded as a Yamaha **E-SEQ `.FIL`**
for pre-SMF Disklaviers (e.g. 1995 Mark II units). Format reverse-engineered
from real PianoSoft releases; timing runs on the measured 748.8 units/sec
Yamaha clock (see `backend/app/eseq_writer.py` for the full byte-level spec).

Easiest playback path: **⬇ Gotek floppy image (.hfe)** — a complete,
ready-to-play virtual floppy (FAT12 + `PIANODIR.FIL` index + the song,
MFM-encoded HxC image). Copy it to the Gotek/Nalbantov USB stick as
`DSKAxxxx.hfe` (pick a free slot number), select that slot on the emulator,
press play on the piano. Formats cloned from a working PianoSoft disk;
see `backend/app/disk_writer.py` for the PIANODIR byte spec.

The raw `.FIL` download remains for users who build disks with their own
tools (E-SEQ Explorer, APS MIDI Prep).

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

- **`TorchCodec is required`** — torchaudio too new; this project pins
  torch/torchaudio 2.6.0 (see requirements.txt).
- **Separation checkpoint** (~700 MB, `BS-Roformer-SW.ckpt`) auto-downloads
  via `audio-separator` on first run.
- **Transcription checkpoint** (~165 MB) auto-downloads to
  `~/piano_transcription_inference_data/` on first run.

## Firebase library (optional)

Save conversions to the cloud for access from any device. The baked **MIDI**
lives in Firestore (small, well under the 1 MiB doc cap); the piano-removed
**accompaniment MP3** lives in Firebase **Storage** (5 GB free ≈ ~500 songs at
320 kbps). Fill `frontend/.env` with a Firebase web app config (including
`VITE_FIREBASE_STORAGE_BUCKET`).

From the **Library** tab you can multi-select songs and **Copy to USB folder…** —
pick a folder (e.g. on the ENSPIRE USB stick) and each song's `.mid` +
accompaniment `.mp3` is written straight into it. Runs in the browser; needs
Chrome/Edge or the desktop app (File System Access API).

### One-time cloud setup

```cmd
firebase deploy --only firestore:rules,storage
```

The `storage.rules` allow open read/write (personal single-family app — don't
store anything sensitive).

**Storage must be enabled** first: Firebase console → Build → Storage → Get
started. Newest projects may put the default bucket on the Blaze plan, which
still includes the 5 GB free allowance.

**CORS** — the Library's *Copy to USB folder* fetches MP3 bytes from Storage via
JavaScript, which the browser blocks cross-origin until the bucket allows it.
Playback and archiving don't need this; the byte-level copy does. Apply once:

```cmd
gsutil cors set cors.json gs://<your-storage-bucket>
```

(`cors.json` in the repo root allows read-only `GET` from any origin; narrow
`origin` to your app URL if you prefer.)
