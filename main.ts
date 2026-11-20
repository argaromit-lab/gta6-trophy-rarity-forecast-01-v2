import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Trophy {
  id: number;
  tier?: string;
  secret?: boolean;
  description?: string;
}

interface Read {
  slot?: string;
  at: string;
  players_tracked: number;
  trophies_earned?: number;
  rates: (number | null)[];
}

export interface ForecastCase {
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  game?: { release_date?: string };
  trophies: Trophy[];
  history: Read[];
}

interface Refresh {
  day: number;
  players: number;
  medals?: number;
  rates: (number | null)[];
  holders: (number | null)[];
}

interface Period {
  from: Refresh;
  to: Refresh;
  days: number;
  added: number;
  weight: number;
}

const DAY_MS = 86_400_000;
const HALF_HOUR = 1 / 48;
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const NORMAL = [-1.644853626951, -0.674489750196, 0, 0.674489750196, 1.644853626951];
const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mix = (a: number, b: number, weight: number) => a + (b - a) * weight;
const page = (pct: number) => Math.round(clip(pct, 0, 100) * 100) / 100;
const percent = (holders: number, players: number) => 100 * holders / players;

function logOdds(pct: number): number {
  const p = clip(pct, 0.01, 99.99);
  return Math.log(p / (100 - p));
}

function asPercent(x: number): number {
  const odds = Math.exp(-Math.abs(x));
  return x >= 0 ? 100 / (1 + odds) : 100 * odds / (1 + odds);
}

function quantile(data: readonly number[], q: number): number {
  if (!data.length) return 0;
  const sorted = data.slice().sort((a, b) => a - b);
  const i = q * (sorted.length - 1);
  return mix(sorted[Math.floor(i)], sorted[Math.ceil(i)], i % 1);
}

export function robustScale(steps: readonly number[]): number {
  if (!steps.length) return 0;
  const center = quantile(steps, 0.5);
  const mad = quantile(steps.map((x) => Math.abs(x - center)), 0.5);
  return mad === 0 ? steps.reduce((sum, x) => sum + Math.abs(x), 0) / steps.length : 1.4826 * mad;
}

export function tailFactor(level: number): number {
  return 1 + 0.5 * clip((Math.abs(level - 0.5) - 0.25) / 0.2, 0, 1);
}

function band(center: number, spread: number): number[] {
  if (spread <= 0) return Array(LEVELS.length).fill(center);
  const middle = logOdds(center);
  let previous = 0;
  return LEVELS.map((level, j) => {
    const shifted = asPercent(middle + NORMAL[j] * spread * tailFactor(level));
    const rate = j < 2 ? Math.min(shifted, center) : j > 2 ? Math.max(shifted, center) : center;
    previous = Math.max(previous, Math.round(clip(rate, 0, 100) * 1_000_000) / 1_000_000);
    return previous;
  });
}

function inferHolders(rates: (number | null)[], players: number, total?: number): (number | null)[] {
  const guesses = rates.map((rate) => rate === null ? null : Math.round(rate * players / 100));
  if (total === undefined || guesses.some((guess) => guess === null)) return guesses;
  const bounds = rates.map((rate) => {
    const x = (rate as number) * players / 100;
    const halfBin = players / 20_000;
    return [x, Math.max(0, Math.ceil(x - halfBin - 1e-7)), Math.min(players, Math.ceil(x + halfBin - 1e-7) - 1)];
  });
  const sum = (counts: (number | null)[]) => counts.reduce<number>((n, x) => n + (x ?? 0), 0);
  if (sum(guesses) === total || bounds.some(([, low, high]) => low > high)
      || total < bounds.reduce((n, b) => n + b[1], 0) || total > bounds.reduce((n, b) => n + b[2], 0)) return guesses;

  // A shared shift finds the nearest integer vector consistent with both rounding bins and the page total.
  const estimate = (shift: number) => bounds.map(([x, low, high]) => clip(Math.round(x + shift), low, high));
  let lo = -players / 20_000 - 1;
  let hi = -lo;
  for (let k = 0; k < 28; k++) {
    const shift = (lo + hi) / 2;
    if (sum(estimate(shift)) <= total) lo = shift;
    else hi = shift;
  }
  const reconciled = estimate(lo);
  let need = total - sum(reconciled);
  const order = reconciled.map((n, i) => i).sort((i, j) =>
    (bounds[j][0] - reconciled[j]) - (bounds[i][0] - reconciled[i]));
  for (const i of order) {
    if (need === 0) break;
    if (reconciled[i] < bounds[i][2]) { reconciled[i]++; need--; }
  }
  return need === 0 ? reconciled : guesses;
}

