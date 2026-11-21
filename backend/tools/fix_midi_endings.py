"""Repair the End-of-Track of MIDIs made before renders learned end_sec.

The ENSPIRE ends a song at the MIDI's End-of-Track and starts the next one. Old
renders put End-of-Track at the last piano note, so the accompaniment's outro
was cut off (worst on chapter and playlist songs). This pushes End-of-Track out
to the end of the paired MP3 + 1 s. Notes, pedals and timing are untouched
(midi_writer.pad_midi_end rewrites only the final delta).

  folder PATH          every X.mid beside "X (no piano).mp3" (or X.mp3), e.g. a USB stick
  library              every song in the Firestore library (MP3 in Storage)
  restore BACKUP       put back what a previous --apply backed up

Dry run unless --apply. Before writing, the originals are saved under
--backup-dir (default ~/PianoForge backups). Songs with no notes, no MP3, or an
MP3 that can't be read are reported and left alone.

  backend/.venv/Scripts/python.exe backend/tools/fix_midi_endings.py folder E:\\
  backend/.venv/Scripts/python.exe backend/tools/fix_midi_endings.py library --account you@example.com --apply

Library mode authenticates with `gcloud auth print-access-token` (a project
owner's account), which goes through IAM, not the Firestore security rules.
"""

import argparse
import base64
import datetime
import io
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mido  # noqa: E402

from app import midi_writer  # noqa: E402

PAD_SEC = 1.0            # same as main.MIDI_END_PAD_SEC
BIG_GAP_SEC = 60.0       # flag: MP3 runs this much past the MIDI (check the song)
HEAD_BYTES = 256 * 1024  # enough for an ID3 tag + the first frame almost always

# ---------------------------------------------------------------- MP3 length

_BR = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
}
_SR = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}


def _frame(h, i):
    """Layer III frame header at h[i] -> (bitrate, rate, spf, side, length) or None."""
    if i + 4 > len(h) or h[i] != 0xFF or (h[i + 1] & 0xE0) != 0xE0:
        return None
    b1, b2, b3 = h[i + 1], h[i + 2], h[i + 3]
    ver, layer = (b1 >> 3) & 3, (b1 >> 1) & 3
    br_i, sr_i, pad = (b2 >> 4) & 15, (b2 >> 2) & 3, (b2 >> 1) & 1
    if ver == 1 or layer != 1 or br_i in (0, 15) or sr_i == 3:
        return None
    mpeg1 = ver == 3
    br = _BR[1 if mpeg1 else 2][br_i] * 1000
    sr = _SR[ver][sr_i]
    mono = (b3 >> 6) == 3
    side = (17 if mono else 32) if mpeg1 else (9 if mono else 17)
    length = (144 if mpeg1 else 72) * br // sr + pad
    return br, sr, 1152 if mpeg1 else 576, side, length


def mp3_seconds(read, size):
    """Duration of an MP3 from its header: the Xing/Info or VBRI frame count
    when there is one, else CBR bytes / bitrate. read(start, n) -> bytes.
    Within a frame (~26 ms) of a full decode for the files PianoForge writes."""
    head = read(0, HEAD_BYTES)
    start = 0
    if head[:3] == b"ID3":
        tag = ((head[6] & 0x7F) << 21 | (head[7] & 0x7F) << 14
               | (head[8] & 0x7F) << 7 | (head[9] & 0x7F))
        start = 10 + tag + (10 if head[5] & 0x10 else 0)
        head = read(start, HEAD_BYTES)  # album art can outgrow the first read
    for i in range(0, max(0, len(head) - 4)):
        f = _frame(head, i)
        if not f:
            continue
        br, sr, spf, side, length = f
        # a real frame is followed by another; a stray 0xFFE in junk is not
        if i + length + 4 <= len(head) and not _frame(head, i + length):
            continue
        x = i + 4 + side
        if head[x:x + 4] in (b"Xing", b"Info"):
            flags = int.from_bytes(head[x + 4:x + 8], "big")
            if flags & 1:
                return int.from_bytes(head[x + 8:x + 12], "big") * spf / sr
        v = i + 36
        if head[v:v + 4] == b"VBRI":
            return int.from_bytes(head[v + 14:v + 18], "big") * spf / sr
        return (size - start - i) * 8.0 / br
    return None


# ---------------------------------------------------------------- MIDI check


def inspect(data):
    """(length_sec, note_count) of a MIDI file's bytes."""
    mid = mido.MidiFile(file=io.BytesIO(data))
    notes = sum(1 for t in mid.tracks for m in t
                if m.type == "note_on" and m.velocity > 0)
    return float(mid.length), notes


