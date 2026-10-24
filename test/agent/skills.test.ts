import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { packageRoot } from '../../src/config/data-dir.js';

const skill = (name: string) => readFileSync(join(packageRoot(), 'skills', name, 'SKILL.md'), 'utf8');

// Scenario "Signed out": preparation stops at a sign-in page and records cited pages with source.record.
it('revision and assessment skills stop at sign-in, record with source.record and never use our browser tools', () => {
  for (const name of ['revision', 'assessment']) {
    const text = skill(name);
    expect(text, name).not.toMatch(/browser\.[a-z]+|source\.fetch|resident/);
    expect(text, name).toMatch(/sign-in page/);
    expect(text, name).toContain('source.record');
  }
  expect(skill('revision')).toMatch(/read nothing, write\s+nothing, and ask the owner to sign in/);
  expect(skill('assessment')).toMatch(/Never press a final submit button/);
});
