import { resolveManifest } from '../src/config.js';

const config = resolveManifest({
  persistence: 'ephemeral',
  provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
});
console.log(JSON.stringify(config, null, 2).slice(0, 1200));