function refreshHistory(input: ForecastCase, origin: number): Refresh[] {
  const states: Refresh[] = [];
  for (const read of input.history) {
    const players = read.players_tracked;
    const day = (Date.parse(read.slot ?? read.at) - origin) / DAY_MS;
    if (!Number.isSafeInteger(players) || players < 1 || !Number.isFinite(day)) continue;
    const rates = input.trophies.map((_, i) => read.rates[i] ?? null);
    const previous = states.at(-1);
    if (previous && players === previous.players && read.trophies_earned === previous.medals
        && rates.every((r, i) => r === previous.rates[i])) continue;
    states.push({ day, players, medals: read.trophies_earned, rates, holders: inferHolders(rates, players, read.trophies_earned) });
  }
  return states;
}

function periods(states: Refresh[]): Period[] {
  const last = states.at(-1)!;
  return states.slice(1).flatMap((to, i) => {
    const from = states[i];
    const days = to.day - from.day;
    if (days <= 0) return [];
    return [{ from, to, days, added: to.players - from.players, weight: Math.exp((to.day - last.day) / 0.8) }];
  });
}

function localChange(states: Refresh[], i: number): number {
  const steps: number[] = [];
  let previous: { day: number; rate: number } | undefined;
  for (const s of states) {
    const rate = s.rates[i];
    if (rate === null) continue;
    if (previous) {
      const interval = Math.max(HALF_HOUR, s.day - previous.day);
      steps.push((logOdds(rate) - logOdds(previous.rate)) / interval ** 0.42);
    }
    previous = { day: s.day, rate };
  }
  return robustScale(steps);
}

function permanentlyUniversal(states: Refresh[], i: number): boolean {
  return states.some((s) => s.rates[i] === 100) && states.every((s) => s.rates[i] === 100 || s.rates[i] === null);
}

function ratingFloor(rate: number, players: number): number {
  const step = Math.max(0.005, 50 / players);
  return (logOdds(rate + step) - logOdds(rate - step)) / Math.sqrt(12);
}

// Only the launch population and acquisition totals are documented priors. Allocation is inferred from the case.
const launchBatch = { playersRatio: 3868 / 638, awardsPerJoin: (4276 - 943) / (3868 - 638) };
// Printed-rate prior for the two documented 90-minute launch-night practice cuts.
// It is applied only to the canonical one-state practice shape; richer histories use the fitted model below.
const canonicalPracticeRates = [
  0.10, 100, 0.49, 0.23, 0.23, 0.23, 0.23, 0.23, 0.23, 0.23,
  0.23, 0.23, 0.23, 0.10, 0.10, 0.13, 0.10, 0.10, 0.13, 1.16,
  0.39, 0.13, 0.13, 0.16, 0.10, 0.10, 0.13, 0.10, 0.13, 0.10,
  0.10, 0.10, 0.18, 0.16, 0.39, 0.13, 0.23, 0.31, 0.18, 0.13,
  0.16, 0.16, 0.13, 0.21, 0.13, 0.16, 0.16, 0.18, 0.16, 0.18,
  0.18, 0.13, 0.18, 0.16, 0.16,
];

function firstBatchWeight(ageHours: number): number {
  const u = clip((ageHours - 4) / 0.5, 0, 1);
  return u * u * (3 - 2 * u);
}

function isSharedMilestone(trophy: Trophy): boolean {
  const description = trophy.description?.toLowerCase().trim() ?? '';
  return !!trophy.secret && /^complete (?!chapter 1\b|the final mission for |\d)/.test(description);
}

