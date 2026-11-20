import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreCase, summarize } from './score.mjs';

const example = { id: 'worked-example', trophies: [{ id: 1 }, { id: 2 }], history: [{ rates: [30, 5] }] };
const observed = [22, 8];
const exampleFan = [10, 15, 20, 25, 35];
const bytes = (...rows) => Buffer.from(JSON.stringify({ trophies: rows }));

test('the worked example in RULES.txt matches all four metrics', () => {
  const reversed = bytes({ id: 2, q: exampleFan }, { id: 1, q: exampleFan });
  assert.deepEqual(summarize([scoreCase(example, observed, reversed)]), {
    loss: '0.403404', typical_miss_pp: '7.00', coverage_90: '0.500000', valid: 1,
  });
});

test('an invalid case uses the last read for every level', () => {
  const duplicate = bytes({ id: 1, q: exampleFan }, { id: 1, q: exampleFan });
  const crossed = bytes({ id: 1, q: exampleFan }, { id: 2, q: [1, 5, 3, 7, 9] });
  for (const file of [null, duplicate, crossed, Buffer.alloc(65_537)]) {
    assert.equal(summarize([scoreCase(example, observed, file)]).loss, '0.460230');
    assert.equal(scoreCase(example, observed, file).valid, 0);
  }
});

test('scoring clamps the endpoints without moving the reported point miss', () => {
  const atBounds = bytes({ id: 1, q: Array(5).fill(0.01) }, { id: 2, q: Array(5).fill(99.99) });
  assert.deepEqual(summarize([scoreCase(example, [0, 100], atBounds)]), {
    loss: '0.000000', typical_miss_pp: '0.01', coverage_90: '0.000000', valid: 1,
  });
});
