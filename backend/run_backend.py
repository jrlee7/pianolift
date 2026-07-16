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
    multiprocessing.freeze_support()

    # --noconsole build has no stdout/stderr (sys.stdout is None), which
    # crashes any library that logs via print/sys.stdout.write. Redirect to
    # a log file next to the exe so uvicorn/torch/etc. always have a stream.
    if sys.stdout is None or sys.stderr is None:
        log_dir = os.path.join(os.environ.get("LOCALAPPDATA", "."), "PianoForge")
        os.makedirs(log_dir, exist_ok=True)
        log_file = open(os.path.join(log_dir, "backend.log"), "a", buffering=1, encoding="utf-8")
        sys.stdout = log_file
        sys.stderr = log_file

    import uvicorn
    from app.main import app
    uvicorn.run(app, host="127.0.0.1", port=8000)
