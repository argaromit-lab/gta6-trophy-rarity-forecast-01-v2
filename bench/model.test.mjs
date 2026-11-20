import assert from 'node:assert/strict';
import test from 'node:test';
import { forecast, robustScale, tailFactor } from '../main.ts';
import { readForecast } from './score.mjs';

const start = Date.UTC(2026, 1, 1);
const iso = (hours) => new Date(start + hours * 3_600_000).toISOString();
const levels = [0.05, 0.25, 0.5, 0.75, 0.95];
const reading = (hour, count, rates) => ({ at: iso(hour), players_tracked: count, rates });

function example(history, horizon = 36) {
  return { id: 'example', at: iso(40), target: iso(40 + horizon), horizon_minutes: 60 * horizon, levels,
    trophies: [{ id: 1 }, { id: 9 }, { id: 12 }], history };
}

test('nonzero MAD blocks outliers; zero MAD falls back to local mean absolute change', () => {
  assert.equal(robustScale([-200, 1, 2, 3, 200]), 1.4826);
  assert.equal(robustScale([0, 0, 0, -2]), 0.5);
  assert.equal(robustScale([]), 0);
});

test('tail multiplier is flat in the center and linear out to both tails', () => {
  const expected = [1.5, 1.25, 1, 1, 1.25, 1.5];
  for (const [i, level] of [0.05, 0.15, 0.25, 0.75, 0.85, 0.95].entries()) {
    assert.ok(Math.abs(tailFactor(level) - expected[i]) < 1e-12);
  }
});

test('same population series can dilute one trophy and grow another', () => {
  const reads = [
    reading(4, 1000, [10, 10, 100]), reading(12, 2000, [5, 20, 100]),
    reading(22, 2500, [4, 28, 100]), reading(38, 4000, [2.5, 35, 100]),
  ];
  const input = example(reads);
  const result = forecast(input);
  assert.ok(readForecast(input, Buffer.from(JSON.stringify(result))));
  assert.ok(result.trophies[0].q[2] < 2.5);
  assert.ok(result.trophies[1].q[2] > 35);
  assert.deepEqual(result.trophies[2].q, Array(5).fill(100));

  const withExtraPolls = reads.flatMap((r, i) => [r, { ...r, at: iso([6, 14, 24, 39][i]) }]);
  assert.deepEqual(forecast(example(withExtraPolls)), result);
});

test('zero horizon returns the last available observation, including at 0 or 100', () => {
  const history = [reading(12, 800, [0, 25, 100]), reading(39, 1500, [0, null, 100])];
  const result = forecast(example(history, 0));
  assert.deepEqual(result.trophies.map((row) => row.q), [0, 25, 100].map((rate) => Array(5).fill(rate)));
});
