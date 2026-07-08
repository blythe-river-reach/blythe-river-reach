# Blythe River Reach

**Live water levels, daily highs & lows, and multi-day forecasts for the Colorado
River from Lake Havasu down to Walter's Camp.**

The river between Parker Dam and Blythe rises and falls several feet every day —
not from weather, but from dam operations and farm irrigation schedules. This
site turns the government's raw data into one question answered plainly:
*what's the water doing at your spot, and what's it about to do?*

Pick any of two dozen landmarks — Parker Strip resorts, Lost Lake, Water Wheel,
Aha Quin, Hidden Beaches, McIntyre, the Cibola bridges — and the site shows
conditions from the nearest live sensor, a tide table of recent and scheduled
highs and lows, and the dam's own published release schedule, time-shifted to
when that water actually reaches you.

## How it works

There is no server. A GitHub Actions robot in this repo runs hourly: it fetches
Reclamation's hourly sensor feed and two schedule PDFs, parses them, and commits
a small `data/riverdata.json`. The static page (one HTML file, hosted on any
static host) reads that file straight from GitHub. That's the whole
architecture — free to run, nothing to maintain, nothing to crash at 2 AM.

Some details the site handles that raw gauges don't:

- **Same water, shifted clock.** Every place is mapped to a Reclamation river
  mile; pulse arrival times are shifted by distance and travel speed.
- **The travel speed measures itself.** The robot cross-correlates neighboring
  sensors each hour to compute how fast release pulses actually move, instead
  of guessing.
- **Four different rivers in one.** The lake (no tide — shows elevation), the
  Parker Strip (full release, above the CRIT canal), the mid reach (release
  minus CRIT), and below the Palo Verde Diversion Dam (minus the *measured*
  canal diversion from the USGS gauge in the canal itself).
- **Honest labels.** Scheduled values are marked scheduled, estimates say
  they're estimates, and a banner appears if the government feed goes stale.

## Data sources

All data is public U.S. government data:

- Bureau of Reclamation — Lower Colorado hourly conditions feed (nine river
  sensors plus Lake Havasu elevation)
- Bureau of Reclamation — Headgate Rock Dam and Davis/Parker projected release
  schedules (PDF, parsed hourly)
- USGS — Colorado River below Palo Verde Dam (09429100) and Palo Verde Canal
  (09429000) real-time gauges
- Bureau of Reclamation — Lower Colorado River Mile Index (Aug 2001) for
  documented river miles

This project is not affiliated with, or endorsed by, the Bureau of Reclamation
or the USGS.

## Run your own copy

Fork or copy this repo (keep it **public** — the page reads the data file from
GitHub's public file server), set `GH_REPO` near the top of `index.html` to
your own `owner/repo`, enable Actions and run "Update river data" once, and
point any static host (e.g., Netlify) at the repo. The `dev` branch gets its
own data file and preview so you can test changes before merging to `main`.

Everything tunable — places, river miles, travel speed default — is in a
clearly marked config block at the top of `index.html`.

## Disclaimer

All values are provisional and can be wrong. This is not a flood-warning
system and must not be used for safety-critical decisions. Schedules are
estimates and change without notice; always exercise caution on the river.

## License

MIT — see `LICENSE`.
