"""Fetch a Discogs collection and write it as a password-encrypted bundle.

Env: DISCOGS_TOKEN, DISCOGS_USERNAME, LISTENER_PASSWORD, GIST_TOKEN (optional).
Release details already present in the previous bundle are reused, so only
new additions plus the stalest market stats (--refresh) hit the per-release
endpoint, paced to the rate limit Discogs reports for the token (60 req/min unless raised).
"""

import argparse
import base64
import gzip
import json
import os
import re
import struct
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
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
    """Discogs API client that paces itself to the limit Discogs reports.

    Every response carries X-Discogs-Ratelimit (requests a minute allowed for this token, 60 by default) and
    X-Discogs-Ratelimit-Remaining. Requests are spaced to the reported limit, so a raised limit is used as soon
    as Discogs grants it, and several worker threads keep requests in flight so network latency doesn't cap
    the rate below it. `max_rate` optionally caps requests a minute below what Discogs allows.
    """

    def __init__(self, token: str, max_rate: float = 0):
        self.headers = {"Authorization": f"Discogs token={token}", "User-Agent": "listener/1.0"}
        self.limit = 60
        self.max_rate = max_rate
        self.next_at = 0.0
        self.lock = threading.Lock()

    def interval(self) -> float:
        rate = min(self.limit, self.max_rate) if self.max_rate else self.limit
        return 60 / (rate * 0.95)  # a little under the limit, since its window and our clock differ

    def pace(self) -> None:
        with self.lock:
            now = time.monotonic()
            slot = max(now, self.next_at)
            self.next_at = slot + self.interval()
        if slot > now:
            time.sleep(slot - now)

    def hold(self, seconds: float) -> None:
        with self.lock:
            self.next_at = max(self.next_at, time.monotonic() + seconds)

    def get(self, path: str) -> dict:
        for attempt in range(6):
            self.pace()
            req = urllib.request.Request(API + path, headers=self.headers)
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    limit = int(r.headers.get("X-Discogs-Ratelimit") or 0)
                    if limit and limit != self.limit:
                        print(f"Discogs rate limit for this token: {limit} requests a minute", file=sys.stderr)
                        self.limit = limit
                    if int(r.headers.get("X-Discogs-Ratelimit-Remaining") or self.limit) < 3:
                        self.hold(5)
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return {}
                if e.code not in (429, 500, 502, 503, 504):
                    raise
                self.hold(10 * (attempt + 1))
            except (urllib.error.URLError, TimeoutError):
                self.hold(5 * (attempt + 1))
        raise RuntimeError(f"giving up on {path}")

    def get_all(self, items: list, path_of, workers: int):
        """Fetch path_of(item) for every item on `workers` threads; yields (item, response, error) in order."""

        def one(item):
            try:
                return item, self.get(path_of(item)), None
            except (RuntimeError, urllib.error.HTTPError) as e:
                return item, None, e

        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            yield from pool.map(one, items)


def names(items: list) -> list:
    return [re.sub(r" \(\d+\)$", "", a["name"]) for a in items or []]


def summarize(basic: dict) -> dict:
    return {
        "id": basic["id"],
        "master": basic.get("master_id") or None,
        "title": basic["title"],
        "artists": names(basic.get("artists")),
        "artist_ids": [a.get("id") for a in basic.get("artists") or []],
        "labels": [{"name": re.sub(r" \(\d+\)$", "", l["name"]), "catno": l.get("catno", ""), "id": l.get("id")} for l in basic.get("labels") or []],
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
    ap.add_argument("--entities", type=int, default=0, help="max Discogs requests for artist and label profiles this run")
    ap.add_argument("--audio", type=int, default=0, help="max tracks to measure BPM and energy for this run")
    ap.add_argument("--workers", type=int, default=4, help="Discogs requests in flight at once")
    ap.add_argument("--max-rate", type=float, default=0, help="cap on Discogs requests a minute (0 = whatever Discogs allows)")
    ap.add_argument("--no-suggestions", action="store_true", help="skip Discogs price suggestions")
    ap.add_argument("--seed", default="data/clusters.enc", help="curated clusters, decrypted with CLUSTER_KEY")
    args = ap.parse_args()

    token, user, password = (os.environ.get(k) for k in ("DISCOGS_TOKEN", "DISCOGS_USERNAME", "LISTENER_PASSWORD"))
    if not (token and user and password):
        sys.exit("DISCOGS_TOKEN, DISCOGS_USERNAME and LISTENER_PASSWORD are required")
    out = Path(args.out)

    cache, positions, clusters, regions, salt = {}, {}, [], [], None
    collection_value, entities = {}, {}
    if out.exists():
        try:
            blob = out.read_bytes()
            previous_payload = decrypt(blob, password)
            previous = previous_payload["releases"]
            entities = previous_payload.get("entities", {})
            cache = {r["id"]: r for r in previous if "stats_at" in r}
            if previous_payload.get("layout") == LAYOUT_VERSION:
                positions = {r["id"]: r["xy"] for r in previous if "xy" in r}
            salt = blob[8:24]
        except Exception as e:
            print(f"previous bundle unreadable ({e}); starting fresh", file=sys.stderr)

    api = Discogs(token, args.max_rate)
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
            "entities": entities,
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
    started = time.monotonic()
    elapsed = lambda: f"{(time.monotonic() - started) / 60:.1f} min"
    for r, release, err in api.get_all(todo, lambda r: f"/releases/{r['id']}?curr_abbr=EUR", args.workers):
        if isinstance(err, urllib.error.HTTPError):
            raise err
        if err:
            print(f"  skipped {r['id']}: {err}", file=sys.stderr)
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
    print(f"releases done in {elapsed()} ({api.limit} req/min allowed)", file=sys.stderr)
    print(f"fetching price suggestions for {len(pending)} releases", file=sys.stderr)
    for n, (r, suggest, err) in enumerate(api.get_all(pending, lambda r: f"/marketplace/price_suggestions/{r['id']}", args.workers), 1):
        if isinstance(err, RuntimeError):
            print(f"  skipped suggestions for {r['id']}: {err}", file=sys.stderr)
            continue
        suggest = suggest or {}
        r["suggest"] = {k: round(v["value"], 2) for k, v in suggest.items() if isinstance(v, dict) and v.get("value")}
        r["suggest_at"] = datetime.now(timezone.utc).date().isoformat()
        if n % 100 == 0:
            print(f"  suggestions {n}/{len(pending)}", file=sys.stderr)
            save()

    print(f"releases and price suggestions done in {elapsed()}", file=sys.stderr)

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

    from entities import add_entities
    entities = add_entities(api, releases, entities, args.entities)
    print(f"artist and label profiles done in {elapsed()}", file=sys.stderr)

    add_apple(releases, cache, args.apple)
    add_spotify(releases, cache, args.spotify)
    if args.audio:
        from audio_features import add_audio
        add_audio(releases, cache, args.audio)
    else:
        for r in releases:
            if "audio" in cache.get(r["id"], {}) and len(cache[r["id"]]["audio"]) == len(r.get("tracks", [])):
                r["audio"] = cache[r["id"]]["audio"]

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
