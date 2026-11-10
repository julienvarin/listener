"""Scan local music files into data/digital.enc, the digital shelf merged into the library by build_data.py.

The files stay on this computer; only their tags go into the bundle, sealed with DIGITAL_KEY (env, or the
git-ignored .digital_key, created on first run: add the same value as the DIGITAL_KEY repo secret).
Tracks are grouped into releases by album tag (single tracks without one stand alone). Every release gets
artwork: the album cover on Deezer, else the cover of the album the track is on, else the picture embedded
in the files (shrunk with macOS sips and kept inside the encrypted bundle), else iTunes, else the artist's photo.

  .venv/bin/python scripts/digital.py ~/Documents/04-music-files
"""

import argparse
import base64
import json
import subprocess
import tempfile
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path

import mutagen
from mutagen.id3 import ID3

sys.path.insert(0, str(Path(__file__).parent))
from build_data import norm
from seed_clusters import load_key, seal, unseal

AUDIO = {".mp3", ".flac", ".aif", ".aiff", ".wav", ".m4a", ".ogg", ".opus"}
FRAMES = {"artist": "TPE1", "title": "TIT2", "album": "TALB", "albumartist": "TPE2", "date": "TDRC", "genre": "TCON", "label": "TPUB", "tracknumber": "TRCK"}
KEY_FILE = Path(".digital_key")


def read_tags(path: Path) -> dict:
    try:
        f = mutagen.File(path, easy=True)
    except Exception:
        f = None
    tags = getattr(f, "tags", None) or {}
    out = {}
    for k, frame in FRAMES.items():
        if isinstance(tags, ID3):  # AIFF and WAV carry raw ID3 frames, not the easy interface
            v = tags.get(frame)
            v = v.text if v else None
        else:
            v = tags.get(k) or (tags.get("organization") if k == "label" else None)
        out[k] = str(v[0]).strip() if v else ""
    out["path"] = path
    out["length"] = getattr(getattr(f, "info", None), "length", 0) or 0
    if not (out["artist"] and out["title"]):  # untagged: "Artist - Title.aiff"
        m = re.match(r"(?:\d+[-. ]+)*(.+?)\s+-\s+(.+)", path.stem.replace("_", " "))
        out["artist"] = out["artist"] or (m.group(1) if m else "")
        out["title"] = out["title"] or (m.group(2) if m else path.stem)
    return out


def release_id(key: str) -> int:
    # ponytail: crc32 into 1e9 slots, collisions unlikely below ~10k releases; use a longer hash past that
    return -(zlib.crc32(key.encode()) % 1_000_000_000 + 1)  # negative, so it never clashes with a Discogs id


def scan(folders: list) -> tuple:
    groups, paths = {}, {}
    for folder in folders:
        for p in sorted(Path(folder).expanduser().rglob("*")):
            if p.suffix.lower() not in AUDIO or p.name.startswith("."):
                continue
            t = read_tags(p)
            artist = t["albumartist"] or t["artist"]
            key = f"{norm(artist)}|{norm(t['album'])}" if t["album"] else f"{norm(t['artist'])}|{norm(t['title'])}|single"
            added = datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
            g = groups.setdefault(key, {"t": t, "artist": artist, "files": [], "added": added})
            g["files"].append(t)
            g["added"] = max(g["added"], added)
    releases = []
    for key, g in groups.items():
        t = g["t"]
        g["files"].sort(key=lambda x: int(re.match(r"\d*", x["tracknumber"]).group() or 0))
        year = re.match(r"\d{4}", t["date"])
        paths[release_id(key)] = [f["path"] for f in g["files"]]
        releases.append({
            "id": release_id(key),
            "digital": True,
            "master": None,
            "title": t["album"] or t["title"],
            "artists": [g["artist"]] if g["artist"] else [],
            "artist_ids": [],
            "labels": [{"name": t["label"], "catno": "", "id": None}] if t["label"] else [],
            "year": int(year.group()) if year else None,
            "formats": ["Digital"],
            "descriptions": [],
            "genres": [t["genre"]] if t["genre"] else [],
            "styles": [],
            "cover": "",
            "thumb": "",
            "added": g["added"],
            "rating": 0,
            "copies": 1,
            "notes": {},
            "country": "",
            "videos": [],
            "tracks": [{
                "pos": str(i + 1) if len(g["files"]) > 1 else "",
                "title": f["title"],
                "dur": f"{int(f['length'] // 60)}:{int(f['length'] % 60):02d}" if f["length"] else "",
                **({"artists": [f["artist"]]} if f["artist"] and f["artist"] != g["artist"] else {}),
            } for i, f in enumerate(g["files"])],
        })
    return releases, paths


