"""Fetch a Discogs collection and write it as a password-encrypted bundle.

Env: DISCOGS_TOKEN, DISCOGS_USERNAME, LISTENER_PASSWORD, GIST_TOKEN (optional).
Release details already present in the previous bundle are reused, so only
new additions plus the stalest market stats (--refresh) hit the per-release
endpoint (Discogs allows ~60 req/min).
"""

import argparse
import base64
import gzip
import json
import os
import re
import struct
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

try:
    from collection_map import LAYOUT_VERSION
except ImportError:
    LAYOUT_VERSION = None

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
                    if int(r.headers.get("X-Discogs-Ratelimit-Remaining", 60)) < 5:
                        time.sleep(10)
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


def norm(s: str) -> str:
    s = "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


class AppleLimited(Exception):
    pass


def apple_preview(title: str, artist: str) -> dict | None:
    """Mirrors applePreview() in js/library.js, so the app agrees with what the build found."""
    title = re.sub(r"\((original|extended)? ?mix\)", "", title, flags=re.I).strip()
    artists = [a for a in (norm(x) for x in re.split(r",|&| vs\.? | feat\.? | ft\.? | and | x ", artist, flags=re.I)) if a]
    term = f"{artists[0] if artists else ''} {title}"
    url = "https://itunes.apple.com/search?" + urllib.parse.urlencode({"term": term, "entity": "song", "limit": "10"})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "listener/1.0"}), timeout=20) as r:
            results = json.load(r).get("results", [])
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise AppleLimited from e
        raise
    words = norm(title).split(" ")
    first = words[0] if words else ""
    for x in results:
        name = norm(x.get("artistName", ""))
        if x.get("previewUrl") and any(a in name or name in a for a in artists) and first in norm(x.get("trackName", "")):
            return {"url": x["previewUrl"], "link": x.get("trackViewUrl", "")}
    return None


def add_apple(releases: list, cache: dict, budget: int) -> None:
    """Look up Apple Music previews for records with no YouTube video, so the app can gray out the silent ones."""
    for r in releases:
        old = cache.get(r["id"], {}).get("apple")
        if old is not None and len(old) == len(r.get("tracks", [])):
            r["apple"] = old
    todo = [r for r in releases if r.get("stats_at") and not r.get("videos") and r.get("tracks") and "apple" not in r]
    print(f"looking up Apple previews for {min(len(todo), budget)} of {len(todo)} records without videos", file=sys.stderr)
    for r in todo:
        if budget <= 0:
            return
        found = []
        try:
            for t in r["tracks"]:
                time.sleep(3)  # iTunes Search allows ~20 requests a minute
                found.append(apple_preview(t["title"] or "Untitled", ", ".join(t.get("artists") or r["artists"]) or "Unknown Artist"))
        except AppleLimited:
            print("  Apple rate limit hit; the rest waits for the next build", file=sys.stderr)
            return
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            print(f"  skipped Apple lookup for {r['id']}: {e}", file=sys.stderr)
            continue
        r["apple"] = found
        budget -= len(found)


