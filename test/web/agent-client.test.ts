import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../../web/src/client.js';
import { createAgentClient } from '../../web/src/agent-client.js';

const meta = { runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', durationMs: 0 };
const secret = 'a'.repeat(64);
async function collect<T>(items: AsyncIterable<T>) { const out: T[] = []; for await (const item of items) out.push(item); return out; }
describe('agent chat client', () => {
  it('resumes the stream with the owner session and last event id as headers, never in the URL', async () => {
    const event = { id: '1:6', messageId: 'm-1', event: { type: 'text', text: 'six' } };
    const fetcher = vi.fn(async () => new Response(`id: 1:6\nevent: text\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
    const chat = createAgentClient(createClient(secret, fetcher));
    expect(await collect(chat.stream('c-1', '1:5', new AbortController().signal))).toEqual([event]);
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('/api/agent/stream?conversation=c-1');
    expect(init.headers).toEqual({ 'Last-Event-ID': '1:5', 'X-Coursework-Session': secret });
  });
  it('surfaces a transport rejection code so a deleted conversation stops reconnecting', async () => {
    const chat = createAgentClient(createClient(secret, async () => new Response(JSON.stringify({ protocol: 'coursework.agent/v1', command: 'unknown', ok: false,
      error: { code: 'NOT_FOUND', message: 'Local HTTP request rejected.', retryable: false }, meta }), { status: 404 })));
    await expect(collect(chat.stream('c-1', undefined, new AbortController().signal))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
