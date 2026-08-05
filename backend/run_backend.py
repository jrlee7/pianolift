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

    # Pre-flight: never start a SECOND server on :8000. Windows lets two
    # sockets bind the same port (no SO_EXCLUSIVEADDRUSE), so a duplicate
    # backend doesn't fail loudly -- both "run", and the OS splits requests
    # between them. If the duplicate resolved a different/empty data dir, the
    # UI's job-list polls alternate between the real server (N songs) and the
    # empty one (0 songs), so the Convert page flickers empty. Duplicates arise
    # from an auto-update relaunch racing the old backend, a leftover process,
    # or a spawn-worker that slips past freeze_support. If a backend already
    # answers on :8000, bow out instead of stealing half its traffic.
    #
    # This runs only in a real server launch: a multiprocessing spawn-worker
    # is handled by freeze_support() above, which runs its job and exits before
    # reaching here, so genuine conversion workers are unaffected.
    import socket
    import urllib.request

    def _backend_already_running(host="127.0.0.1", port=8000):
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.settimeout(0.5)
        try:
            probe.connect((host, port))
        except OSError:
            return False  # nothing listening -> we're the first, proceed
        finally:
            probe.close()
        # Something's on the port. Confirm it's actually a live PianoForge
        # backend (answers the job list) and not an unrelated service, so we
        # don't silently refuse to start over a coincidental port collision.
        try:
            with urllib.request.urlopen(
                    "http://%s:%d/api/jobs" % (host, port), timeout=1.5) as r:
                return r.status == 200
        except Exception:
            return False

    if _backend_already_running():
        print("PianoForge backend already running on :8000 -- "
              "not starting a second server.", flush=True)
        sys.exit(0)

    import uvicorn
    from app.main import app
    uvicorn.run(app, host="127.0.0.1", port=8000)
