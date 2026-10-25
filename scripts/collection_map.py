"""Similarity neighbours and a 2D map of the collection (shared artists, labels, styles, years)."""

import math
from collections import Counter

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.cluster import KMeans
from sklearn.decomposition import TruncatedSVD
from sklearn.manifold import TSNE

IGNORED_ARTISTS = {"various", "unknown artist"}
IGNORED_LABELS = {"not on label", "white label", "none", "no label"}


def tokens(r: dict) -> dict:
    t = {}
    for a in r["artists"]:
        if a.lower() not in IGNORED_ARTISTS:
            t[f"a:{a}"] = 3.0
    for label in r["labels"]:
        name = label["name"]
        if not any(name.lower().startswith(x) for x in IGNORED_LABELS):
            t[f"l:{name}"] = 2.0
    for s in r["styles"]:
        t[f"s:{s}"] = 1.5
    for g in r["genres"]:
        t[f"g:{g}"] = 0.6
    if r.get("year"):
        t[f"d:{r['year'] // 10}"] = 0.8
        t[f"y:{r['year'] // 3}"] = 0.5
    own = (r.get("notes") or {}).get("Genre")
    if own:
        t[f"m:{own}"] = 1.2
    return t


def name_cluster(members: list) -> dict:
    n = len(members)
    share = lambda counter: [(k, v / n) for k, v in counter.most_common(4)]
    styles = share(Counter(s for r in members for s in r["styles"]))
    decades = share(Counter(f"{r['year'] // 10 * 10}s" for r in members if r.get("year")))
    labels = share(Counter(r["labels"][0]["name"] for r in members if r["labels"]))
    own = share(Counter(r["notes"]["Genre"] for r in members if (r.get("notes") or {}).get("Genre")))
    parts = [k for k, v in styles[:2] if v >= 0.35][:2] or [f"Mixed {' & '.join(k for k, _ in styles[:2])}"]
    name = " · ".join(parts)
    if decades and decades[0][1] >= 0.6:
        name += f" · {decades[0][0]}"
    return {
        "name": name,
        "styles": [[k, round(v, 2)] for k, v in styles],
        "decades": [[k, round(v, 2)] for k, v in decades[:2]],
        "labels": [[k, round(v, 2)] for k, v in labels[:3] if v >= 0.04],
        "own": [[k, round(v, 2)] for k, v in own[:2] if v >= 0.25],
    }


def disambiguate(clusters: list) -> None:
    seen = Counter(c["name"] for c in clusters)
    for c in clusters:
        if seen[c["name"]] < 2:
            continue
        label = next((l for l, v in c["labels"] if v >= 0.06 and not any(l.lower().startswith(x) for x in IGNORED_LABELS)), None)
        decade = c["decades"][0][0] if c["decades"] and c["decades"][0][1] >= 0.4 and c["decades"][0][0] not in c["name"] else None
        style = next((s for s, _ in c["styles"] if s not in c["name"]), None)
        if c["own"]:
            c["name"] += f" (your {c['own'][0][0]} tag)"
        elif label:
            c["name"] += f" ({label})"
        elif decade:
            c["name"] += f" · mostly {decade}"
        elif style:
            c["name"] += f" + {style}"


def add_map(releases: list, previous: dict) -> list:
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
    x = csr_matrix(x.multiply(1 / norms[:, None]))
    sim = (x @ x.T).toarray()
    np.fill_diagonal(sim, 0)

    for i, r in enumerate(releases):
        top = np.argpartition(-sim[i], 8)[:8]
        top = top[np.argsort(-sim[i][top])]
        r["similar"] = [releases[j]["id"] for j in top if sim[i][j] > 0.05]

    # Group by shared traits first, then lay the map out so each group forms its own island.
    k = max(6, round(n / 90))
    z = TruncatedSVD(min(80, x.shape[1] - 1), random_state=0).fit_transform(x)
    z /= np.linalg.norm(z, axis=1, keepdims=True) + 1e-9
    labels = KMeans(k, n_init=10, random_state=0).fit_predict(z)
    order = np.argsort(-np.bincount(labels, minlength=k))
    rank = {c: i for i, c in enumerate(order)}
    labels = np.array([rank[c] for c in labels])

    init = np.random.default_rng(0).normal(size=(n, 2))
    known = [i for i, r in enumerate(releases) if r["id"] in previous]
    if len(known) > n * 0.8:
        for i, r in enumerate(releases):
            if r["id"] in previous:
                init[i] = previous[r["id"]]
            else:
                near = [previous[s] for s in r["similar"] if s in previous]
                if near:
                    init[i] = np.mean(near, axis=0)
        init = (init - init.mean(axis=0)) / init.std(axis=0)
    init = (init * 1e-4).astype(np.float32)

    dist = 0.7 * np.clip(1 - sim, 0, 1) + 0.3 * (labels[:, None] != labels[None, :])
    np.fill_diagonal(dist, 0)
    xy = TSNE(n_components=2, metric="precomputed", init=init, perplexity=min(30, n - 1), random_state=0).fit_transform(dist)
    xy = (xy - xy.min(axis=0)) / max(np.ptp(xy, axis=0).max(), 1e-9) * 1000
    clusters = []
    for i, r in enumerate(releases):
        r["xy"] = [round(float(xy[i, 0]), 1), round(float(xy[i, 1]), 1)]
        r["cluster"] = int(labels[i])
    for c in range(k):
        idx = np.where(labels == c)[0]
        info = name_cluster([releases[i] for i in idx])
        info.update(id=c, size=int(len(idx)), x=round(float(np.median(xy[idx, 0])), 1), y=round(float(np.median(xy[idx, 1])), 1))
        clusters.append(info)
    disambiguate(clusters)
    return clusters
