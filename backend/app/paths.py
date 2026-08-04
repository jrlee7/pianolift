"""Where the packaged app keeps its persistent data.

A PyInstaller *onefile* build's __file__ resolves inside the per-run temp
extraction dir (%TEMP%\\_MEIxxxxx), wiped every launch, so frozen mode has to
persist jobs/media/sheet_jobs to a stable per-user location instead. main.py
and sheet_routes.py both need the same root, so it lives here once.

Hardening (2026-08-04): a fresh install once showed "0 songs" because the
installer launched the app **elevated**, and in that context %LOCALAPPDATA%
didn't point at the logged-in user's profile — so the frozen build derived a
different, empty data dir while the real jobs sat untouched under
C:\\Users\\<me>\\AppData\\Local. resolve_base_dir() no longer trusts a single
env var: it collects every plausible Local-AppData root, throws out the
system/service profile, and prefers whichever one *already* holds our data.
"""

import os
import sys


def _known_folder_local_appdata():
    """SHGetKnownFolderPath(FOLDERID_LocalAppData) — the canonical Windows
    answer, independent of the (spoofable/unset) %LOCALAPPDATA% env var.
    Returns None off Windows or on any failure."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        # {F1B32785-6FBA-4FCF-9D55-7B8E7F157091}
        folderid = GUID(0xF1B32785, 0x6FBA, 0x4FCF,
                        (0x9D, 0x55, 0x7B, 0x8E, 0x7F, 0x15, 0x70, 0x91))
        ptr = ctypes.c_wchar_p()
        res = ctypes.windll.shell32.SHGetKnownFolderPath(
            ctypes.byref(folderid), 0, None, ctypes.byref(ptr))
        if res != 0:
            return None
        try:
            return ptr.value
        finally:
            ctypes.windll.ole32.CoTaskMemFree(ptr)
    except Exception:
        return None


def _is_bad_root(path):
    """The system/service profiles are never the interactive user's data dir —
    an app that lands there was launched in the wrong (service/elevated-system)
    context, exactly the 0-songs failure we're guarding against."""
    low = path.lower()
    return ("system32\\config\\systemprofile" in low
            or "\\serviceprofiles\\" in low)


def _windows_local_appdata():
    # Priority order of where the user's Local AppData might be. The known-
    # folder API first (most reliable), then the env var, then USERPROFILE.
    candidates = []
    kf = _known_folder_local_appdata()
    if kf:
        candidates.append(kf)
    env = os.environ.get("LOCALAPPDATA")
    if env:
        candidates.append(env)
    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        candidates.append(os.path.join(userprofile, "AppData", "Local"))

    sane = [c for c in candidates if c and not _is_bad_root(c)]

    # Prefer a root that ALREADY holds our data: if one env var points at an
    # empty dir but the real jobs live under another root, follow the data.
    for c in sane:
        if os.path.isdir(os.path.join(c, "PianoForge", "data")):
            return c
    if sane:
        return sane[0]
    # Everything looked bad/unset — last-ditch, better than crashing.
    return env or os.path.expanduser("~")


def resolve_base_dir():
    """Absolute path of the persistent data root. Dev keeps the repo-relative
    backend/ dir (so `git status` shows local test jobs); frozen builds use a
    stable per-user location. Ensures the dir exists before returning."""
    if getattr(sys, "frozen", False):
        if sys.platform == "win32":
            root = _windows_local_appdata()
        else:
            root = (os.environ.get("XDG_DATA_HOME")
                    or os.path.join(os.path.expanduser("~"), ".local", "share"))
        base = os.path.join(root, "PianoForge", "data")
    else:
        # …/backend  (this file is …/backend/app/paths.py)
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs(base, exist_ok=True)
    return base
