import { describe, expect, it, vi } from 'vitest';
import { createClient, takeOwnerSession } from '../../web/src/client.js';
const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
function response(command: string, data: unknown) {
  return new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command, ok: true, data, meta }));
}
describe('owner frontend client', () => {
  it('consumes the fragment once, clears it synchronously and never persists the secret', () => {
    const replaceState = vi.fn();
    const secret = 'a'.repeat(64);
    expect(takeOwnerSession({ hash: `#s=${secret}`, pathname: '/', search: '?view=week' }, { replaceState })).toBe(secret);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?view=week');
    expect(takeOwnerSession({ hash: '', pathname: '/', search: '' }, { replaceState })).toBeUndefined();
    expect(takeOwnerSession({ hash: '#s=invalid', pathname: '/', search: '' }, { replaceState })).toBeUndefined();
  });
  it('validates shared command data and sends the owner secret only as a header', async () => {
    const fetcher = vi.fn(async () => response('sync.status', { running: false, canvas: {}, ed: {} }));
    const client = createClient('a'.repeat(64), fetcher);
    expect((await client.call('sync.status', {})).running).toBe(false);
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('/api/sync.status');
    expect(init.headers).toMatchObject({ 'X-Coursework-Session': 'a'.repeat(64) });
    expect(init.body).toBe('{}');
    fetcher.mockImplementation(async () => response('sync.status', { running: 'false' }));
    await expect(client.call('sync.status', {})).rejects.toThrow('Invalid server response');
  });
  it('invalidates stale owner authority on transport refusal and tells the page to reopen', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command: 'unknown', ok: false,
      error: { code: 'INVALID_INPUT', message: 'Local HTTP request rejected.', retryable: false }, meta }), { status: 403 }));
    const client = createClient('a'.repeat(64), fetcher);
    await expect(client.call('sync.run', {})).rejects.toMatchObject({ code: 'OWNER_SESSION_EXPIRED' });
    expect(client.hasSession()).toBe(false);
    await expect(client.call('sync.run', {})).rejects.toMatchObject({ code: 'OWNER_SESSION_EXPIRED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps a provider authentication failure separate from the owner session', async () => {
    const client = createClient('a'.repeat(64), async () => new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command: 'sync.run', ok: false,
      error: { code: 'AUTH_EXPIRED', message: 'Sign in again.', retryable: false }, meta }), { status: 401 }));
    await expect(client.call('sync.run', {})).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    expect(client.hasSession()).toBe(true);
  });
});
