import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Test against core's source, never a stale build.
      '@patte/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
});