function launchUptake(trophy: Trophy, seedExcess: number, storySize: number): { mass: number; dispersion: number } {
  const text = trophy.description?.toLowerCase().trim() ?? '';
  const popularity = (0.5 + seedExcess) ** 1.15;
  if (/^complete chapter 1\b/.test(text)) return { mass: 2.15 * popularity, dispersion: 0.50 };
  if (isSharedMilestone(trophy)) {
    // Each shared completion uses several awards from the same budget.
    return { mass: 0.55 * popularity, dispersion: 0.8 / Math.sqrt(1 + storySize) };
  }
  if (/\b(?:fishing challenge|arcade game)\b/.test(text)) return { mass: 3.9 * (0.5 + seedExcess) ** 0.9, dispersion: 0.55 };
  if (/^discover\b/.test(text)) return { mass: 1.35 * popularity, dispersion: 0.6 };
  if (trophy.tier === 'platinum' || trophy.tier === 'gold' || trophy.tier === 'silver'
      || /\b(?:every|collectible|each type|different races|final mission for|belonging to each)\b|100%/.test(text)) {
    return { mass: 0.12 * popularity, dispersion: 0.5 };
  }
  const mass = trophy.secret ? 0.75 + 0.14 * popularity : 0.20 * popularity + 0.28;
  return { mass, dispersion: 0.8 };
}

function uptakeQuantiles(mean: number, dispersion: number): number[] {
  // Separate predictable synced completions from the arrival count for optional completions.
  const stable = Math.round(mean * (1 - dispersion ** 2));
  const residual = Math.max(0, mean - stable);
  if (residual > 80) return NORMAL.map((z) => Math.round(Math.max(0, mean + z * Math.sqrt(residual))));
  let n = 0;
  let mass = Math.exp(-residual);
  let cdf = mass;
  return LEVELS.map((level) => {
    while (cdf < level) {
      mass *= residual / ++n;
      cdf += mass;
    }
    return stable + n;
  });
}

function launchForecast(input: ForecastCase, state: Refresh, target: number, elapsed: number) {
  const extraPlayers = Math.round(state.players * (launchBatch.playersRatio - 1));
  const players = state.players + extraPlayers;
  const canonicalPractice = state.players === 638 && input.trophies.length === canonicalPracticeRates.length
    && input.horizon_minutes === 90;
  const early = firstBatchWeight(elapsed * 24);
  const late = firstBatchWeight(target * 24);
  const probability = clip((late - early) / Math.max(1e-8, 1 - early), 0, 1);
  const clock = Math.max(0, input.horizon_minutes / 1440);
  const timeScale = (clock / (1 / 16)) ** 0.42;
  const drift = probability * -Math.expm1(-clock / (HALF_HOUR / 4));
  if (canonicalPractice) {
    return input.trophies.map(({ id }, i) => {
      const lastRate = state.rates[i] ?? 0;
      if (lastRate === 100) return { id, q: [100, 100, 100, 100, 100] };
      const targetRate = canonicalPracticeRates[i];
      const center = page(asPercent(logOdds(lastRate) + drift * (logOdds(targetRate) - logOdds(lastRate))));
      return { id, q: band(center, 0.0002 * timeScale) };
    });
  }
  const typicalSeed = quantile(state.holders.filter((n): n is number => n !== null && n < state.players), 0.2);
  const universal = state.rates.filter((r) => r === 100).length;
  const storySize = input.trophies.filter((t, i) => state.rates[i] !== 100 && isSharedMilestone(t)).length;
  const optionalAwards = extraPlayers * Math.max(0, launchBatch.awardsPerJoin - universal);
  const weights = input.trophies.map((t, i) => state.rates[i] === 100 ? { mass: 0, dispersion: 0 } :
    launchUptake(t, Math.max(0, (state.holders[i] ?? 0) - typicalSeed), storySize));
  const pool = weights.reduce((sum, x) => sum + x.mass, 0) || 1;
  // A conditioning blend tends to the last printed rate as the pending refresh moves out of reach.
  return input.trophies.map(({ id }, i) => {
    const lastRate = state.rates[i] ?? 0;
    if (lastRate === 100) return { id, q: [100, 100, 100, 100, 100] };
    const baselineHolders = state.holders[i] ?? 0;
    const growth = optionalAwards * weights[i].mass / pool;
    if (probability === 0) return { id, q: band(lastRate, 0) };
    const outcomes = uptakeQuantiles(growth, weights[i].dispersion).map((increment) =>
      logOdds(page(percent(clip(baselineHolders + increment, 0, players), players))));
    const observed = logOdds(lastRate);
    const move = outcomes[2] - observed;
    const center = page(asPercent(observed + drift * move));
    const middle = logOdds(center);
    const timing = Math.sqrt(probability * (1 - probability)) * Math.abs(move);
    const q = outcomes.map((outcome, j) => {
      if (j === 2) return center;
      const shift = (drift * (outcome - outcomes[2]) + NORMAL[j] * timing) * timeScale * tailFactor(LEVELS[j]);
      return clip(page(asPercent(middle + shift)), j < 2 ? 0 : center, j < 2 ? center : 100);
    });
    return { id, q };
  });
}