class Spotify:
    """Track search with an app token (client credentials): no user login needed to find IDs."""

    def __init__(self, client_id: str, secret: str):
        body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
        auth = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
        req = urllib.request.Request("https://accounts.spotify.com/api/token", data=body, headers={"Authorization": f"Basic {auth}"})
        with urllib.request.urlopen(req, timeout=20) as r:
            self.token = json.load(r)["access_token"]

    def find(self, title: str, artist: str) -> str | None:
        """Same matching rule as apple_preview(): an artist name overlaps and the title's first word appears."""
        title = re.sub(r"\((original|extended)? ?mix\)", "", title, flags=re.I).strip()
        artists = [a for a in (norm(x) for x in re.split(r",|&| vs\.? | feat\.? | ft\.? | and | x ", artist, flags=re.I)) if a]
        q = f"{title} {artists[0] if artists else ''}"
        url = "https://api.spotify.com/v1/search?" + urllib.parse.urlencode({"q": q, "type": "track", "limit": "10"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"}), timeout=20) as r:
                    items = json.load(r).get("tracks", {}).get("items", [])
                break
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                time.sleep(int(e.headers.get("Retry-After", 5)) + 1)
        else:
            return None
        words = norm(title).split(" ")
        first = words[0] if words else ""
        for x in items:
            names = [norm(a.get("name", "")) for a in x.get("artists", [])]
            if any(a in n or n in a for a in artists for n in names if n) and first in norm(x.get("name", "")):
                return x["id"]
        return None


def add_spotify(releases: list, cache: dict, budget: int) -> None:
    """Find Spotify tracks for what neither YouTube nor Apple can play. Needs SPOTIFY_CLIENT_ID/SECRET."""
    for r in releases:
        old = cache.get(r["id"], {}).get("spotify")
        if old is not None and len(old) == len(r.get("tracks", [])):
            r["spotify"] = old
    client_id, secret = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    todo = [r for r in releases if r.get("apple") is not None and not all(r["apple"]) and r.get("tracks") and "spotify" not in r]
    if not (client_id and secret and budget and todo):
        return
    try:
        api = Spotify(client_id, secret)
    except (urllib.error.URLError, KeyError, ValueError) as e:
        print(f"Spotify login failed ({e}); skipping", file=sys.stderr)
        return
    print(f"looking up Spotify for {len(todo)} silent records", file=sys.stderr)
    for r in todo:
        if budget <= 0:
            return
        try:
            r["spotify"] = [
                None if apple else api.find(t["title"] or "Untitled", ", ".join(t.get("artists") or r["artists"]) or "Unknown Artist")
                for t, apple in zip(r["tracks"], r["apple"])
            ]
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            print(f"  skipped Spotify lookup for {r['id']}: {e}", file=sys.stderr)
            continue
        budget -= len(r["tracks"])
        time.sleep(0.3)


HISTORY = 24


def add_history(r: dict) -> None:
    point = [r["stats_at"], r.get("lowest_price"), r.get("for_sale", 0), (r.get("suggest") or {}).get("Very Good Plus (VG+)")]
    hist = [h for h in r.get("hist", []) if h[0] != point[0]]
    r["hist"] = (hist + [point])[-HISTORY:]


DETAIL_KEYS = ("country", "released", "tracks", "videos", "have", "want", "community_rating", "votes", "lowest_price", "for_sale", "stats_at")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/library.enc")
    ap.add_argument("--limit", type=int, default=0, help="max new releases to detail this run (0 = all)")
    ap.add_argument("--refresh", type=int, default=250, help="re-fetch market stats for this many stalest releases")
    ap.add_argument("--apple", type=int, default=500, help="max Apple preview lookups this run")
    ap.add_argument("--spotify", type=int, default=1000, help="max Spotify track lookups this run")
    ap.add_argument("--no-suggestions", action="store_true", help="skip Discogs price suggestions")
    ap.add_argument("--seed", default="data/clusters.enc", help="curated clusters, decrypted with CLUSTER_KEY")
    args = ap.parse_args()

    token, user, password = (os.environ.get(k) for k in ("DISCOGS_TOKEN", "DISCOGS_USERNAME", "LISTENER_PASSWORD"))
    if not (token and user and password):
        sys.exit("DISCOGS_TOKEN, DISCOGS_USERNAME and LISTENER_PASSWORD are required")
    out = Path(args.out)

    cache, positions, clusters, regions, salt = {}, {}, [], [], None
    collection_value = {}
    if out.exists():
        try:
            blob = out.read_bytes()
            previous_payload = decrypt(blob, password)
            previous = previous_payload["releases"]
            cache = {r["id"]: r for r in previous if "stats_at" in r}
            if previous_payload.get("layout") == LAYOUT_VERSION:
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
            "clusters": clusters,
            "regions": regions,
            "layout": LAYOUT_VERSION,
            "collection_value": collection_value,
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
            for k in ("suggest", "suggest_at", "hist"):
                if k in cache[r["id"]]:
                    r[k] = cache[r["id"]][k]
            if "hist" not in r:
                add_history(r)  # seed with the cached snapshot before it is refreshed
        if r["id"] not in cache or r["id"] in refresh:
            todo.append(r)
    if args.limit:
        todo = todo[: args.limit]
    print(f"fetching {len(todo)} releases ({len(todo) - len(refresh & {r['id'] for r in todo})} new)", file=sys.stderr)

    fetched = 0
    for r in todo:
        try:
            release = api.get(f"/releases/{r['id']}?curr_abbr=EUR")
        except RuntimeError as e:
            print(f"  skipped {r['id']}: {e}", file=sys.stderr)
            continue
        if release:
            r.update(details(release))
        fetched += 1
        if fetched % 100 == 0:
            print(f"  fetched {fetched}/{len(todo)}", file=sys.stderr)
            save()
    # Discogs price suggestions: per-condition values derived from the release's sales history.
    # Suggestions follow sales history, which moves slowly: on a refresh, only re-fetch them when the market
    # stats changed or they are over a month old. That roughly halves the requests per refreshed record.
    month_ago = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()

    def moved(r: dict) -> bool:
        old = cache.get(r["id"], {})
        return any(old.get(k) != r.get(k) for k in ("lowest_price", "for_sale", "have", "want"))

    pending = [] if args.no_suggestions else [
        r for r in releases
        if "suggest" not in r or (r["id"] in refresh and (moved(r) or r.get("suggest_at", "") < month_ago))
    ]
    if args.limit:
        pending = pending[: args.limit]
    print(f"fetching price suggestions for {len(pending)} releases", file=sys.stderr)
    for n, r in enumerate(pending, 1):
        try:
            suggest = api.get(f"/marketplace/price_suggestions/{r['id']}")
        except urllib.error.HTTPError:
            suggest = {}
        except RuntimeError as e:
            print(f"  skipped suggestions for {r['id']}: {e}", file=sys.stderr)
            continue
        r["suggest"] = {k: round(v["value"], 2) for k, v in suggest.items() if isinstance(v, dict) and v.get("value")}
        r["suggest_at"] = datetime.now(timezone.utc).date().isoformat()
        if n % 100 == 0:
            print(f"  suggestions {n}/{len(pending)}", file=sys.stderr)
            save()

    # Price history: one point per refresh, so the app can tell rising records from falling ones.
    fetched_ids = {r["id"] for r in todo}
    for r in releases:
        if "stats_at" in r and (r["id"] in fetched_ids or "hist" not in r):
            add_history(r)

    try:
        value = api.get(f"/users/{user}/collection/value")
    except (RuntimeError, urllib.error.HTTPError):
        value = {}
    collection_value = {k: float(re.sub(r"[^\d.]", "", v)) for k, v in value.items() if isinstance(v, str) and re.search(r"\d", v)}

    add_apple(releases, cache, args.apple)
    add_spotify(releases, cache, args.spotify)

    seed = None
    if os.environ.get("CLUSTER_KEY") and Path(args.seed).exists():
        from seed_clusters import load_key, unseal
        seed = unseal(Path(args.seed).read_bytes(), load_key(os.environ["CLUSTER_KEY"]))
    try:
        from collection_map import add_map
    except ImportError as e:
        print(f"skipping collection map ({e})", file=sys.stderr)
    else:
        clusters, regions = add_map(releases, positions, seed)
    save()
    print(f"done: {fetched} releases fetched, bundle at {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
