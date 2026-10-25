"""Fetch a Discogs collection and write it as a password-encrypted bundle.

Env: DISCOGS_TOKEN, DISCOGS_USERNAME, LISTENER_PASSWORD, GIST_TOKEN (optional).
Release details already present in the previous bundle are reused, so only
new additions plus the stalest market stats (--refresh) hit the per-release
endpoint (Discogs allows ~60 req/min).
"""

import argparse
import gzip
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

API = "https://api.discogs.com"
MAGIC = b"LSN1"
ITERATIONS = 600_000
YT_ID = re.compile(r"(?:v=|youtu\.be/|/embed/)([A-Za-z0-9_-]{11})")


def derive_key(password: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(password.encode())


def encrypt(payload: dict, password: str, salt: bytes | None = None) -> bytes:
    # A stable salt keeps the key that browsers remember valid across rebuilds.
    salt, iv = salt or os.urandom(16), os.urandom(12)
    raw = gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), mtime=0)
    ct = AESGCM(derive_key(password, salt, ITERATIONS)).encrypt(iv, raw, None)
    return MAGIC + struct.pack(">I", ITERATIONS) + salt + iv + ct


def decrypt(blob: bytes, password: str) -> dict:
    assert blob[:4] == MAGIC, "not a listener bundle"
    (iterations,) = struct.unpack(">I", blob[4:8])
    salt, iv, ct = blob[8:24], blob[24:36], blob[36:]
    raw = AESGCM(derive_key(password, salt, iterations)).decrypt(iv, ct, None)
    return json.loads(gzip.decompress(raw))


class Discogs:
    def __init__(self, token: str):
        self.headers = {"Authorization": f"Discogs token={token}", "User-Agent": "listener/1.0"}
        self.last = 0.0

    def get(self, path: str) -> dict:
        for attempt in range(6):
            wait = 1.05 - (time.monotonic() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            req = urllib.request.Request(API + path, headers=self.headers)
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return {}
                if e.code not in (429, 500, 502, 503, 504):
                    raise
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(10 * (attempt + 1))
        raise RuntimeError(f"giving up on {path}")


def names(items: list) -> list:
    return [re.sub(r" \(\d+\)$", "", a["name"]) for a in items or []]


def summarize(basic: dict) -> dict:
    return {
        "id": basic["id"],
        "master": basic.get("master_id") or None,
        "title": basic["title"],
        "artists": names(basic.get("artists")),
        "labels": [{"name": re.sub(r" \(\d+\)$", "", l["name"]), "catno": l.get("catno", "")} for l in basic.get("labels") or []],
        "year": basic.get("year") or None,
        "formats": sorted({f["name"] for f in basic.get("formats") or []}),
        "descriptions": sorted({d for f in basic.get("formats") or [] for d in f.get("descriptions") or []}),
        "genres": basic.get("genres") or [],
        "styles": basic.get("styles") or [],
        "cover": basic.get("cover_image") or basic.get("thumb") or "",
        "thumb": basic.get("thumb") or "",
    }


def details(release: dict) -> dict:
    tracks = []
    for t in release.get("tracklist") or []:
        if t.get("type_") not in (None, "track"):
            continue
        track = {"pos": t.get("position", ""), "title": t.get("title", ""), "dur": t.get("duration", "")}
        if t.get("artists"):
            track["artists"] = names(t["artists"])
        tracks.append(track)
    videos = []
    for v in release.get("videos") or []:
        m = YT_ID.search(v.get("uri", ""))
        if m:
            videos.append({"yt": m.group(1), "title": v.get("title", ""), "dur": v.get("duration", 0)})
    community = release.get("community") or {}
    return {
        "country": release.get("country", ""),
        "released": release.get("released", ""),
        "tracks": tracks,
        "videos": videos,
        "have": community.get("have", 0),
        "want": community.get("want", 0),
        "community_rating": (community.get("rating") or {}).get("average", 0),
        "votes": (community.get("rating") or {}).get("count", 0),
        "lowest_price": release.get("lowest_price"),
        "for_sale": release.get("num_for_sale", 0),
        "stats_at": datetime.now(timezone.utc).date().isoformat(),
    }


DETAIL_KEYS = ("country", "released", "tracks", "videos", "have", "want", "community_rating", "votes", "lowest_price", "for_sale", "stats_at")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/library.enc")
    ap.add_argument("--limit", type=int, default=0, help="max new releases to detail this run (0 = all)")
    ap.add_argument("--refresh", type=int, default=250, help="re-fetch market stats for this many stalest releases")
    args = ap.parse_args()

    token, user, password = (os.environ.get(k) for k in ("DISCOGS_TOKEN", "DISCOGS_USERNAME", "LISTENER_PASSWORD"))
    if not (token and user and password):
        sys.exit("DISCOGS_TOKEN, DISCOGS_USERNAME and LISTENER_PASSWORD are required")
    out = Path(args.out)

    cache, positions, salt = {}, {}, None
    if out.exists():
        try:
            blob = out.read_bytes()
            previous = decrypt(blob, password)["releases"]
            cache = {r["id"]: r for r in previous if "stats_at" in r}
            positions = {r["id"]: r["xy"] for r in previous if "xy" in r}
            salt = blob[8:24]
        except Exception as e:
            print(f"previous bundle unreadable ({e}); starting fresh", file=sys.stderr)

    api = Discogs(token)
    fields = {f["id"]: f["name"] for f in api.get(f"/users/{user}/collection/fields").get("fields", [])}
    releases, seen, page = [], {}, 1
    while True:
        data = api.get(f"/users/{user}/collection/folders/0/releases?per_page=100&page={page}&sort=added&sort_order=desc")
        for item in data.get("releases", []):
            rid = item["id"]
            if rid in seen:
                seen[rid]["copies"] += 1
                continue
            r = summarize(item["basic_information"])
            r["added"] = item.get("date_added", "")
            r["rating"] = item.get("rating", 0)
            r["copies"] = 1
            r["notes"] = {fields.get(n["field_id"], str(n["field_id"])): n["value"] for n in item.get("notes") or [] if n.get("value")}
            seen[rid] = r
            releases.append(r)
        if page >= data.get("pagination", {}).get("pages", 0):
            break
        page += 1
    print(f"collection: {len(releases)} releases", file=sys.stderr)

    def save() -> None:
        payload = {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "user": user,
            "releases": releases,
            "gist_token": os.environ.get("GIST_TOKEN", ""),
        }
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(encrypt(payload, password, salt))

    stale = sorted((r for r in releases if r["id"] in cache), key=lambda r: cache[r["id"]]["stats_at"])
    refresh = {r["id"] for r in stale[: args.refresh]}
    todo = []
    for r in releases:
        if r["id"] in cache:
            r.update({k: cache[r["id"]][k] for k in DETAIL_KEYS})
        if r["id"] not in cache or r["id"] in refresh:
            todo.append(r)
    if args.limit:
        todo = todo[: args.limit]
    print(f"fetching {len(todo)} releases ({len(todo) - len(refresh & {r['id'] for r in todo})} new)", file=sys.stderr)

    fetched = 0
    for r in todo:
        release = api.get(f"/releases/{r['id']}?curr_abbr=EUR")
        if release:
            r.update(details(release))
        fetched += 1
        if fetched % 100 == 0:
            print(f"  fetched {fetched}/{len(todo)}", file=sys.stderr)
            save()
    try:
        from collection_map import add_map
    except ImportError as e:
        print(f"skipping collection map ({e})", file=sys.stderr)
    else:
        add_map(releases, positions)
    save()
    print(f"done: {fetched} releases fetched, bundle at {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
