import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readForecast } from './score.mjs';

const { values } = parseArgs({ options: {
  input: { type: 'string', default: 'input' },
  output: { type: 'string', default: 'out' },
  bot: { type: 'string', default: '.' },
  repeats: { type: 'string', default: '2' },
} });

const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 2) throw new Error('--repeats must be at least 2');
const files = readdirSync(values.input).filter((name) => name.endsWith('.in')).sort();
if (!files.length) throw new Error('No input cases');

// A separate Node process and fresh container for every execution. Timing excludes Docker startup.
const runner = `
  const { spawnSync } = require('node:child_process');
  const { readdirSync, lstatSync, readFileSync } = require('node:fs');
  const id = process.argv[1];
  const start = performance.now();
  const child = spawnSync(process.execPath, ['/bot/main.ts'], { cwd: '/bot', timeout: 8_000 });
  const ms = performance.now() - start;
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(String(child.stderr));
  const outputs = readdirSync('/output');
  const file = '/output/' + id + '.out';
  const stat = lstatSync(file);
  if (outputs.length !== 1 || !stat.isFile() || stat.size > 65_536) throw new Error('Invalid output file');
  console.log(JSON.stringify({ ms, node: process.version, bytes: readFileSync(file).toString('base64') }));
`;

mkdirSync(values.output, { recursive: true });
let phaseMs = 0;
let worstMs = 0;
for (const file of files) {
  const id = file.slice(0, -3);
  const inputPath = resolve(values.input, file);
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  let first;
  let runtime;
  let elapsed = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    const result = spawnSync('docker', [
      'run', '--rm', '--network=none', '--cpus=1.0', '--memory=1024m', '--pids-limit=64', '--read-only',
      '--mount', `type=bind,source=${resolve(values.bot)},target=/bot,readonly`,
      '--mount', `type=bind,source=${inputPath},target=/input/${file},readonly`,
      '--tmpfs', '/output:rw,size=1048576', 'node:22-slim', 'node', '-e', runner, id,
    ], { encoding: 'utf8', timeout: 30_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    const reply = JSON.parse(result.stdout);
    runtime = reply.node;
    elapsed += reply.ms;
    worstMs = Math.max(worstMs, reply.ms);
    const output = Buffer.from(reply.bytes, 'base64');
    if (!readForecast(input, output)) throw new Error(`Invalid forecast for ${id}`);
    if (first && !first.equals(output)) throw new Error(`Non-deterministic forecast for ${id}`);
    first = output;
  }
  writeFileSync(resolve(values.output, `${id}.out`), first);
  const mean = elapsed / repeats;
  phaseMs += mean;
  const sha = createHash('sha256').update(first).digest('hex').slice(0, 12);
  console.log(`${id}: ${repeats} identical valid runs, ${mean.toFixed(1)} ms mean, ${first.length} bytes, sha256:${sha} (${runtime})`);
}
console.log(`Phase total ${phaseMs.toFixed(1)} ms; slowest case execution ${worstMs.toFixed(1)} ms`);
