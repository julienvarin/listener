"""Similarity neighbours, two-level clusters (regions > mini clusters) and a 2D map of the collection.

Clusters come from shared artists, labels, styles, eras, countries, genre tags and the mood words in the
Discogs notes. With a seed (curated names and memberships, see seed_clusters.py) clusters stay stable and
new records join the closest mini cluster; without one they are computed and named automatically.
"""

import math
import re
from collections import Counter

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.cluster import KMeans
from sklearn.decomposition import TruncatedSVD
from sklearn.manifold import TSNE

IGNORED_ARTISTS = {"various", "unknown artist"}
IGNORED_LABELS = {"not on label", "white label", "none", "no label"}
MOODS = {
    "deep": "deep", "intense": "intense", "hit": "hit", "club": "club", "groovy": "groovy", "groove": "groovy",
    "melancholic": "melancholic", "melancholy": "melancholic", "loopy": "loopy", "roller": "roller", "ballad": "ballad",
    "dark": "dark", "darkisant": "dark", "darkos": "dark", "vocoder": "vocoder", "gangster": "gangster",
    "omenous": "ominous", "ominous": "ominous", "solar": "solar", "glitchy": "glitchy", "moody": "moody",
    "dreamy": "dreamy", "funky": "funky", "spooky": "spooky", "chill": "chill", "laidback": "chill", "slow": "slow",
    "fast": "fast", "dub": "dub", "tension": "tension", "breaky": "breaky", "woman-vocal": "female vocal",
    "man-vocal": "male vocal", "raw": "raw", "bassy": "bassy", "melodic": "melodic", "slow-dance": "slow dance",
    "trippy": "trippy", "robotic": "robotic", "lullaby": "lullaby", "weird": "weird", "organic": "organic",
    "epic": "epic", "spacey": "spacey", "emotion": "emotional", "jackin": "jackin", "oriental": "oriental",
    "tribal": "tribal", "jazzy": "jazzy", "trancey": "trancey", "proggy": "proggy", "playful": "playful",
    "indus": "industrial", "dancefloor": "dancefloor", "beatless": "beatless", "mental": "mental",
}


def moods(r: dict) -> set:
    text = ((r.get("notes") or {}).get("Notes") or "").lower()
    return {MOODS[w] for w in re.findall(r"[a-z][a-z-]+", text) if w in MOODS}


def real_label(name: str) -> bool:
    return not any(name.lower().startswith(x) for x in IGNORED_LABELS)


def tokens(r: dict) -> dict:
    t = {}
    for a in r["artists"]:
        if a.lower() not in IGNORED_ARTISTS:
            t[f"a:{a}"] = 3.0
    for label in r["labels"]:
        if real_label(label["name"]):
            t[f"l:{label['name']}"] = 2.0
    for s in r["styles"]:
        t[f"s:{s}"] = 1.5
    for g in r["genres"]:
        t[f"g:{g}"] = 0.6
    if r.get("year"):
        t[f"d:{r['year'] // 10}"] = 0.8
        t[f"y:{r['year'] // 3}"] = 0.5
    if r.get("country"):
        t[f"c:{r['country']}"] = 1.0
    own = (r.get("notes") or {}).get("Genre")
    if own:
        t[f"m:{own}"] = 1.2
    for m in moods(r):
        t[f"w:{m}"] = 0.9
    return t


def feature_matrix(releases: list) -> csr_matrix:
    feats = [tokens(r) for r in releases]
    df = Counter(k for f in feats for k in f)
    vocab = {k: i for i, k in enumerate(df)}
    n = len(releases)
    rows, cols, vals = [], [], []
    for i, f in enumerate(feats):
        for k, w in f.items():
            rows.append(i)
            cols.append(vocab[k])
            vals.append(w * math.log(1 + n / df[k]))
    x = csr_matrix((vals, (rows, cols)), shape=(n, len(vocab)), dtype=np.float32)
    norms = np.sqrt(np.asarray(x.multiply(x).sum(axis=1)).ravel())
    norms[norms == 0] = 1
    return csr_matrix(x.multiply(1 / norms[:, None]))


def embed(x: csr_matrix) -> np.ndarray:
    z = TruncatedSVD(min(80, x.shape[1] - 1), random_state=0).fit_transform(x)
    return z / (np.linalg.norm(z, axis=1, keepdims=True) + 1e-9)


def by_size(labels: np.ndarray) -> np.ndarray:
    order = np.argsort(-np.bincount(labels))
    rank = {c: i for i, c in enumerate(order)}
    return np.array([rank[c] for c in labels])


def hierarchy(z: np.ndarray, n_regions: int = 12, mini_size: int = 45) -> tuple:
    region = by_size(KMeans(min(n_regions, len(z)), n_init=10, random_state=0).fit_predict(z))
    mini = np.zeros(len(z), dtype=int)
    next_id = 0
    for reg in range(region.max() + 1):
        idx = np.where(region == reg)[0]
        k = max(1, round(len(idx) / mini_size)) if len(idx) >= 60 else 1
        sub = by_size(KMeans(k, n_init=10, random_state=0).fit_predict(z[idx])) if k > 1 else np.zeros(len(idx), dtype=int)
        mini[idx] = sub + next_id
        next_id += sub.max() + 1
    return region, mini


def shares(members: list, values) -> list:
    n = len(members)
    counter = Counter(v for r in members for v in values(r))
    return [[k, round(c / n, 2)] for k, c in counter.most_common(5)]