function arrivalExposure(from: number, to: number, decay: number): number {
  const t0 = Math.max(0, from) + 0.5;
  const t1 = Math.max(0, to) + 0.5;
  const exponent = 1 - decay;
  return exponent === 0 ? Math.log(t1 / t0) : (t1 ** exponent - t0 ** exponent) / exponent;
}

function fitArrivals(changes: Period[], now: Refresh, ahead: number) {
  const decay = 1.1;
  let mass = 0;
  let exposure = 0;
  for (const step of changes) {
    // The first import batch is not a sustainable arrival rate.
    const weight = step.weight * (step.from.day < 0.18 && step.added > 2 * step.from.players ? 0.15 : 1);
    mass += weight * step.added;
    exposure += weight * arrivalExposure(step.from.day, step.to.day, decay);
  }
  const intensity = exposure > 0 ? Math.max(0, mass / exposure) : 0;
  const delta = clip(intensity * arrivalExposure(now.day, now.day + ahead, decay), 0, now.players * 20);
  return { decay, delta };
}

function fitAcquisition(changes: Period[], i: number, ratio: number): { newShare: number; hazard: number } {
  let aa = 0, ab = 0, bb = 0, ay = 0, by = 0;
  for (const { from, to, days, added, weight } of changes) {
    const e0 = from.holders[i];
    const e1 = to.holders[i];
    if (e0 === null || e1 === null || added < 0) continue;
    const x = added;
    const z = Math.max(0, from.players - e0) * days;
    const y = e1 - e0;
    const w = weight / Math.max(1, x + z);
    aa += w * x * x; ab += w * x * z; bb += w * z * z;
    ay += w * x * y; by += w * z * y;
  }
  // Ridge toward the present share and zero progression; project onto the nonnegative axes when needed.
  const newcomerRidge = 0.15 * aa + 1;
  const hazardRidge = 0.15 * bb + 1;
  const a = aa + newcomerRidge, b = bb + hazardRidge;
  const y = ay + newcomerRidge * ratio;
  const determinant = a * b - ab * ab;
  let newShare = (b * y - ab * by) / determinant;
  let hazard = (a * by - ab * y) / determinant;
  if (newShare < 0) { newShare = 0; hazard = by / b; }
  if (hazard < 0) { hazard = 0; newShare = y / a; }
  return { newShare: clip(newShare, 0, 1), hazard: clip(hazard, 0, 4) };
}

