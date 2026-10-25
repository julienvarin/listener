"""Similarity neighbours and a 2D map of the collection (shared artists, labels, styles, years)."""

import math
from collections import Counter

import numpy as np
from scipy.sparse import csr_matrix
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


def add_map(releases: list, previous: dict) -> None:
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

    dist = np.clip(1 - sim, 0, 1)
    np.fill_diagonal(dist, 0)
    xy = TSNE(n_components=2, metric="precomputed", init=init, perplexity=min(30, n - 1), random_state=0).fit_transform(dist)
    xy = (xy - xy.min(axis=0)) / max(np.ptp(xy, axis=0).max(), 1e-9) * 1000
    for i, r in enumerate(releases):
        r["xy"] = [round(float(xy[i, 0]), 1), round(float(xy[i, 1]), 1)]
