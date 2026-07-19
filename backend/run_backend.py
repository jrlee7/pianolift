"""Frozen-exe entry point for backend.exe (PyInstaller onefile).

The pipeline runs each conversion in a `multiprocessing.get_context("spawn")`
child (see app/main.py:_process). Under a onefile build the child re-executes
backend.exe, so `freeze_support()` must run first — otherwise every spawned
worker would boot a second uvicorn server instead of doing its job. Heavy
imports stay inside the __main__ guard so a re-imported module never starts
the server.
"""

import multiprocessing
import os
import sys

if __name__ == "__main__":
    # A --noconsole build starts with sys.stdout/stderr = None, which crashes
    # any library that writes to them (audio_separator's progress writes fail
    # with "'NoneType' object has no attribute 'write'"). Redirect to a log
    # file BEFORE freeze_support(): in a onefile build each conversion runs in
    # a spawned child that re-execs this entry, and freeze_support() runs that
    # child's job then exits -- it never reaches code placed after it, so a
    # redirect below freeze_support() would leave the separator/transcriber in
    # the child with a None stdout. Doing it first covers the server process
    # and every spawned worker.
    if sys.stdout is None or sys.stderr is None:
        try:
            log_dir = os.path.join(
                os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
                "PianoForge")
            os.makedirs(log_dir, exist_ok=True)
            stream = open(os.path.join(log_dir, "backend.log"),
                          "a", buffering=1, encoding="utf-8")
        except OSError:
            stream = open(os.devnull, "w")
        if sys.stdout is None:
            sys.stdout = stream
        if sys.stderr is None:
            sys.stderr = stream

    multiprocessing.freeze_support()

    import uvicorn
    from app.main import app
    uvicorn.run(app, host="127.0.0.1", port=8000)
