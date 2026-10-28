# Listener

An Apple Music–style player for my Discogs collection. Audio comes from the YouTube videos linked on each release (played audio-only), with Apple Music 30-second previews as a fallback.

- Browse by artist, label, genre, style, decade, format, country, and my own Discogs note fields (genre tag, condition, tag)
- Instant search across titles, artists, labels, catalog numbers, tracks and notes (`⌘K` or `/`)
- Listen Now: Rediscover, On This Day, Best Want / Have Ratio, Most Valuable and Heating Up (estimated value), Nobody’s Selling, Rarest, daily label, style and genre-tag spotlights, notes
- Collection Map: named islands of records sharing styles, eras, labels and genre tags
- Made for You: ten playlists a day built from the moods in your notes, countries and decades, Discogs styles, your genre tags, map clusters and labels (reroll with New Mixes, keep one with Save)
- Playlists synced across devices through a private GitHub Gist
- Works on the phone (add to home screen)

## Estimated value

Each record shows a single estimated value next to the lowest price (`js/value.js`):

- **Recent sales:** Discogs price suggestions at VG+ (derived from the release's sales history).
- **Marketplace:** the cheapest listing compared to what's normal for that many copies (a lone listing usually sits around 2× recent sales, the cheapest of 10+ copies around 0.6×). Listings are asking prices, so what they add on top of recent sales is discounted.
- **History:** every refresh stores a price point. A record that has been going up is assumed to keep rising for a while (and falling records keep falling), capped at +35% / −20%.
- **Scarcity:** wanted and nobody selling adds a premium that grows with demand and with how long no copy has been listed.
- **Your copy:** if your Discogs notes have a Media Condition, the estimate is scaled to that grade.

The collection total is compared against Discogs' own collection value (min / median / max).

## YouTube ads

Ads play inside YouTube's embedded player and the API doesn't report them. The app spots one when YouTube says it's playing but the song's clock doesn't move, mutes it, and shows **Ad · muted** until the song starts.

YouTube Premium removes embed ads only if the embedded player can see your YouTube login. That's a cross-site cookie, which Safari blocks by default (Settings → Apps → Safari → Prevent Cross-Site Tracking). Turning that off makes Premium work here, but it applies to every site.

## Curated clusters

The Collection Map groups records into regions and mini clusters by shared styles, eras, labels, countries, genre tags and the mood words in the Discogs notes. Names and memberships are curated once and stored encrypted in `data/clusters.enc` (key: the `CLUSTER_KEY` secret, plus a local, git-ignored `.cluster_key`). Nightly builds put new records in the closest existing cluster.

To re-curate: `scripts/seed_clusters.py draft` on a local bundle, write a names file, then `scripts/seed_clusters.py seal`. Keep the draft and names files out of the repo.

## How it works

A GitHub Action runs nightly. It fetches the collection from the Discogs API, computes the similarity map, then encrypts everything (AES-GCM, PBKDF2 key from the site password) into `data/library.enc` and deploys the static site to GitHub Pages. The page is public but the data is unreadable without the password.

Each run reuses the previously deployed bundle, so it only fetches new records plus the 250 releases with the oldest marketplace stats. For records with no YouTube video it also looks up Apple Music previews (up to 500 lookups a run), so records with nothing to play show grayed out.

## Setup

Repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `DISCOGS_TOKEN` | Personal token from discogs.com/settings/developers |
| `DISCOGS_USERNAME` | Discogs username |
| `LISTENER_PASSWORD` | Password for the site |
| `GIST_TOKEN` | Classic GitHub token with only the `gist` scope (playlist sync) |

Pages must be set to deploy from GitHub Actions. Then run the **Build and deploy** workflow. The first run fetches every release (about 45 minutes at Discogs' rate limit).

## Local

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
DISCOGS_TOKEN=… DISCOGS_USERNAME=… LISTENER_PASSWORD=… .venv/bin/python scripts/build_data.py
python3 -m http.server 8000
```