def plan(name, data, audio_sec):
    """One song's verdict: dict with status ok / pad / skip and the new bytes."""
    row = {"name": name, "midiSec": None, "audioSec": audio_sec}
    if not data:
        return dict(row, status="skip", why="no MIDI")
    try:
        cur, notes = inspect(data)
    except Exception as e:  # noqa: BLE001
        return dict(row, status="skip", why="unreadable MIDI: %s" % e)
    row["midiSec"] = cur
    if notes == 0:
        return dict(row, status="skip", why="MIDI has no notes")
    if audio_sec is None:
        return dict(row, status="skip", why="no readable MP3")
    out, _ = midi_writer.pad_midi_end(data, audio_sec + PAD_SEC)
    if out is data:
        return dict(row, status="ok")
    # Check the result from its own bytes: same notes, End-of-Track where asked.
    new, new_notes = inspect(out)
    if new_notes != notes or new < audio_sec + PAD_SEC - 0.01:
        return dict(row, status="skip", why="padding check failed (%.2fs, %d/%d notes)"
                    % (new, new_notes, notes))
    row.update(status="pad", newSec=new, data=out)
    if audio_sec - cur > BIG_GAP_SEC:
        row["why"] = "MP3 runs %.0f s past the last note -- worth a listen" % (audio_sec - cur)
    return row


def report(rows, applied):
    pads = [r for r in rows if r["status"] == "pad"]
    oks = [r for r in rows if r["status"] == "ok"]
    solo = [r for r in rows if r["status"] == "solo"]
    skips = [r for r in rows if r["status"] == "skip"]
    for r in sorted(pads, key=lambda r: r["audioSec"] - r["midiSec"], reverse=True):
        print("  %s +%6.1fs  %7.1fs -> %7.1fs  %s%s" % (
            "fixed" if applied else "fix  ", r["audioSec"] - r["midiSec"],
            r["midiSec"], r["newSec"], r["name"],
            ("   (" + r["why"] + ")") if r.get("why") else ""))
    for r in skips:
        print("  skip              %s   (%s)" % (r["name"], r["why"]))
    print("\n%d %s, %d already run to the end of their MP3, %d skipped."
          % (len(pads), "fixed" if applied else "would be fixed", len(oks), len(skips)))
    if solo:
        print("%d MIDI-only (no MP3 to run to) -- nothing to fix." % len(solo))
    if pads and not applied:
        print("Dry run -- nothing written. Add --apply to write.")


def backup_path(args, kind):
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    d = os.path.join(os.path.expanduser(args.backup_dir), "%s-%s" % (kind, stamp))
    os.makedirs(d, exist_ok=True)
    return d


# ---------------------------------------------------------------- folder mode


def _pair(folder, stem, names):
    for cand in (stem + " (no piano).mp3", stem + ".mp3"):
        hit = names.get(cand.lower())
        if hit:
            return os.path.join(folder, hit)
    return None


def run_folder(args):
    root = os.path.abspath(args.path)
    if not os.path.isdir(root):
        sys.exit("not a folder: " + root)
    rows = []
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith((".", "$", "System Volume"))]
        names = {f.lower(): f for f in files}
        for f in sorted(files):
            if not f.lower().endswith(".mid") or f.startswith("._"):
                continue
            path = os.path.join(folder, f)
            mp3 = _pair(folder, f[:-4], names)
            audio = None
            if mp3:
                with open(mp3, "rb") as fh:
                    def read(start, n, fh=fh):
                        fh.seek(start)
                        return fh.read(n)
                    audio = mp3_seconds(read, os.path.getsize(mp3))
            with open(path, "rb") as fh:
                data = fh.read()
            row = plan(os.path.relpath(path, root), data, audio)
            if not mp3:
                row["status"] = "solo"  # piano-only, or a MIDI we didn't make
            row["path"] = path
            rows.append(row)
    if not rows:
        sys.exit("no .mid files under " + root)
    pads = [r for r in rows if r["status"] == "pad"]
    if args.apply and pads:
        bdir = backup_path(args, "folder")
        manifest = []
        for r in pads:
            dst = os.path.join(bdir, r["name"])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(r["path"], dst)
            manifest.append({"backup": r["name"], "path": r["path"]})
        with open(os.path.join(bdir, "manifest.json"), "w", encoding="utf-8") as fh:
            json.dump({"kind": "folder", "files": manifest}, fh, indent=1)
        print("Originals backed up to " + bdir)
        for r in pads:
            tmp = r["path"] + ".tmp"
            with open(tmp, "wb") as fh:
                fh.write(r["data"])
            os.replace(tmp, r["path"])
    report(rows, args.apply)


# ---------------------------------------------------------------- library mode


