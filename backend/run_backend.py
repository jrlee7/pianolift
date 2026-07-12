"""Frozen-exe entry point for backend.exe (PyInstaller onefile).

The pipeline runs each conversion in a `multiprocessing.get_context("spawn")`
child (see app/main.py:_process). Under a onefile build the child re-executes
backend.exe, so `freeze_support()` must run first — otherwise every spawned
worker would boot a second uvicorn server instead of doing its job. Heavy
imports stay inside the __main__ guard so a re-imported module never starts
the server.
"""

import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()
    import uvicorn
    from app.main import app
    uvicorn.run(app, host="127.0.0.1", port=8000)
