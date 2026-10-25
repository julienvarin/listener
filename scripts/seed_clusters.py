"""Curated, stable clusters for the collection map.

  draft: compute regions and mini clusters from a local bundle and write their profiles (plaintext, keep it
         out of the repo) so names can be written for them.
  seal:  combine the draft with a names file into data/clusters.enc, encrypted with CLUSTER_KEY.

The sealed file only holds ciphertext; the build decrypts it with the CLUSTER_KEY secret.
"""

import argparse
import base64
import gzip
import json
import os
import sys
from collections import Counter
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"LSC1"


def seal(seed: dict, key: bytes) -> bytes:
    iv = os.urandom(12)
    return MAGIC + iv + AESGCM(key).encrypt(iv, gzip.compress(json.dumps(seed).encode(), mtime=0), None)


def unseal(blob: bytes, key: bytes) -> dict:
    assert blob[:4] == MAGIC, "not a cluster seed"
    return json.loads(gzip.decompress(AESGCM(key).decrypt(blob[4:16], blob[16:], None)))


def load_key(value: str) -> bytes:
    return base64.b64decode(value.strip())


def main() -> None:
    sys.path.insert(0, str(Path(__file__).parent))
    from build_data import decrypt
    from collection_map import describe, embed, feature_matrix, hierarchy

    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("draft")
    d.add_argument("--bundle", required=True)
    d.add_argument("--password", required=True)
    d.add_argument("--out", required=True)
    s = sub.add_parser("seal")
    s.add_argument("--draft", required=True)
    s.add_argument("--names", required=True)
    s.add_argument("--key-file", required=True)
    s.add_argument("--out", default="data/clusters.enc")
    args = ap.parse_args()

    if args.cmd == "draft":
        releases = decrypt(Path(args.bundle).read_bytes(), args.password)["releases"]
        region, mini = hierarchy(embed(feature_matrix(releases)))
        clusters = []
        for m in sorted(set(mini.tolist())):
            members = [r for r, x in zip(releases, mini) if x == m]
            info = describe(members, releases)
            info.update(
                id=m,
                region=int(region[mini == m][0]),
                artists=Counter(a for r in members for a in r["artists"] if a.lower() not in ("various", "unknown artist")).most_common(6),
                examples=[f"{r['artists'][0] if r['artists'] else '?'} - {r['title']}" for r in members[:8]],
                notes=[r["notes"]["Notes"][:80] for r in members if (r.get("notes") or {}).get("Notes")][:6],
            )
            clusters.append(info)
        draft = {"assign": {str(r["id"]): int(x) for r, x in zip(releases, mini)}, "clusters": clusters}
        Path(args.out).write_text(json.dumps(draft, indent=1, ensure_ascii=False))
        print(f"{region.max() + 1} regions, {len(clusters)} mini clusters -> {args.out}")
    else:
        draft = json.loads(Path(args.draft).read_text())
        names = json.loads(Path(args.names).read_text())
        regions = {str(c["region"]) for c in draft["clusters"]}
        missing = [c["id"] for c in draft["clusters"] if str(c["id"]) not in names["minis"]] + [r for r in regions if r not in names["regions"]]
        if missing:
            sys.exit(f"missing names for {missing}")
        seed = {
            "regions": names["regions"],
            "minis": {str(c["id"]): {"name": names["minis"][str(c["id"])], "region": c["region"]} for c in draft["clusters"]},
            "assign": draft["assign"],
        }
        Path(args.out).write_bytes(seal(seed, load_key(Path(args.key_file).read_text())))
        print(f"sealed {len(seed['minis'])} clusters, {len(seed['regions'])} regions -> {args.out}")


if __name__ == "__main__":
    main()
