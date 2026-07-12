#!/usr/bin/env python
"""Build backend.exe with PyInstaller (onefile).

Entry point is run_backend.py (not app/main.py): the pipeline runs each job in
a `multiprocessing spawn` child that re-executes the exe, so the frozen entry
must call multiprocessing.freeze_support() before anything else. app/main.py's
own __main__ block doesn't, so building it directly would make every worker
boot a second uvicorn instead of transcribing.

Run from the backend/ directory with the project venv active:
    .venv\\Scripts\\python build_exe.py
"""

import os
from PyInstaller.__main__ import run

backend_dir = os.path.dirname(os.path.abspath(__file__))
repo_root = os.path.dirname(backend_dir)

# Packages whose data files / dynamically-loaded submodules PyInstaller's static
# analysis misses:
#   audio_separator            - model registry YAMLs (the big ckpt downloads at runtime)
#   piano_transcription_inference - bundled resources
#   transkun                   - pretrained/ checkpoint (ships in the wheel) +
#                                model modules loaded dynamically via moduleconf
#   moduleconf                 - transkun's dynamic model loader
#   yt_dlp_ejs                 - JS challenge solver shipped as package data
collect_all = [
    'audio_separator',
    'piano_transcription_inference',
    'transkun',
    'moduleconf',
    'yt_dlp_ejs',
]

# Imported lazily (inside functions) or via spawn, so name them explicitly.
hidden = [
    'app.job_runner',   # multiprocessing spawn target
    'librosa', 'scipy', 'sklearn', 'soundfile', 'mido', 'yt_dlp',
]

args = [
    'run_backend.py',
    '--onefile',
    '--console',
    '--name', 'backend',
    '--distpath', repo_root,          # backend.exe lands at repo root (electron-builder extraResources)
    '--workpath', os.path.join(backend_dir, 'build', 'work'),
    '--specpath', os.path.join(backend_dir, 'build'),
    '--noupx',                        # UPX corrupts torch's native DLLs
    '--noconfirm',
    '--collect-submodules', 'uvicorn',  # uvicorn[standard] protocol/loop modules load dynamically
]
for pkg in collect_all:
    args += ['--collect-all', pkg]
for name in hidden:
    args += ['--hidden-import', name]

print("Building backend.exe with args:\n  " + " ".join(args))
run(args)
