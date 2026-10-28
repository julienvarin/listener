"""Tempo and energy for each track, measured on 30-second preview clips.

Spotify no longer gives apps its audio features, so tracks are found on Deezer (free API, no key, ~50 requests
per 5 seconds), their preview clip is decoded with ffmpeg and measured with librosa:

- BPM: tempo of the onset envelope. Beat trackers often lock onto hi-hats and report double the felt tempo of
  slow music, so the Discogs styles decide the octave: downtempo-type styles fold above 125 BPM down by half.
  Tracks without a clear pulse (ambient, beatless intros) get no BPM.
- Energy features: loudness (dB), onset strength (how busy the rhythm is) and spectral centroid (brightness).
  The app turns them into a 0–10 energy by ranking them against the rest of the collection.

Each record gets r["audio"]: one entry per track, [bpm or None, loudness, onset, brightness, source] or None
when no clip was found. Clips are analyzed on worker threads; ffmpeg runs out of process and numpy releases
the GIL, so several cores get used.
"""

import json
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np

SR = 22050
SLOW_STYLES = {
    "downtempo", "trip hop", "hip hop", "abstract", "dub", "ambient", "ballad", "soul", "rnb/swing", "lo-fi",
    "chillwave", "boom bap", "instrumental", "jazzy hip-hop", "neo soul", "reggae", "dancehall", "lounge",
    "dub techno", "balearic", "new age", "experimental", "modern classical", "contemporary jazz", "soundtrack",
}
FAST_STYLES = {"drum n bass", "jungle", "breakcore", "hardcore", "gabber", "footwork", "juke", "speedcore", "dubstep"}


def norm(s: str) -> str:
    from build_data import norm as n
    return n(s)


class Deezer:
    def __init__(self, per_second: float = 8):
        self.interval = 1 / per_second
        self.next_at = 0.0
        self.lock = threading.Lock()

    def get(self, url: str) -> bytes:
        for attempt in range(4):
            with self.lock:
                now = time.monotonic()
                slot = max(now, self.next_at)
                self.next_at = slot + self.interval
            time.sleep(max(0, slot - now))
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "listener/1.0"}), timeout=20) as r:
                    body = r.read()
                if body.startswith(b"{") and b'"QUOTA' in body[:200]:  # Deezer reports quota errors with HTTP 200
                    raise urllib.error.URLError("quota")
                return body
            except (urllib.error.URLError, TimeoutError):
                with self.lock:
                    self.next_at = max(self.next_at, time.monotonic() + 5 * (attempt + 1))
        raise RuntimeError(f"giving up on {url}")

    def preview(self, title: str, artist: str) -> str | None:
        """Same matching rule as the Apple and Spotify lookups: an artist overlaps and the title's first word appears."""
        title = re.sub(r"\((original|extended)? ?mix\)", "", title, flags=re.I).strip()
        artists = [a for a in (norm(x) for x in re.split(r",|&| vs\.? | feat\.? | ft\.? | and | x ", artist, flags=re.I)) if a]
        q = f"{artists[0] if artists else ''} {title}"
        items = json.loads(self.get("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": q, "limit": "10"}))).get("data", [])
        words = norm(title).split(" ")
        first = words[0] if words else ""
        for x in items:
            name = norm(x.get("artist", {}).get("name", ""))
            if x.get("preview") and any(a in name or name in a for a in artists if name) and first in norm(x.get("title", "")):
                return x["preview"]
        return None


def decode(blob: bytes) -> np.ndarray:
    pcm = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", "pipe:0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
        input=blob, capture_output=True, check=True, timeout=60,
    ).stdout
    return np.frombuffer(pcm, dtype=np.float32)


def measure(y: np.ndarray, styles: list) -> list | None:
    import librosa

    if len(y) < SR * 5:
        return None
    onset = librosa.onset.onset_strength(y=y, sr=SR)
    ac = librosa.autocorrelate(onset - onset.mean())
    lags = librosa.frames_to_time(np.arange(len(ac)), sr=SR)
    clarity = float((ac / (ac[0] or 1))[(lags > 0.3) & (lags < 1.5)].max())
    bpm = None
    if clarity >= 0.2:
        bpm = float(librosa.feature.tempo(onset_envelope=onset, sr=SR)[0])
        s = {x.lower() for x in styles}
        if s & SLOW_STYLES and not s & FAST_STYLES and bpm > 125:
            bpm /= 2
        while bpm > 185:
            bpm /= 2
        while bpm < 55:
            bpm *= 2
        bpm = round(bpm, 1)
    rms = librosa.feature.rms(y=y)[0]
    loud = round(float(20 * np.log10(np.mean(rms) + 1e-9)), 1)
    bright = round(float(np.mean(librosa.feature.spectral_centroid(y=y, sr=SR))))
    return [bpm, loud, round(float(onset.mean()), 3), bright]


def add_audio(releases: list, cache: dict, budget: int, workers: int = 6) -> None:
    for r in releases:
        old = cache.get(r["id"], {}).get("audio")
        if old is not None and len(old) == len(r.get("tracks", [])):
            r["audio"] = old
    todo = [r for r in releases if r.get("tracks") and "audio" not in r]
    if not budget or not todo:
        return
    # Whole records only, so a record is never left half analyzed.
    take, n = [], 0
    for r in todo:
        if n + len(r["tracks"]) > budget and take:
            break
        take.append(r)
        n += len(r["tracks"])
    jobs = [(r, i, t) for r in take for i, t in enumerate(r["tracks"])]
    print(f"analyzing {len(jobs)} tracks on {len(take)} records ({len(todo)} records not analyzed yet)", file=sys.stderr)
    import librosa  # noqa: F401  (import once up front, not inside every worker)

    deezer = Deezer()
    started = time.monotonic()

    def one(job):
        r, i, t = job
        try:
            url = deezer.preview(t["title"] or "Untitled", ", ".join(t.get("artists") or r["artists"]) or "Unknown Artist")
            source = "dz"
            apple = (r.get("apple") or [None] * len(r["tracks"]))[i] if r.get("apple") else None
            if not url and apple:
                url, source = apple["url"], "am"
            if not url:
                return job, None
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "listener/1.0"}), timeout=30) as resp:
                blob = resp.read()
            m = measure(decode(blob), r.get("styles") or [])
            return job, m and m + [source]
        except Exception as e:  # one bad clip must not stop the run
            return job, e

    results, failed = {}, set()
    errors = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for n, ((r, i, _), m) in enumerate(pool.map(one, jobs), 1):
            if isinstance(m, Exception):
                errors += 1
                failed.add(r["id"])
                m = None
            results.setdefault(r["id"], [None] * len(r["tracks"]))[i] = m
            if n % 200 == 0:
                rate = n / (time.monotonic() - started) * 60
                print(f"  analyzed {n}/{len(jobs)} ({rate:.0f} tracks/min)", file=sys.stderr)
    for r in take:
        if r["id"] not in failed:  # records that hit an error are retried by the next build
            r["audio"] = results.get(r["id"], [None] * len(r["tracks"]))
    found = sum(1 for r in take for a in r.get("audio") or [] if a)
    took = (time.monotonic() - started) / 60
    print(f"audio: {found}/{len(jobs)} tracks measured in {took:.1f} min, {errors} errors", file=sys.stderr)
