import { expect, it } from 'vitest';
import { CourseworkError, retryable } from '../../src/protocol/errors.js';

it('fixes retryability for the complete closed set of error codes', () => {
  expect(retryable).toEqual({
    INVALID_INPUT: false, NOT_FOUND: false, CONFLICT: true,
    AUTH_EXPIRED: false, SOURCE_UNAVAILABLE: true, LOCKED: true,
    CITATION_MISMATCH: false, LIMIT_EXCEEDED: false, INTERNAL: false, UNCERTAIN: false,
  });
});

it('carries a known code, message and optional recovery hint', () => {
  const error = new CourseworkError('CONFLICT', 'State changed.', 'Re-read and retry.');
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ name: 'CourseworkError', code: 'CONFLICT',
    message: 'State changed.', next: 'Re-read and retry.' });
  expect(new CourseworkError('NOT_FOUND', 'Missing.').next).toBeUndefined();
});

it('expired login defaults to asking the user to sign in', () => {
  expect(new CourseworkError('AUTH_EXPIRED', 'Session expired.').next)
    .toBe('Ask the user to sign in again.');
});

it('expired login recovery cannot be overridden to automate sign-in or omit the hint', () => {
  for (const next of ['', 'Sign in automatically.']) {
    expect(new CourseworkError('AUTH_EXPIRED', 'Session expired.', next).next)
      .toBe('Ask the user to sign in again.');
  }
});

it('rejects unknown codes at compile time', () => {
  if (false) {
    // @ts-expect-error Unknown codes must fail the TypeScript build.
    new CourseworkError('UNKNOWN', 'Invalid code.');
  }
});
