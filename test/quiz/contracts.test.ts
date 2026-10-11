import { expect, it } from 'vitest';
import { validateTarget } from '../../src/quiz/read/contracts.js';
import { selected } from './synthetic.js';

it('validates the selected source-qualified Ed target before any session work', () => {
  expect(validateTarget({ course: '7', lesson: '11' }, selected)).toEqual({ course: '7', lesson: '11' });
  for (const value of [{ course: '8', lesson: '11' }, { course: '7', lesson: '../11' },
    { course: '7', lesson: 'https://edstem.org/api/lessons/11' },
    { course: '7', lesson: '11', token: 'synthetic-secret' }]) {
    expect(() => validateTarget(value, selected)).toThrowError();
  }
  expect(() => validateTarget({ course: '7', lesson: '11' }, { version: 1, courses: [{ ...selected.courses[0], origin: 'https://evil.invalid' }] })).toThrowError();
});
