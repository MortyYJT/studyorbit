import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationService } from '../agent/conversations.js';
import type { OwnerInteraction } from './context.js';
import { CourseworkError } from './errors.js';
import { run } from './envelope.js';

const id = z.string().min(1).max(512);
const context = { courseId: id.optional(), assessmentId: id.optional(), preset: id.optional() };
const create = z.strictObject({ title: z.string().max(512).optional(), ...context });
const target = z.strictObject({ conversationId: id });
const send = target.extend({ prompt: z.string().min(1).max(65536) });
const reads = new Set(['list', 'open', 'stream', 'presets']);
export function agentRoute(url: string): string | undefined {
  const match = /^\/api\/agent\/(create|list|open|send|stop|delete|stream|presets)(?:\?|$)/.exec(url);
  return match?.[1];
}
export function agentMethod(route: string): string { return reads.has(route) ? 'GET' : 'POST'; }
export async function agentCommand(chat: ConversationService, route: string, url: string, input: unknown, owner: OwnerInteraction) {
  return run(`agent.${route}`, async () => {
    const parsed = (schema: z.ZodType) => {
      const result = schema.safeParse(input);
      if (!result.success) throw new CourseworkError('INVALID_INPUT', 'Invalid chat request.');
      return result.data;
    };
    if (route === 'list') return { conversations: chat.list() };
    if (route === 'open') return chat.open(conversationQuery(url));
    if (route === 'presets') {
      const params = new URL(url, 'http://127.0.0.1').searchParams;
      const result = z.strictObject({ courseId: id.optional(), assessmentId: id.optional() }).safeParse(Object.fromEntries(params));
      if (!result.success || new Set(params.keys()).size !== [...params.keys()].length) throw new CourseworkError('INVALID_INPUT', 'Invalid preset context.');
      return { presets: chat.availablePresets(result.data) };
    }
    if (route === 'create') return chat.create(parsed(create) as z.infer<typeof create>, owner);
    const value = parsed(route === 'send' ? send : target) as z.infer<typeof send>;
    if (route === 'send') return chat.send(value.conversationId, value.prompt, owner);
    if (route === 'stop') await chat.stop(value.conversationId, owner);
    else await chat.delete(value.conversationId, owner);
    return {};
  });
}
function conversationQuery(url: string): string {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  const values = params.getAll('conversation');
  if (values.length !== 1 || !id.safeParse(values[0]).success || [...params.keys()].some(key => key !== 'conversation')) {
    throw new CourseworkError('INVALID_INPUT', 'A conversation id is required.');
  }
  return values[0]!;
}
export function streamAgent(chat: ConversationService, req: IncomingMessage, res: ServerResponse, containsSecret: (text: string) => boolean): void {
  const conversation = conversationQuery(req.url!);
  const headers = req.rawHeaders.flatMap((key, index) => index % 2 === 0 && key.toLowerCase() === 'last-event-id' ? [req.rawHeaders[index + 1]!] : []);
  if (headers.length > 1) throw new CourseworkError('INVALID_INPUT', 'Duplicate stream cursor.');
  const after = headers[0];
  chat.events(conversation, after); // Validate before sending headers.
  req.socket?.setTimeout(0);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', Connection: 'close', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const write = (text: string) => {
    if (res.destroyed || res.writableEnded) return;
    // A slow listener reconnects from its cursor instead of buffering an unbounded reply.
    if (containsSecret(text) || !res.write(text)) res.destroy();
  };
  const unsubscribe = chat.subscribe(conversation, after, stored => write(`id: ${stored.id}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(stored)}\n\n`));
  const heartbeat = setInterval(() => write(': keepalive\n\n'), 15000); heartbeat.unref();
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  res.once('close', cleanup); res.once('finish', cleanup);
  if (res.destroyed || res.writableEnded) cleanup();
}
