# Listener

An Apple Music–style player for my Discogs collection. Audio comes from the YouTube videos linked on each release (played audio-only), with Apple Music 30-second previews as a fallback.

- Browse by artist, label, genre, style, decade, format, country, and my own Discogs note fields (genre tag, condition, tag)
- Instant search across titles, artists, labels, catalog numbers, tracks and notes (`⌘K` or `/`)
- Listen Now: Rediscover, On This Day, Hidden Gems (want/have), Most Valuable (lowest marketplace price), Nobody's Selling, Rarest, label and style spotlights, notes
- Collection Map: records cluster by shared artists, labels, styles and eras
- Playlists synced across devices through a private GitHub Gist
- Works on the phone (add to home screen)

## How it works

A GitHub Action runs nightly. It fetches the collection from the Discogs API, computes the similarity map, then encrypts everything (AES-GCM, PBKDF2 key from the site password) into `data/library.enc` and deploys the static site to GitHub Pages. The page is public but the data is unreadable without the password.

Each run reuses the previously deployed bundle, so it only fetches new records plus the 250 releases with the oldest marketplace stats.

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
