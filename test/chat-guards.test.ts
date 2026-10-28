import { describe, expect, it } from 'vitest';
import { createReplyRegistry } from '../scripts/lib/chat-replies.mjs';
import { foreignOrigin } from '../scripts/lib/local-origin.mjs';

describe('foreignOrigin', () => {
  it('allows requests without an Origin header and from the server itself', () => {
    expect(foreignOrigin({ host: 'localhost:5173' })).toBe(false);
    expect(foreignOrigin({ host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe(false);
  });

  it('rejects every other origin, including other local ports and hosts', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5173', 'https://localhost:5173', 'null', 'http://evil.example', '']) {
      expect(foreignOrigin({ host: 'localhost:5173', origin })).toBe(true);
    }
    expect(foreignOrigin({ origin: 'http://localhost:5173' })).toBe(true);
  });
});

describe('reply registry', () => {
  it('claims a chat synchronously so a second send is refused before any await', () => {
    const replies = createReplyRegistry();
    const first = replies.begin('a');
    expect(first).toBeInstanceOf(AbortController);
    expect(replies.begin('a')).toBeNull();
    expect(replies.running('a')).toBe(true);
    expect(replies.begin('b')).not.toBeNull();
    replies.end('a', first!);
    expect(replies.running('a')).toBe(false);
    expect(replies.begin('a')).not.toBeNull();
  });

  it('ignores an end call from a reply that no longer owns the chat', () => {
    const replies = createReplyRegistry();
    const first = replies.begin('a')!;
    replies.end('a', first);
    const second = replies.begin('a')!;
    replies.end('a', first);
    expect(replies.running('a')).toBe(true);
    replies.end('a', second);
  });

  it('stop aborts the reply and stopAndWait resolves only after the reply ends', async () => {
    const replies = createReplyRegistry();
    expect(replies.stop('a')).toBe(false);
    await expect(replies.stopAndWait('a')).resolves.toBe(false);
    const controller = replies.begin('a')!;
    let settled = false;
    const waiting = replies.stopAndWait('a').then(value => { settled = true; return value; });
    expect(controller.signal.aborted).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    replies.end('a', controller);
    await expect(waiting).resolves.toBe(true);
  });
});