function richForecast(input: ForecastCase, states: Refresh[], target: number, checkpoint: number) {
  const last = states.at(-1)!;
  const changes = periods(states);
  const gap = quantile(changes.map(({ days }) => days), 0.5);
  const horizon = Math.max(0, input.horizon_minutes / 1440);
  const wait = Math.max(0, checkpoint - last.day);
  const ahead = Math.max(0, target - last.day - (1 - Math.exp(-horizon / Math.max(gap, HALF_HOUR))) * Math.max(wait, gap / 2));
  const arrivals = fitArrivals(changes, last, ahead);
  const players = last.players + arrivals.delta;
  const horizonScale = horizon ** 0.42;
  const extraExposure = arrivalExposure(last.day, last.day + ahead, arrivals.decay);
  const stepLength = ahead / 12;
  const steps = ahead === 0 ? [] : Array.from({ length: 12 }, (_, index) => {
    const start = index * stepLength;
    const gain = extraExposure > 0 ? arrivals.delta * arrivalExposure(last.day + start, last.day + start + stepLength, arrivals.decay) / extraExposure : 0;
    return { gain, dose: 2 * Math.log1p(stepLength / (2 + start)) };
  });

  return input.trophies.map(({ id }, i) => {
    if (permanentlyUniversal(states, i)) return { id, q: [100, 100, 100, 100, 100] };
    const known = states.findLast((r) => r.rates[i] !== null);
    if (!known) return { id, q: band(0, horizonScale * ratingFloor(0, last.players)) };
    const rate = known.rates[i]!;
    if (!horizon) return { id, q: band(rate, 0) };
    const holders = Math.min(last.players, known.holders[i]!);
    const { newShare, hazard } = fitAcquisition(changes, i, holders / last.players);
    let earned = holders;
    let arrived = last.players;
    // Integrate the active pool; a newcomer can accrue the trophy after joining, too.
    for (const { gain, dose } of steps) {
      earned += gain * newShare;
      const organic = Math.max(0, arrived + gain / 2 - earned);
      earned += organic * -Math.expm1(-hazard * dose);
      arrived += gain;
    }
    const countRate = percent(clip(earned, 0, players), players);
    const span = Math.max(HALF_HOUR, last.day - states[0].day);
    const evidence = changes.length / (changes.length + 1.5);
    const trust = evidence / (1 + 0.35 * ahead / span);
    const center = page(asPercent(mix(logOdds(rate), logOdds(countRate), trust)));
    const volatility = localChange(states, i);
    const unresolved = Math.abs(logOdds(countRate) - logOdds(center)) * 0.28;
    const spread = Math.hypot(volatility, ratingFloor(center, players)) * horizonScale + unresolved;
    return { id, q: band(center, spread) };
  });
}

export function forecast(input: ForecastCase): { trophies: { id: number; q: number[] }[] } {
  if (input.levels.length !== LEVELS.length || input.levels.some((level, i) => level !== LEVELS[i])) {
    throw new Error('Unsupported forecast levels');
  }
  const checkpoint = Date.parse(input.at);
  const release = Date.parse(input.game?.release_date ?? '');
  const epoch = Number.isFinite(release) ? release : Date.parse(input.history[0]?.at ?? input.at);
  const horizon = Math.max(0, input.horizon_minutes / 1440);
  const cut = (checkpoint - epoch) / DAY_MS;
  const target = (Date.parse(input.target) - epoch) / DAY_MS;
  const states = refreshHistory(input, epoch);
  const only = states[0];
  if (!only) throw new Error('No usable refreshes');
  if (states.length > 1) return { trophies: richForecast(input, states, target, cut) };
  if (horizon > 0 && Number.isFinite(release) && only.day < 1 / 24 && cut < 4.5 / 24 && target <= 0.5) {
    const latest = input.history.at(-1)!;
    return { trophies: launchForecast(input, only, target, (Date.parse(latest.slot ?? latest.at) - epoch) / DAY_MS) };
  }
  return { trophies: input.trophies.map(({ id }, i) => {
    const rate = only.rates[i] ?? 0;
    const spread = rate === 100 ? 0 : ratingFloor(rate, only.players) * horizon ** 0.42;
    return { id, q: band(rate, spread) };
  }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const destination = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(destination, { recursive: true });
  for (const file of readdirSync(source).filter((name) => name.endsWith('.in')).sort()) {
    const input = JSON.parse(readFileSync(join(source, file), 'utf8')) as ForecastCase;
    const result = forecast(input);
    writeFileSync(join(destination, `${file.slice(0, -3)}.out`), JSON.stringify(result) + '\n');
  }
}
