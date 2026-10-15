import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('uses one check command for local and hook verification', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(pkg.scripts.check).toBe('tsc --noEmit && tsc -p web/tsconfig.json && vitest run');
  const hook = readFileSync('.claude/check.sh', 'utf8');
  expect(hook).toContain('npm run check');
  expect(hook).not.toContain('skipping');
});
