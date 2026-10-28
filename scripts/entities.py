"""Discogs profiles for the artists and labels in the collection, for their pages in the app.

Per artist: /artists/{id} (profile, real name, members, groups, aliases, links, photo) plus its release list
sorted by year, first and last page, for the years active and the number of releases and appearances.
Per label: /labels/{id} (profile, contact address, parent and sublabels, links, logo) plus its release list,
which Discogs sorts by catalogue number, so all pages are read for the years (up to LABEL_PAGES pages; bigger
labels get approximate years).

Profiles change rarely: each one is kept for MAX_AGE days. The ones covering the most records go first, within a
request budget per build, so the build stays within Discogs' 60 requests a minute.
"""

import re
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

MAX_AGE = 180
LABEL_PAGES = 4
SKIP_ARTISTS = {194, 355}  # Various, Unknown Artist
SKIP_LABEL = re.compile(r"^(not on label|no label|white label|none)\b", re.I)


def keep_text(s: str, limit: int = 2000) -> str:
    s = (s or "").replace("\r\n", "\n").strip()
    return s if len(s) <= limit else s[: limit].rsplit(" ", 1)[0] + "…"


def resolve_refs(api, text: str, known: dict, limit: int = 6) -> tuple[str, int]:
    """Discogs profiles cite artists and labels by ID ([a67], [l=…] is fine). Turn IDs into [a=Name] / [l=Name],
    from the collection's own names when possible, else by looking them up (at most `limit` requests)."""
    calls = 0

    def name(kind: str, i: int) -> str:
        nonlocal calls
        if (kind, i) not in known and calls < limit:
            calls += 1
            known[(kind, i)] = api.get(f"/{'artists' if kind == 'a' else 'labels'}/{i}").get("name", "")
        return known.get((kind, i), "")

    def sub(m: re.Match) -> str:
        n = name(m.group(1), int(m.group(2)))
        return f"[{m.group(1)}={n}]" if n else ""

    return re.sub(r"\[([al])=?(\d+)\]", sub, text or ""), calls


def location(contact: str) -> str:
    """The address part of a label's contact info: lines that aren't phone, fax, email or web."""
    clean = re.sub(r"\([^)]*\)?|\[[^\]]*\]?|[\[\]]", "", (contact or "").replace("\r", ""))
    lines = [l.strip(" ,;") for l in clean.split("\n")]
    lines = [l for l in lines if l and not re.search(r"(phone|tel|fax|e-?mail|@|www\.|https?:|p\.?o\.? box)", l, re.I)]
    # Where, not who or the street: the first line is usually the company; drop street, box and suite lines and
    # leading postcodes ("114 30 Stockholm").
    if len(lines) >= 2:
        lines = lines[1:]
    elif lines and "," not in lines[0]:
        return ""
    lines = [l for l in lines if not re.search(r"\b(street|road|avenue|blvd|lane|suite|unit|bldg|floor|box|straße|strasse|weg|platz|rue|calle|via)\b|\w (st|str|rd|ave)\.(\W|$)", l, re.I)]
    lines = [re.sub(r"^[\d\s-]+(?=[^\d\s-])", "", l) for l in lines]
    lines = [l for l in lines if l and not re.match(r"^\d", l)]
    return ", ".join(lines[-2:])[:120]


def image(d: dict) -> str:
    imgs = d.get("images") or []
    pick = next((i for i in imgs if i.get("type") == "primary"), imgs[0] if imgs else {})
    return pick.get("uri") or ""


def years_of(items: list) -> list:
    ys = [i.get("year") for i in items if isinstance(i.get("year"), int) and i["year"] > 1800]
    return [min(ys), max(ys)] if ys else []


