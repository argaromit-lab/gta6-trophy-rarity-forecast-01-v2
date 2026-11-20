# gta6-trophy-rarity-forecast-01-v2

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/argaromit-lab/gta6-trophy-rarity-forecast-01-v2/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/argaromit-lab/gta6-trophy-rarity-forecast-01-v2/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecast the PS5 trophy earn rates for Grand Theft Auto VI at the make.fun target, a week after launch, as five quantiles on the logit scale.

## Model

The forecaster collapses repeated Exophase reads into distinct refresh states, reconstructs integer earners from printed rates, and models new tracked players separately from trophy acquisition. For sparse launch-night histories it conditions on the documented first-population refresh and allocates its additional earned trophies using per-trophy rate, tier, and objective text. For longer histories it fits a recency-weighted tracked-player arrival curve and per-trophy newcomer and existing-player acquisition rates. The latter uses `1.4826 * MAD`, falling back to local mean absolute change when MAD is zero.

Quantile spread grows as `horizon ** 0.42`; the `q25`/`q75` spread factor is `1.00`, and the `q05`/`q95` factor is `1.50`, with monotone output.

## Run

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

The program uses Node 22's standard library only. It reads each `*.in` file and writes the matching `*.out` file deterministically.

## Local Checks

The kit does not publish this competition's sealed scorer or answer labels, so an exact official local grade is unavailable. The standalone scorer implements the published pinball formula, validates output shape and fallback behavior, and checks the worked example in `RULES.txt`:

```sh
node --test bench/model.test.mjs bench/score.test.mjs
node bench/score.mjs --input G:/kits/gta6-trophy-rarity-forecast-01-kit/input --reference path/to/reference.json --baseline --expect 1.508366
node bench/score.mjs --input input --output out --reference path/to/reference.json
```

The second command accepts reference JSON with a `cases` array of `{ "id", "actual" }`. The tracked development reference used for model experiments is a public sample's entrant-claimed practice data, not an official answer file.

## License

MIT. See [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/r/e1sxrf3n?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
