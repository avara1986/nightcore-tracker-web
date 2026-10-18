# Nightcore Tracker — public website

Static, single-page Nightcore rankings among monitored YouTube channels: top songs, rising channels and breakout songs over a seven-day window, with five days of history.

- **Website:** https://avara1986.github.io/nightcore-tracker-web/
- **Created by:** [ESR](https://linktr.ee/crimson.esr)

## How it is published

Everything under `docs/` is generated. The private tracker builds the site from completed collection runs (`public_site.build`), validates it (`public_site.validate`) and pushes it here with `scripts/publish_web.sh`. GitHub Pages serves `docs/` from `main`.

Do not edit `docs/` by hand: the next publication replaces it entirely (`rsync --delete`). The publisher stops if this clone has uncommitted changes or if local and remote histories have diverged; it never force-pushes.

Each published snapshot in `docs/data/` records its ranking date, data cutoff and a run identifier (`run_id` / `data_id` in `docs/data/manifest.json`) to match the deployment with its source data.

## Notes

- Visitors' browsers never query the YouTube API; rankings are precomputed.
- Only an explicit allowlist of public fields is exported.
- See `docs/privacy.html` and `docs/terms.html`.