def fetch_artist(api, aid: int, known: dict) -> tuple[dict, int]:
    d = api.get(f"/artists/{aid}")
    if not d:
        return {"missing": True}, 1
    profile, extra = resolve_refs(api, d.get("profile"), known)
    first = api.get(f"/artists/{aid}/releases?sort=year&sort_order=asc&per_page=100")
    pag = first.get("pagination", {})
    items = first.get("releases", [])
    calls = 2 + extra
    if pag.get("pages", 1) > 1:
        items += api.get(f"/artists/{aid}/releases?sort=year&sort_order=desc&per_page=100").get("releases", [])
        calls += 1
    main = [i for i in items if i.get("role") == "Main"]
    return {
        "name": d.get("name", ""),
        "profile": keep_text(profile),
        "realname": d.get("realname", ""),
        "image": image(d),
        "urls": (d.get("urls") or [])[:8],
        "aliases": [a["name"] for a in d.get("aliases") or []][:12],
        "members": [m["name"] for m in d.get("members") or [] if m.get("active", True)][:16],
        "groups": [g["name"] for g in d.get("groups") or []][:12],
        "total": pag.get("items", len(items)),
        "years": years_of(main or items),
    }, calls


def fetch_label(api, lid: int, known: dict) -> tuple[dict, int]:
    d = api.get(f"/labels/{lid}")
    if not d:
        return {"missing": True}, 1
    profile, extra = resolve_refs(api, d.get("profile"), known)
    items, calls, page, pages = [], 1 + extra, 1, 1
    while page <= min(pages, LABEL_PAGES):
        data = api.get(f"/labels/{lid}/releases?per_page=100&page={page}")
        calls += 1
        pages = data.get("pagination", {}).get("pages", 1)
        total = data.get("pagination", {}).get("items", 0)
        items += data.get("releases", [])
        page += 1
    return {
        "name": d.get("name", ""),
        "profile": keep_text(profile),
        "location": location(d.get("contact_info", "")),
        "image": image(d),
        "urls": (d.get("urls") or [])[:8],
        "parent": (d.get("parent_label") or {}).get("name", ""),
        "sublabels": [s["name"] for s in d.get("sublabels") or []][:16],
        "total": total if items else 0,
        "years": years_of(items),
        "approx": pages > LABEL_PAGES,
    }, calls


def add_entities(api, releases: list, previous: dict, budget: int, sample: bool = False) -> tuple[dict, int]:
    """Returns ({"a<id>": artist, "l<id>": label}, profiles still to fetch), reusing previous profiles younger
    than MAX_AGE days."""
    today = datetime.now(timezone.utc).date()
    stale_before = (today - timedelta(days=MAX_AGE)).isoformat()
    counts = Counter()
    known = {}
    for r in releases:
        for aid, a in zip(r.get("artist_ids") or [], r.get("artists") or []):
            known[("a", aid)] = a
        for l in r.get("labels") or []:
            known[("l", l.get("id"))] = l["name"]
        for aid in set(r.get("artist_ids") or []):
            if aid and aid not in SKIP_ARTISTS:
                counts[f"a{aid}"] += 1
        for lid, label in {(l.get("id"), l["name"]) for l in r.get("labels") or []}:
            if lid and not SKIP_LABEL.match(label):
                counts[f"l{lid}"] += 1
    out = {k: v for k, v in previous.items() if k in counts}
    todo = [k for k, _ in counts.most_common() if out.get(k, {}).get("at", "") < stale_before]
    if sample:  # a quick check: just the top artist and the top label still to fetch
        todo = [k for k in (next((k for k in todo if k[0] == kind), None) for kind in "al") if k]
    if not budget or not todo:
        return out, len(todo)
    print(f"fetching artist and label profiles: {len(todo)} to do, budget {budget} requests", file=sys.stderr)
    spent, done = 0, 0
    started = time.monotonic()
    for key in todo:
        if spent >= budget:
            break
        try:
            info, calls = (fetch_artist if key[0] == "a" else fetch_label)(api, int(key[1:]), known)
        except Exception as e:  # one bad profile must not stop the build
            print(f"  skipped {key}: {e}", file=sys.stderr)
            spent += 1
            continue
        info["at"] = today.isoformat()
        out[key] = info
        spent += calls
        done += 1
        if done % 100 == 0:
            mins = (time.monotonic() - started) / 60
            print(f"  {done} profiles, {spent} requests in {mins:.1f} min ({spent / max(mins, 0.01):.0f} req/min)", file=sys.stderr)
    print(f"  {done} profiles fetched with {spent} requests, {len(todo) - done} left", file=sys.stderr)
    return out, len(todo) - done
