import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so tests never load the local sync API plugin.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
