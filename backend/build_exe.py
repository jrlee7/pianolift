#!/usr/bin/env python
"""Build backend.exe with PyInstaller."""

import os
import sys
from PyInstaller.__main__ import run

# Get paths
backend_dir = os.path.dirname(os.path.abspath(__file__))
venv_lib = os.path.join(backend_dir, '.venv', 'Lib', 'site-packages')

# Audio libs need data files
hidden_imports = [
    'audio_separator',
    'piano_transcription_inference',
    'librosa',
    'scipy',
    'sklearn',
    'yt_dlp',
]

# Collect data files from site-packages
datas = []

# audio-separator models and weights
audio_sep_path = os.path.join(venv_lib, 'audio_separator')
if os.path.exists(audio_sep_path):
    datas.append((os.path.join(audio_sep_path, 'models'), 'audio_separator/models'))

# piano_transcription_inference data
piano_path = os.path.join(venv_lib, 'piano_transcription_inference')
if os.path.exists(piano_path):
    datas.append((os.path.join(piano_path, 'resources'), 'piano_transcription_inference/resources'))

# Build args
args = [
    'app/main.py',
    '--onefile',
    '--name', 'backend',
    '--distpath', '..',
    '--specpath', 'build',
    '--buildpath', 'build/build',
    '--console',
    '--add-data', f'{os.path.dirname(backend_dir)}/backend/jobs;jobs',
]

# Add hidden imports
for imp in hidden_imports:
    args.extend(['--hidden-import', imp])

# yt-dlp's YouTube JS challenge solver ships .js files as package data
args.extend(['--collect-all', 'yt_dlp_ejs'])

# Add data files
for src, dest in datas:
    if os.path.exists(src):
        args.extend(['--add-data', f'{src}{os.pathsep}{dest}'])

print(f"Building with args: {args}")
run(args)
