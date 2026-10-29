import { describe, expect, it } from 'vitest';
import { cliFailureIsTemporary, collectorExitCode, EX_TEMPFAIL, httpFailure, isTemporaryStatus } from '../scripts/lib/collector-exit.mjs';

// Collector exit codes (design §9): 75 when the final request failed with HTTP 429, HTTP 5xx or a network error,
// 1 otherwise. Synthetic responses only; the collectors themselves need Edge and are not run in tests.
describe('collector exit codes', () => {
  it('maps HTTP 429, 5xx and a browser network failure to 75, other statuses to 1', () => {
    expect(EX_TEMPFAIL).toBe(75);
    for (const status of [429, 500, 502, 503, 504, 599, 0]) expect(collectorExitCode(httpFailure('Canvas', status))).toBe(75);
    for (const status of [400, 401, 403, 404, 302]) expect(collectorExitCode(httpFailure('Canvas', status))).toBe(1);
    expect(httpFailure('Canvas', 503).message).toBe('Canvas HTTP 503');
    expect(isTemporaryStatus(600)).toBe(false);
  });

  it('keeps exit code 1 for ordinary failures', () => {
    for (const error of [new Error('Canvas 页面加载超时'), new Error('Canvas 登录可能已失效或页面跳转'), null, undefined]) expect(collectorExitCode(error)).toBe(1);
  });

  it('recognises temporary Ed CLI failures from their output', () => {
    const failure = (stderr: string, more: object = {}) => Object.assign(new Error('Command failed: edstem'), { stderr, ...more });
    for (const stderr of ['Error: HTTP 429 Too Many Requests', 'request failed with status code 503', 'status: 502', 'connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND edstem.org', 'socket hang up']) {
      expect(cliFailureIsTemporary(failure(stderr))).toBe(true);
    }
    for (const stderr of ['HTTP 401 Unauthorized', 'status code 404', 'Not logged in', 'Found 500 lessons']) {
      expect(cliFailureIsTemporary(failure(stderr))).toBe(false);
    }
    expect(cliFailureIsTemporary(failure('HTTP 503', { killed: true }))).toBe(false);
    expect(cliFailureIsTemporary(Object.assign(new Error('read'), { code: 'ECONNRESET' }))).toBe(true);
  });
});
