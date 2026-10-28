// Local store for Agent conversations (decision #230): one JSON file per chat in the ignored `.local/chat/`.
// Every function that turns an id into a path validates it as a UUID first, so ids can never escape the folder.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_LIMIT = 40;

const count = z.number().int().nonnegative();
const UsageSchema = z.object({ input: count, cached: count.nullable(), output: count, reasoning: count.nullable() });
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(200000),
  at: z.string(),
  usage: UsageSchema.nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  status: z.enum(['stopped', 'error']).optional(),
});
const ChatSchema = z.object({
  id: z.string().regex(UUID),
  title: z.string().max(200),
  createdAt: z.string(),
  updatedAt: z.string(),
  courseIds: z.array(z.string().max(200)).max(100),
  messages: z.array(ChatMessageSchema),
});

export function isChatId(value) { return typeof value === 'string' && UUID.test(value); }

function chatDir(projectDir) { return join(projectDir, '.local', 'chat'); }
function chatFile(projectDir, id) {
  if (!isChatId(id)) throw new Error('INVALID_CHAT_ID');
  return join(chatDir(projectDir), `${id}.json`);
}

/** First line of a message, collapsed and cut to 40 characters, used as the conversation title. */
export function titleFrom(content) {
  const flat = String(content).replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat;
}

async function write(projectDir, chat) {
  const file = chatFile(projectDir, chat.id);
  await mkdir(chatDir(projectDir), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(chat, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) { await rm(temp, { force: true }); throw error; }
  return chat;
}

function cleanIds(ids) {
  return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, 100) : [];
}

export async function createChat(projectDir, { courseIds, title } = {}) {
  const now = new Date().toISOString();
  return write(projectDir, { id: randomUUID(), title: typeof title === 'string' ? titleFrom(title) : '', createdAt: now, updatedAt: now, courseIds: cleanIds(courseIds), messages: [] });
}

/** The stored chat, or null when it does not exist or cannot be parsed. Throws INVALID_CHAT_ID for a bad id. */
export async function readChat(projectDir, id) {
  const file = chatFile(projectDir, id);
  try {
    const parsed = ChatSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch { return null; }
}

/** Conversation summaries, most recently updated first. Unreadable files are skipped. */
export async function listChats(projectDir) {
  let names;
  try { names = await readdir(chatDir(projectDir)); } catch { return []; }
  const chats = await Promise.all(names.flatMap(name => {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    return isChatId(id) ? [readChat(projectDir, id)] : [];
  }));
  return chats.filter(chat => chat !== null)
    .map(({ messages, ...chat }) => ({ ...chat, messageCount: messages.length }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteChat(projectDir, id) {
  const file = chatFile(projectDir, id);
  try { await rm(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Append messages and optionally replace the course scope. Names an untitled chat after its first user message.
 * Returns the updated chat, or null when it no longer exists (for example deleted while a reply was running).
 */
export async function appendMessages(projectDir, id, messages, { courseIds } = {}) {
  chatFile(projectDir, id);
  const chat = await readChat(projectDir, id);
  if (!chat) return null;
  const added = messages.map(message => ChatMessageSchema.parse(message));
  const next = { ...chat, messages: [...chat.messages, ...added], updatedAt: new Date().toISOString(), ...(courseIds ? { courseIds: cleanIds(courseIds) } : {}) };
  if (!next.title) { const first = next.messages.find(message => message.role === 'user'); if (first) next.title = titleFrom(first.content); }
  return write(projectDir, next);
}
