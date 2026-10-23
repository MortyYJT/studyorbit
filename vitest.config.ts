import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Heavy tests (CLI processes, sockets, SQLite) finish in ~1 s alone but exceed vitest's 5 s default
  // when every worker competes for CPU; 20 s still fails a hung test.
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 20_000 },
});
