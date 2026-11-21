# Ravito

[🇬🇧 English](README.md) | [🇫🇷 Français](README.fr.md)

**A trail race plan calibrated on your own legs.** Drop the race GPX and your past runs, and Ravito tells you when you'll reach each aid station, how much margin you have on every cutoff, and prints a pace band for your wrist.

Everything runs in your browser. No account, no server, no tracking: your files never leave your computer.

## Why another planner?

Watch makers (Garmin PacePro, COROS Pace Strategy) and a few web tools already split a course by gradient, some using your fitness data. Ravito differs in three ways:

1. **A transparent, per-gradient calibration.** Ravito shows how fast *you* actually go at −20 %, 0 % or +25 % from your own runs, next to the generic model, with the amount of data behind each point. No black box.
2. **Built for long races.** The plan accounts for fatigue after hours on your feet, and for stops at aid stations, so cutoff margins are realistic.
3. **Open, private, brand-agnostic.** Free software, a single static page, works with files from any watch.

## Features

- Course import: GPX (with aid stations read from its waypoints), TCX, FIT, and `.gz` versions.
- History import: individual files or **your whole Strava export** (`.zip` or unzipped folder). With `activities.csv`, walks, hikes and rides are left out automatically.
- Robust elevation handling: fixed-step resampling, smoothing and a 3 m hysteresis threshold, so noisy GPS altitude doesn't inflate the gain or the grades.
- Two modes: **predict my time** (intensity slider) or **aim for a time** (Ravito finds the matching effort).
- Aid stations: stop time and clock cutoffs (multi-day races supported); the margin turns red when you're too late.
- Interactive elevation profile, per-section table, kilometre splits, CSV export and a **printable pace band**.
- English and French.

## How the model works

1. **Course**: the track is resampled every 25 m and the elevation smoothed over 150 m before grades are computed.
2. **Generic curve**: speed relative to flat ground follows the energy cost of running on slopes (Minetti et al., 2002), softened for hiking on steep climbs. On descents, the gain is capped at about +10 % around −8 %, then speed drops on steep, technical ground.
3. **Your curve**: each run is cut into 100 m pieces (stops removed). For each 2 % gradient class, your median speed is blended with the generic curve according to how many minutes of data you have. On climbs, speed is forced to keep decreasing as the slope steepens.
4. **Race simulation**: every 25 m, speed = your curve × intensity × fatigue factor. Fatigue kicks in after 1.5 h (training runs already include it) and grows with elapsed time; the "fatigue sensitivity" slider sets how fast.

The engine (`src/engine/`) is pure TypeScript with no DOM, covered by unit tests: recovering a known runner's curve from synthetic runs, ignoring pauses, rejecting bike rides, solving a target time, aid-station timing.

## Getting started

```bash
npm install
npm run dev     # http://localhost:5173/ravito/
npm test        # engine tests
npm run build   # static site in dist/
```

The demo course and demo runner are fully synthetic; no real race track is redistributed.

## Roadmap

- Post-race analysis: compare plan vs. actual, section by section, and refine your curve.
- Fit the fatigue parameter from your longest runs.
- Night and altitude slowdowns.
- Course export to watches with aid-station alerts.
- Map view.

## License

MIT
