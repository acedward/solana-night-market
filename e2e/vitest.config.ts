import { defineConfig } from 'vitest/config';

// AA 00057: the offline tests of the journey's end-to-end lane (the I-1 registry generator, the oracle and
// the step bookkeeping). The live journey (journey.ts) runs only on a local stack through run-local.sh,
// never in CI.
export default defineConfig({
  test: {
    name: 'e2e-journey',
    environment: 'node',
    include: ['**/*.test.ts'],
  },
});
