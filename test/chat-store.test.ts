import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendMessages, createChat, deleteChat, isChatId, listChats, readChat, titleFrom } from '../scripts/lib/chat-store.mjs';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'chat-store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('chat store', () => {
  it('creates, reads, lists newest first and deletes conversations', async () => {
    const first = await createChat(dir, { courseIds: ['syn-1'] });
    expect(isChatId(first.id)).toBe(true);
    expect(first).toMatchObject({ title: '', courseIds: ['syn-1'], messages: [] });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await createChat(dir, { title: 'Synthetic plan' });
    expect(await readChat(dir, first.id)).toEqual(first);
    expect((await listChats(dir)).map(chat => chat.id)).toEqual([second.id, first.id]);
    expect(await deleteChat(dir, first.id)).toBe(true);
    expect(await deleteChat(dir, first.id)).toBe(false);
    expect(await readChat(dir, first.id)).toBeNull();
    expect((await listChats(dir)).map(chat => chat.id)).toEqual([second.id]);
  });

  it('appends messages, names the chat from the first user message and moves it to the top', async () => {
    const older = await createChat(dir, {});
    await new Promise(resolve => setTimeout(resolve, 5));
    const newer = await createChat(dir, {});
    const long = '这周我应该先做什么？请结合 SYN10001 的作业和测验安排，帮我排一个优先级清单。';
    await new Promise(resolve => setTimeout(resolve, 5));
    const updated = await appendMessages(dir, older.id, [{ role: 'user', content: long, at: new Date().toISOString() }], { courseIds: ['syn-1'] });
    expect(updated?.title).toBe(titleFrom(long));
    expect(updated?.title.length).toBeLessThanOrEqual(40);
    expect(updated?.courseIds).toEqual(['syn-1']);
    await appendMessages(dir, older.id, [{ role: 'assistant', content: '先做 Assignment 2。', at: new Date().toISOString(), model: 'synthetic-model', usage: { input: 10, cached: null, output: 5, reasoning: null } }]);
    const chat = await readChat(dir, older.id);
    expect(chat?.messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(chat?.title).toBe(titleFrom(long));
    expect((await listChats(dir))[0]).toMatchObject({ id: older.id, messageCount: 2 });
    expect((await listChats(dir))[1]?.id).toBe(newer.id);
    expect(await appendMessages(dir, '00000000-0000-4000-8000-000000000000', [])).toBeNull();
  });

  it('rejects ids that are not UUIDs on every path use', async () => {
    for (const id of ['../secret', 'abc', '../../etc/passwd', '00000000-0000-4000-8000-000000000000/../x']) {
      await expect(readChat(dir, id)).rejects.toThrow('INVALID_CHAT_ID');
      await expect(deleteChat(dir, id)).rejects.toThrow('INVALID_CHAT_ID');
      await expect(appendMessages(dir, id, [])).rejects.toThrow('INVALID_CHAT_ID');
    }
  });

  it('writes atomically into .local/chat and skips unreadable files when listing', async () => {
    const chat = await createChat(dir, {});
    const files = await readdir(join(dir, '.local', 'chat'));
    expect(files).toEqual([`${chat.id}.json`]);
    expect(JSON.parse(await readFile(join(dir, '.local', 'chat', files[0]!), 'utf8')).id).toBe(chat.id);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, '.local', 'chat', 'not-a-chat.json'), '{');
    await writeFile(join(dir, '.local', 'chat', '11111111-1111-4111-8111-111111111111.json'), '{"broken":true}');
    expect((await listChats(dir)).map(item => item.id)).toEqual([chat.id]);
  });

  it('lists nothing when the folder does not exist yet', async () => {
    expect(await listChats(dir)).toEqual([]);
  });
});
