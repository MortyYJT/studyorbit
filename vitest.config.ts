import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts, which refuses `serve` without the local API token (scripts/dev.mjs sets it).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
