import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const levels = [0.05, 0.25, 0.5, 0.75, 0.95];
const houseZ = [-1.645, -0.674, 0, 0.674, 1.645];
const onScale = (rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 100;
const lastRate = (input, i) => input.history.at(-1)?.rates[i] ?? 0;

function logOdds(rate) {
  const p = Math.max(0.01, Math.min(99.99, rate)) / 100;
  return Math.log(p / (1 - p));
}

function hasKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function readForecast(input, bytes) {
  if (!bytes || bytes.byteLength > 65_536) return null;
  let forecast;
  try {
    forecast = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!hasKeys(forecast, ['trophies']) || !Array.isArray(forecast.trophies)
      || forecast.trophies.length !== input.trophies.length) return null;
  const quantiles = new Map();
  for (const row of forecast.trophies) {
    if (!hasKeys(row, ['id', 'q']) || quantiles.has(row.id) || !Array.isArray(row.q)
        || row.q.length !== levels.length || row.q.some((q, i) => !onScale(q) || (i > 0 && q < row.q[i - 1]))) {
      return null;
    }
    quantiles.set(row.id, row.q);
  }
  return input.trophies.every(({ id }) => quantiles.has(id)) ? quantiles : null;
}

export function scoreCase(input, actual, bytes) {
  if (!Array.isArray(actual) || actual.length !== input.trophies.length || !actual.every(onScale)) {
    throw new Error(`Unusable rates in the reference for ${input.id}`);
  }
  const forecast = readForecast(input, bytes);
  let pinball = 0;
  let miss = 0;
  let covered = 0;
  for (const [i, { id }] of input.trophies.entries()) {
    const rate = actual[i];
    const truth = logOdds(rate);
    const q = forecast?.get(id) ?? Array(levels.length).fill(lastRate(input, i));
    for (const [j, tau] of levels.entries()) {
      const delta = truth - logOdds(q[j]);
      pinball += 2 * (delta < 0 ? (tau - 1) * delta : tau * delta);
    }
    miss += Math.abs(rate - q[2]);
    if (q[0] <= rate && rate <= q[4]) covered++;
  }
  return { pinball, miss, covered, trophies: actual.length, valid: forecast ? 1 : 0 };
}

export function summarize(cases) {
  const trophies = cases.reduce((n, c) => n + c.trophies, 0);
  if (!trophies) throw new Error('No trophies to score');
  return {
    loss: (cases.reduce((n, c) => n + c.pinball, 0) / (trophies * levels.length)).toFixed(6),
    typical_miss_pp: (cases.reduce((n, c) => n + c.miss, 0) / trophies).toFixed(2),
    coverage_90: (cases.reduce((n, c) => n + c.covered, 0) / trophies).toFixed(6),
    valid: cases.every(({ valid }) => valid === 1) ? 1 : 0,
  };
}

function readOutput(path) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info?.isFile() && info.size <= 65_536 ? readFileSync(path) : null;
}

function houseBaseline(input) {
  const spread = 0.5 * Math.sqrt(input.horizon_minutes / 1440);
  const last = input.history.at(-1);
  return { trophies: input.trophies.map(({ id }, i) => {
    const rate = last.rates[i] ?? 0;
    const center = logOdds(rate);
    const q = houseZ.map((z) => Math.round((100 / (1 + Math.exp(-(center + z * spread)))) * 10000) / 10000);
    return { id, q };
  }) };
}

function scoreDirectory(inputDir, referencePath, outputDir, baseline) {
  const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
  const labels = new Map(reference.cases.map(({ id, actual }) => [id, actual]));
  const names = readdirSync(inputDir).filter((name) => name.endsWith('.in')).sort();
  const cases = names.map((name) => {
    const id = name.slice(0, -3);
    const input = JSON.parse(readFileSync(join(inputDir, name), 'utf8'));
    const bytes = baseline ? Buffer.from(JSON.stringify(houseBaseline(input))) : readOutput(join(outputDir, `${id}.out`));
    return { id, score: scoreCase(input, labels.get(id), bytes) };
  });
  return { reference: reference.source ?? referencePath, cases, mean: summarize(cases.map(({ score }) => score)) };
}

function run() {
  const { values } = parseArgs({ options: {
    input: { type: 'string', default: 'input' },
    output: { type: 'string', default: 'out' },
    reference: { type: 'string' },
    expect: { type: 'string' },
    baseline: { type: 'boolean', default: false },
  } });
  if (!values.reference) throw new Error('Supply --reference path/to/answer.json with cases [{id, actual}]');
  const result = scoreDirectory(values.input, values.reference, values.output, values.baseline);
  console.log(`Reference: ${result.reference}`);
  for (const { id, score } of result.cases) console.log(id, JSON.stringify(summarize([score])));
  console.log('mean', JSON.stringify(result.mean));
  if (!result.mean.valid || (values.expect !== undefined && result.mean.loss !== values.expect)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
