import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'out/scenarios';
const input = join(root, 'input');
mkdirSync(input, { recursive: true });

const release = Date.UTC(2026, 0, 1);
const hour = (h) => new Date(release + h * 3_600_000).toISOString();
const levels = [0.05, 0.25, 0.5, 0.75, 0.95];
const trophies = Array.from({ length: 55 }, (_, i) => ({ id: i + 1 }));

const regimes = [
  { id: 'dilution', arrivals: (d) => 2700 + 14_000 * (1 - Math.exp(-d / 0.8)) + 420 * d,
    founder: 1.8, join: 0.55, late: 0.3 },
  { id: 'progression', arrivals: (d) => 5000 + 5100 * d ** 0.53,
    founder: 0.55, join: 0.35, late: 1.7 },
  { id: 'mixed', arrivals: (d) => 2700 + 9000 * Math.log1p(d * 2) + 1500 * Math.tanh(d - 1.5) + 1500,
    founder: 0.85, join: 0.85, late: 0.8 },
];

// Synthetic arrivals are six-hour cohorts. Each has its own age-to-unlock curve and share.
function reading(regime, refreshHour) {
  const populations = [Math.round(regime.arrivals(0))];
  for (let h = 6; h <= refreshHour; h += 6) populations.push(Math.round(regime.arrivals(h / 24)));
  const tracked = populations.at(-1);
  const counts = trophies.map((_, i) => {
    if (!i) return tracked;
    const difficulty = ((19 * i) % 53 + 1) / 54;
    const onset = 0.15 + 2.8 * difficulty ** 1.9;
    const potential = 0.005 + 0.22 * (1 - difficulty) ** 2;
    let accumulated = 0;
    for (let j = 0; j < populations.length; j++) {
      const age = (refreshHour - 6 * j) / 24 + 0.14;
      const joins = j === 0 ? populations[0] : populations[j] - populations[j - 1];
      const immediate = (j === 0 ? regime.founder : regime.join) * potential * (0.98 - 0.75 * difficulty);
      const late = regime.late * potential * -Math.expm1(-((age / onset) ** 1.35));
      accumulated += joins * Math.min(1, immediate + late);
    }
    return Math.round(accumulated);
  });
  return {
    players_tracked: tracked,
    trophies_earned: counts.reduce((x, y) => x + y, 0),
    rates: counts.map((n) => Math.round(10_000 * n / tracked) / 100),
  };
}

const cases = [];
for (const regime of regimes) {
  const history = [];
  const cut = 59.5, target = 168;
  for (let refresh = 0; refresh < cut; refresh += 6) {
    const data = reading(regime, refresh);
    for (let poll = refresh; poll < Math.min(cut, refresh + 6); poll += 1 / 3) {
      history.push({ ...data, at: hour(poll), slot: hour(poll), rates: [...data.rates] });
    }
  }
  history[0].rates[53] = null;
  const result = { id: regime.id, at: hour(cut), target: hour(target), horizon_minutes: (target - cut) * 60,
    game: { release_date: '2026-01-01' }, levels, trophies, history };
  writeFileSync(join(input, `${regime.id}.in`), JSON.stringify(result));
  cases.push({ id: regime.id, actual: reading(regime, target).rates });
}
writeFileSync(join(root, 'answer.json'), JSON.stringify({ source: 'Synthetic cohort scenarios', cases }) + '\n');
console.log(`Generated ${cases.length} synthetic cases in ${root}`);