def describe(members: list, population: list) -> dict:
    """Composition of a cluster, used for its panel and its facts line."""
    pop_moods = Counter(m for r in population for m in moods(r))
    cl_moods = Counter(m for r in members for m in moods(r))
    lifted = sorted(
        ((m, c / len(members), (c / len(members)) / (pop_moods[m] / len(population))) for m, c in cl_moods.items() if c >= 3),
        key=lambda t: -t[1] * math.log(1 + t[2]),
    )
    years = sorted(r["year"] for r in members if r.get("year"))
    span = ""
    if years:
        lo, hi = years[len(years) // 10], years[(len(years) * 9) // 10]
        span = str(lo) if lo == hi else f"{lo}–{hi}"
    info = {
        "styles": shares(members, lambda r: r["styles"]),
        "countries": [s for s in shares(members, lambda r: [r["country"]] if r.get("country") else []) if s[1] >= 0.1][:3],
        "decades": shares(members, lambda r: [f"{r['year'] // 10 * 10}s"] if r.get("year") else [])[:2],
        "labels": [s for s in shares(members, lambda r: [l["name"] for l in r["labels"][:1] if real_label(l["name"])]) if s[1] >= 0.05][:3],
        "own": [s for s in shares(members, lambda r: [r["notes"]["Genre"]] if (r.get("notes") or {}).get("Genre") else []) if s[1] >= 0.2][:2],
        "moods": [[m, round(s, 2)] for m, s, _ in lifted[:5]],
        "span": span,
        "size": len(members),
    }
    parts = [info["styles"][0][0]] if info["styles"] and info["styles"][0][1] >= 0.35 else []
    if info["countries"] and info["countries"][0][1] >= 0.35:
        parts.append(info["countries"][0][0])
    if span:
        parts.append(span)
    parts.append(f"{len(members)} records")
    info["facts"] = " · ".join(parts)
    return info


def auto_name(info: dict) -> str:
    styles = [s for s, v in info["styles"][:2] if v >= 0.35] or [s for s, _ in info["styles"][:1]] or ["Mixed"]
    mood = info["moods"][0][0] if info["moods"] and info["moods"][0][1] >= 0.15 else ""
    return " ".join(x for x in [mood, " & ".join(styles)] if x)


def add_map(releases: list, previous: dict, seed: dict | None = None) -> tuple:
    n = len(releases)
    x = feature_matrix(releases)
    sim = (x @ x.T).toarray()
    np.fill_diagonal(sim, 0)
    for i, r in enumerate(releases):
        top = np.argpartition(-sim[i], 8)[:8]
        top = top[np.argsort(-sim[i][top])]
        r["similar"] = [releases[j]["id"] for j in top if sim[i][j] > 0.05]

    z = embed(x)
    if seed:
        minis = {int(k): v for k, v in seed["minis"].items()}
        mini = np.array([seed["assign"].get(str(r["id"]), -1) for r in releases])
        known = mini >= 0
        if (~known).any():
            ids = sorted(minis)
            centroids = np.stack([z[mini == m].mean(axis=0) if (mini == m).any() else np.zeros(z.shape[1]) for m in ids])
            mini[~known] = np.array(ids)[np.argmax(z[~known] @ centroids.T, axis=1)]
        region = np.array([minis[m]["region"] for m in mini])
    else:
        region, mini = hierarchy(z)

    init = np.random.default_rng(0).normal(size=(n, 2))
    if sum(r["id"] in previous for r in releases) > n * 0.8:
        for i, r in enumerate(releases):
            if r["id"] in previous:
                init[i] = previous[r["id"]]
            else:
                near = [previous[s] for s in r["similar"] if s in previous]
                if near:
                    init[i] = np.mean(near, axis=0)
        init = (init - init.mean(axis=0)) / init.std(axis=0)
    init = (init * 1e-4).astype(np.float32)

    # Mini clusters become islands, grouped into region continents.
    dist = 0.55 * np.clip(1 - sim, 0, 1) + 0.15 * (mini[:, None] != mini[None, :]) + 0.30 * (region[:, None] != region[None, :])
    np.fill_diagonal(dist, 0)
    xy = TSNE(n_components=2, metric="precomputed", init=init, perplexity=min(30, n - 1), random_state=0).fit_transform(dist)
    xy = (xy - xy.min(axis=0)) / max(np.ptp(xy, axis=0).max(), 1e-9) * 1000

    for i, r in enumerate(releases):
        r["xy"] = [round(float(xy[i, 0]), 1), round(float(xy[i, 1]), 1)]
        r["cluster"] = int(mini[i])
        r["region"] = int(region[i])

    def place(idx, info):
        info.update(x=round(float(np.median(xy[idx, 0])), 1), y=round(float(np.median(xy[idx, 1])), 1))
        return info

    named = (seed or {}).get("minis", {})
    clusters = []
    for m in sorted(set(mini.tolist())):
        idx = np.where(mini == m)[0]
        info = describe([releases[i] for i in idx], releases)
        info.update(id=m, region=int(region[idx[0]]), name=named.get(str(m), {}).get("name") or auto_name(info))
        clusters.append(place(idx, info))
    regions = []
    for g in sorted(set(region.tolist())):
        idx = np.where(region == g)[0]
        info = describe([releases[i] for i in idx], releases)
        info.update(id=g, name=(seed or {}).get("regions", {}).get(str(g)) or auto_name(info))
        regions.append(place(idx, info))
    return clusters, regions
