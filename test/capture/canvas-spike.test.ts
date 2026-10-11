import { afterEach, expect, it, vi } from 'vitest';
import { probeCanvasStudentSession } from '../../src/capture/canvas-spike.js';
import { CANVAS_ORIGIN } from '../../src/capture/discovery.js';
import { RequestLimiter } from '../../src/capture/limiter.js';
import { canvasSpikeFixture, selectedCanvas, syntheticResponse } from './canvas-spike-fixture.js';

afterEach(() => vi.unstubAllGlobals());

it('probes five selected-course collections inside the page using only session GETs', async () => {
  const fixture = canvasSpikeFixture();
  const result = await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter);
  expect(result.code).toBeUndefined();
  expect(result.collections.map(row => row.collection)).toEqual(['assignments', 'assignment_groups', 'owner_submissions', 'modules', 'files']);
  expect(result.collections.every(row => row.kind === 'json' && row.coverage === 'first_page_only')).toBe(true);
  expect(fixture.fetch.mock.calls.map(([endpoint]) => endpoint)).toEqual([
    '/api/v1/courses/101/assignments?per_page=100',
    '/api/v1/courses/101/assignment_groups?per_page=100',
    '/api/v1/courses/101/assignments?include%5B%5D=submission&per_page=100',
    '/api/v1/courses/101/modules?per_page=100',
    '/api/v1/courses/101/files?per_page=100',
  ]);
  for (const [, options] of fixture.fetch.mock.calls) {
    expect(options).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'manual' });
    expect(options.headers).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  }
  expect(fixture.starts).toEqual([0, 1000, 2000, 3000, 4000]);
  expect(result.collections[2]).toMatchObject({ fields: { 'submission.score': ['number'], 'submission.grade': ['string'], 'submission.workflow_state': ['string'] } });
  expect(JSON.stringify([result, fixture.crossed])).not.toMatch(/synthetic-private|authorization|cookie|token|owner@example/);
});

it.each([undefined, { ...selectedCanvas, courses: [{ ...selectedCanvas.courses[0], origin: 'https://evil.invalid' }] }])('rejects invalid selection before evaluate', async selection => {
  const fixture = canvasSpikeFixture();
  await expect(probeCanvasStudentSession(fixture.page, selection, '101', fixture.limiter)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fixture.evaluate).not.toHaveBeenCalled();
});

it.each(['202', '101/assignments', '101?access_token=synthetic-private'])('rejects unselected or forged course %s', async course => {
  const fixture = canvasSpikeFixture();
  await expect(probeCanvasStudentSession(fixture.page, selectedCanvas, course, fixture.limiter)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it.each([`${CANVAS_ORIGIN}/login/canvas`, 'https://login.example.invalid/sso', `${CANVAS_ORIGIN.replace('https://', 'https://synthetic-private@')}/courses/101`])('missing usable page login stops without a GET: %s', async url => {
  const fixture = canvasSpikeFixture({ url });
  expect(await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter)).toMatchObject({ code: 'AUTH_EXPIRED', next: 'Ask the user to sign in again.', collections: [] });
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it('checks origin and login again inside evaluate after navigation races', async () => {
  const fixture = canvasSpikeFixture({ pageLocation: 'https://login.example.invalid/sso' });
  expect(await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter)).toMatchObject({ code: 'AUTH_EXPIRED' });
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it.each([401, 403, 302, 0])('stops on auth/redirect status %i without retries or further reads', async status => {
  const fixture = canvasSpikeFixture({ response: syntheticResponse({ status, type: status === 0 ? 'opaqueredirect' : 'basic' }) });
  const result = await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter);
  expect(result).toMatchObject({ code: 'AUTH_EXPIRED', next: 'Ask the user to sign in again.' });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});

it.each([
  syntheticResponse({ contentType: 'text/html' }),
  syntheticResponse({ body: { error: 'synthetic-private' } }),
  syntheticResponse({ body: [null] }),
  syntheticResponse({ body: [{ id: 1, due_at: 42 }] }),
  syntheticResponse({ jsonError: true }),
  syntheticResponse({ status: 429 }),
  syntheticResponse({ redirected: true }),
])('refuses unusable JSON without content or retry', async response => {
  const fixture = canvasSpikeFixture({ response });
  const result = await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter);
  expect(result.code).toMatch(/SOURCE_UNAVAILABLE|AUTH_EXPIRED/);
  expect(result.collections[0].kind).not.toBe('json');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([result, fixture.crossed])).not.toContain('synthetic-private');
});

it('records pagination without returning or following next URLs', async () => {
  const fixture = canvasSpikeFixture({ response: syntheticResponse({ body: [{ id: 1, submission: null }], link: '<https://evil.invalid/?token=synthetic-private>; rel="next"' }) });
  const result = await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter);
  expect(result.collections[0]).toMatchObject({ kind: 'json', pagination: 'more', coverage: 'first_page_only' });
  expect(fixture.fetch).toHaveBeenCalledTimes(5);
  expect(JSON.stringify([result, fixture.crossed])).not.toMatch(/evil|synthetic-private/);
});

it('does not invent field evidence for empty collections or null owner submission', async () => {
  const fixture = canvasSpikeFixture({ bodies: [[], [], [{ id: 1, submission: null }], [], []] });
  const result = await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter);
  expect(result.collections[0]).toMatchObject({ rows: 0, fields: {} });
  expect(result.collections[2]).toMatchObject({ fields: { submission: ['null'], 'submission.score': ['missing'] } });
});

it('refuses an owner submission response missing the requested submission field', async () => {
  const fixture = canvasSpikeFixture({ bodies: [[{ id: 1 }], [{ id: 1 }], [{ id: 1 }]] });
  expect(await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter)).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  expect(fixture.fetch).toHaveBeenCalledTimes(3);
});

it('withholds thrown fetch/page errors and does not retry', async () => {
  for (const failure of ['fetch', 'page'] as const) {
    const fixture = canvasSpikeFixture();
    if (failure === 'fetch') fixture.fetch.mockRejectedValue(new Error('synthetic-private cookie'));
    else fixture.evaluate.mockRejectedValue(new Error('synthetic-private cookie'));
    const result = await probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter);
    expect(result.code).toBe('SOURCE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|cookie/);
    expect(fixture.evaluate).toHaveBeenCalledTimes(1);
  }
});

it('uses the shared cap and cancellation without extra page calls', async () => {
  const fixture = canvasSpikeFixture();
  for (let i = 0; i < 299; i++) await fixture.limiter.attempt(async () => {});
  await expect(probeCanvasStudentSession(fixture.page, selectedCanvas, '101', fixture.limiter)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  const controller = new AbortController(); controller.abort();
  await expect(probeCanvasStudentSession(fixture.page, selectedCanvas, '101', new RequestLimiter(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});
