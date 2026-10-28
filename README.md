# Listener

An Apple Music–style player for my Discogs collection. Audio comes from the YouTube videos linked on each release (played audio-only), then Apple Music 30-second previews, then Spotify (full tracks when the browser is logged in to Spotify, 30-second previews otherwise).

- Browse by artist, label, genre, style, decade, format, country, and my own Discogs note fields (genre tag, condition, tag)
- Instant search across titles, artists, labels, catalog numbers, tracks and notes (`⌘K` or `/`)
- Listen Now: Rediscover, On This Day, Best Want / Have Ratio, Most Valuable and Heating Up (estimated value), Nobody’s Selling, Rarest, daily label, style and genre-tag spotlights, notes
- Collection Map: named islands of records sharing styles, eras, labels and genre tags
- Made for You: ten playlists a day built from the moods in your notes, countries and decades, Discogs styles, your genre tags, map clusters and labels (reroll with New Mixes, keep one with Save)
- Smart playlists: rules that fill a playlist by themselves (date added, year, genre, style, your tags, moods from notes, country, label, condition, have / want, copies for sale, price, estimated value, rating…), matching all or any. A rule can hold several values (style is House or Tech House), and groups nest an any/all inside another, e.g. style is House or Tech House, fewer than 500 have, and (country France or Belgium). Order, songs per record and a limit
- Playlists synced across devices through a private GitHub Gist
- Works on the phone (add to home screen)

## Track notes

The Discogs Notes field can describe the whole record or single tracks: start a part with the track position. `B1 deep roller` is about B1, `A1-B2 dreamy` about A1 and B2, `A1 banger B1 hit` gives each its own note (A2 gets none), and anything before the first position is about the whole record. Only positions on the record's tracklist count; bare letters or numbers (`A`, `2`) count at the start, after punctuation or before a colon or dash, so "the A side" mid-sentence stays prose.

Track notes show under the track on the album page. Mood and Notes rules in smart playlists, and the mood mixes, take only the tracks a note is about, and the Your Highlights mix collects the tracks you singled out.

## Artist and label pages

Each artist and label page has stats from your collection (records you own, release years, where they were pressed, formats, styles, estimated value, most valuable and rarest record, labels or artists you have with them) and their Discogs profile (`scripts/entities.py`): description, real name, members, aliases, parent label and sublabels, where a label is based, links, photo or logo, number of releases on Discogs and years active.

Profiles cost 2–6 Discogs requests each and are kept for 180 days. Builds fetch the artists and labels covering the most records first: nightly within 900 requests (about 15 minutes), or with the manual run's `entities` input. Set `batches` too (e.g. entities 1500, batches 5) to fetch in back-to-back runs that each deploy what they fetched, so a cancelled or failed run loses at most one batch.

## BPM and energy

Each track's tempo and energy are measured on its 30-second preview (`scripts/audio_features.py`): found on Deezer (free API, no key), or the Apple preview when Deezer doesn't have it, decoded with ffmpeg and analyzed with librosa. Spotify no longer offers its audio features to apps.

- **BPM:** tempo of the onset envelope. Beat trackers often report double the felt tempo of slow music, so Downtempo, Trip Hop, Hip Hop, Dub and similar Discogs styles are folded down by half above 125 BPM. Tracks without a clear pulse get no BPM. Expect the right ballpark (slow vs fast) rather than DJ-grade precision.
- **Energy 0–10:** loudness, rhythmic busyness and brightness, each ranked against the rest of the collection and averaged. 0 is your calmest track, 10 your most intense.

About 300 tracks a minute. Nightly builds measure up to 3,000 new tracks; the manual run's `audio` input takes `all`. Both show on track rows and work as smart playlist rules (BPM, Energy) and orders (slowest, calmest…).

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

Each run reuses the previously deployed bundle, so it only fetches new records plus the 500 releases with the oldest marketplace stats. Requests are paced to the limit Discogs reports for the token in its `X-Discogs-Ratelimit` header (60 a minute by default) with 4 in flight, so if Discogs raises the limit for your account, builds speed up on their own (`--max-rate` caps it, `--workers` sets the parallelism); price suggestions (a second request per record) are only re-fetched when a record's market stats changed or they're over a month old. For records with no YouTube video it also looks up Apple Music previews (up to 500 lookups a run), so records with nothing to play show grayed out.

## Setup

Repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `DISCOGS_TOKEN` | Personal token from discogs.com/settings/developers |
| `DISCOGS_USERNAME` | Discogs username |
| `LISTENER_PASSWORD` | Password for the site |
| `GIST_TOKEN` | Classic GitHub token with only the `gist` scope (playlist sync) |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Optional. From an app at developer.spotify.com/dashboard (Web API). Nightly and manual builds then look up Spotify tracks for records YouTube and Apple can't play |

Pages must be set to deploy from GitHub Actions. Then run the **Build and deploy** workflow. The first run fetches every release (about 45 minutes at Discogs' rate limit).

## Local

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
DISCOGS_TOKEN=… DISCOGS_USERNAME=… LISTENER_PASSWORD=… .venv/bin/python scripts/build_data.py
python3 -m http.server 8000
```