class Google:
    def __init__(self, project, account):
        self.project = project
        exe = shutil.which("gcloud") or shutil.which("gcloud.cmd")
        if not exe:
            sys.exit("gcloud not found on PATH")
        cmd = [exe, "auth", "print-access-token"] + ([account] if account else [])
        self.token = subprocess.check_output(cmd, text=True).strip()

    def call(self, url, method="GET", body=None, headers=None, raw=False):
        h = {"Authorization": "Bearer " + self.token,
             "x-goog-user-project": self.project}
        h.update(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                out = res.read()
        except urllib.error.HTTPError as e:
            raise RuntimeError("%s %s -> %s %s" % (method, url.split("?")[0], e.code,
                                                   e.read()[:300].decode("utf-8", "replace")))
        return out if raw else json.loads(out.decode("utf-8"))


def _docs_url(project, path=""):
    return ("https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents/%s"
            % (project, path))


def list_songs(g, collection):
    out, token = [], None
    while True:
        q = [("pageSize", "100")] + [("mask.fieldPaths", f) for f in
                                      ("title", "midiBase64", "mp3Path")]
        if token:
            q.append(("pageToken", token))
        page = g.call(_docs_url(g.project, collection) + "?" + urllib.parse.urlencode(q))
        for d in page.get("documents", []):
            f = d.get("fields", {})
            out.append({
                "name": d["name"], "updateTime": d["updateTime"],
                "title": f.get("title", {}).get("stringValue", "(untitled)"),
                "midiBase64": f.get("midiBase64", {}).get("stringValue") or "",
                "mp3Path": f.get("mp3Path", {}).get("stringValue"),
            })
        token = page.get("nextPageToken")
        if not token:
            return out


def storage_seconds(g, bucket, path):
    base = ("https://storage.googleapis.com/storage/v1/b/%s/o/%s"
            % (bucket, urllib.parse.quote(path, safe="")))
    size = int(g.call(base)["size"])

    def read(start, n):
        if start >= size:
            return b""
        end = min(size, start + n) - 1
        return g.call(base + "?alt=media", raw=True,
                      headers={"Range": "bytes=%d-%d" % (start, end)})
    return mp3_seconds(read, size)


def run_library(args):
    g = Google(args.project, args.account)
    bucket = args.bucket or (args.project + ".firebasestorage.app")
    songs = list_songs(g, args.collection)
    print("%d songs in %s/%s\n" % (len(songs), args.project, args.collection))
    rows = []
    for s in songs:
        audio, why = None, None
        if s["mp3Path"]:
            try:
                audio = storage_seconds(g, bucket, s["mp3Path"])
            except RuntimeError as e:
                why = "MP3 not readable: %s" % e
        data = base64.b64decode(s["midiBase64"]) if s["midiBase64"] else b""
        row = plan(s["title"], data, audio)
        if row["status"] == "skip" and why:
            row["why"] = why
        elif not s["mp3Path"]:
            row["status"] = "solo"
        row["song"] = s
        rows.append(row)
    pads = [r for r in rows if r["status"] == "pad"]
    if args.apply and pads:
        bdir = backup_path(args, "library")
        bfile = os.path.join(bdir, "songs.json")
        with open(bfile, "w", encoding="utf-8") as fh:
            json.dump({"kind": "library", "project": args.project, "songs": [
                {"name": r["song"]["name"], "title": r["song"]["title"],
                 "midiBase64": r["song"]["midiBase64"]} for r in pads]}, fh, indent=1)
        print("Originals backed up to " + bfile)
        failed = []
        for r in pads:
            s = r["song"]
            # updateTime precondition: a song edited since it was read is left alone
            q = urllib.parse.urlencode([("updateMask.fieldPaths", "midiBase64"),
                                        ("currentDocument.updateTime", s["updateTime"])])
            try:
                g.call("https://firestore.googleapis.com/v1/%s?%s" % (s["name"], q),
                       method="PATCH", body={"fields": {"midiBase64": {
                           "stringValue": base64.b64encode(r["data"]).decode("ascii")}}})
            except RuntimeError as e:
                failed.append(r)
                r.update(status="skip", why="write failed: %s" % e)
        if failed:
            print("%d writes failed (left as they were)." % len(failed))
    report(rows, args.apply)


# ---------------------------------------------------------------- restore


def run_restore(args):
    p = args.backup
    if os.path.isdir(p):
        p = os.path.join(p, "manifest.json") if os.path.exists(
            os.path.join(p, "manifest.json")) else os.path.join(p, "songs.json")
    with open(p, encoding="utf-8") as fh:
        b = json.load(fh)
    if b["kind"] == "folder":
        bdir = os.path.dirname(p)
        for f in b["files"]:
            if args.apply:
                shutil.copy2(os.path.join(bdir, f["backup"]), f["path"])
            print("  %s %s" % ("restored" if args.apply else "would restore", f["path"]))
    else:
        g = Google(b["project"], args.account)
        for s in b["songs"]:
            if args.apply:
                g.call("https://firestore.googleapis.com/v1/%s?updateMask.fieldPaths=midiBase64"
                       % s["name"], method="PATCH",
                       body={"fields": {"midiBase64": {"stringValue": s["midiBase64"]}}})
            print("  %s %s" % ("restored" if args.apply else "would restore", s["title"]))
    if not args.apply:
        print("Dry run -- add --apply to restore.")


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--apply", action="store_true", help="write (default: dry run)")
    common.add_argument("--backup-dir", default="~/PianoForge backups")
    common.add_argument("--account", help="gcloud account for library/restore")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="mode", required=True)
    f = sub.add_parser("folder", parents=[common])
    f.add_argument("path")
    lib = sub.add_parser("library", parents=[common])
    lib.add_argument("--project", default="pianolift-jl")
    lib.add_argument("--bucket")
    lib.add_argument("--collection", default="songs")
    r = sub.add_parser("restore", parents=[common])
    r.add_argument("backup")
    args = ap.parse_args()
    {"folder": run_folder, "library": run_library, "restore": run_restore}[args.mode](args)


if __name__ == "__main__":
    main()