def embedded_art(paths: list) -> str:
    """The first picture embedded in one of the files, as a 200px JPEG data URI."""
    for p in paths:
        try:
            f = mutagen.File(p)
        except Exception:
            continue
        tags = getattr(f, "tags", None) or {}
        pics = [tags[k].data for k in tags.keys() if k.startswith("APIC")] if isinstance(tags, ID3) else []
        pics += [bytes(c) for c in (tags.get("covr") or [])] if not isinstance(tags, ID3) else []
        pics += [x.data for x in getattr(f, "pictures", [])]
        if not pics:
            continue
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d, "in"), Path(d, "out.jpg")
            src.write_bytes(pics[0])
            done = subprocess.run(["sips", "-Z", "200", "-s", "format", "jpeg", "-s", "formatOptions", "60", str(src), "--out", str(dst)], capture_output=True)
            if done.returncode == 0 and dst.exists():
                return "data:image/jpeg;base64," + base64.b64encode(dst.read_bytes()).decode()
    return ""


def itunes_art(r: dict) -> str:
    artist = r["artists"][0] if r["artists"] else ""
    time.sleep(3)  # iTunes Search allows ~20 requests a minute
    url = "https://itunes.apple.com/search?" + urllib.parse.urlencode({"term": f"{artist} {r['title']}", "entity": "album", "limit": "10"})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "listener/1.0"}), timeout=20) as res:
            results = json.load(res).get("results", [])
    except (OSError, ValueError):
        return ""
    for x in results:
        name = norm(x.get("artistName", ""))
        if artist and (norm(artist) in name or name in norm(artist)) and x.get("artworkUrl100"):
            return x["artworkUrl100"].replace("100x100bb", "600x600bb")
    return ""


def deezer(path: str, **q) -> list:
    time.sleep(0.12)  # Deezer allows 50 requests per 5 seconds
    url = f"https://api.deezer.com/{path}?" + urllib.parse.urlencode(q)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "listener/1.0"}), timeout=20) as r:
            return json.load(r).get("data") or []
    except (OSError, ValueError):
        return []


def find_cover(r: dict, paths: list) -> tuple:
    """Album cover, else the cover of the album the first track is on, else embedded art, iTunes, the artist's photo."""
    artist = r["artists"][0] if r["artists"] else ""
    same = lambda name: bool(artist) and (norm(artist) in norm(name) or norm(name) in norm(artist))
    for x in deezer("search/album", q=f'artist:"{artist}" album:"{r["title"]}"'):
        if same(x.get("artist", {}).get("name", "")) and x.get("cover_xl"):
            return x["cover_xl"], x["cover_medium"]
    for x in deezer("search", q=f'artist:"{artist}" track:"{r["tracks"][0]["title"]}"'):
        if same(x.get("artist", {}).get("name", "")) and x.get("album", {}).get("cover_xl"):
            return x["album"]["cover_xl"], x["album"]["cover_medium"]
    if art := embedded_art(paths) or itunes_art(r):
        return art, art
    for x in deezer("search/artist", q=artist) if artist else []:
        # Deezer's placeholder for artists without a photo has an empty image hash: /images/artist//
        if same(x.get("name", "")) and x.get("picture_xl") and "/artist//" not in x["picture_xl"]:
            return x["picture_xl"], x["picture_medium"]
    return "", ""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folders", nargs="+")
    ap.add_argument("--out", default="data/digital.enc")
    args = ap.parse_args()

    if os.environ.get("DIGITAL_KEY"):
        key = load_key(os.environ["DIGITAL_KEY"])
    elif KEY_FILE.exists():
        key = load_key(KEY_FILE.read_text())
    else:
        key = os.urandom(32)
        KEY_FILE.write_text(base64.b64encode(key).decode())
        print(f"new key in {KEY_FILE}: set it as the DIGITAL_KEY repo secret (gh secret set DIGITAL_KEY < {KEY_FILE})", file=sys.stderr)
    out = Path(args.out)
    old = {r["id"]: r for r in unseal(out.read_bytes(), key)["releases"]} if out.exists() else {}

    releases, paths = scan(args.folders)
    print(f"{sum(len(r['tracks']) for r in releases)} files in {len(releases)} releases", file=sys.stderr)
    for n, r in enumerate(releases, 1):
        prev = old.get(r["id"], {})
        r["cover"], r["thumb"] = (prev["cover"], prev["thumb"]) if prev.get("cover") else find_cover(r, paths[r["id"]])
        if n % 100 == 0:
            print(f"  artwork {n}/{len(releases)}", file=sys.stderr)
    print(f"artwork found for {sum(bool(r['cover']) for r in releases)} of {len(releases)}", file=sys.stderr)
    out.write_bytes(seal({"releases": releases}, key))


if __name__ == "__main__":
    main()
