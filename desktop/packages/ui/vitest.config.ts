import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Why: 32 logical cores available; the suite is per-file overhead bound
    // (fork + jsdom boot), so it parallelizes near-linearly. Why not more:
    // each worker is a node fork holding a jsdom instance (~200 MB resident),
    // so 12 is the bounded ceiling before diminishing memory returns.
    maxWorkers: 12,
  },
});
