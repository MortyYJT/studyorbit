import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('snapshots and persistent profiles stay local and ignored by git', () => {
  for (const path of ['.local/snapshots/', '.local/profiles/', '.local/crawls/', '.local/coursework.db']) {
    expect(execFileSync('git', ['check-ignore', path], { encoding: 'utf8' }).trim()).toBe(path);
  }
});
