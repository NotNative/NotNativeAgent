// Dev launcher (bench doctor target): NNA serve in bench-shape with the
// scripted provider endpoint, fixed port, no auth. Not part of the product.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpencodeServe } from '../src/opencode/serve.js';
import { resolveManifest } from '../src/config.js';

const endpoint = process.env.NNA_BENCH_PROVIDER ?? 'http://127.0.0.1:4095/v1';
const config = resolveManifest({
  persistence: 'ephemeral',
  provider: { id: 'bench', endpoint, model: 'bench-model', trust_zone: 'loopback' },
});
const root = await mkdtemp(join(tmpdir(), 'nna-bench-'));
const runtime = await startOpencodeServe({
  config,
  port: Number(process.env.NNA_BENCH_PORT ?? 4050),
  hostname: '127.0.0.1',
  directory: 'D:\\ProjectRepo\\NNAforOC',
  storeRoot: join(root, 'store'),
  reviewerRoot: join(root, 'reviewer'),
  stdout: process.stdout,
  logger: { record: () => {} },
});
console.error(`nna bench serve ready at ${runtime.url} (storage ${root})`);
const stop = async () => { await runtime.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
