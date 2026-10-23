import { z } from 'zod';
import { ConversationSchema, MessageSchema } from '../../src/domain/schemas.js';
import { FailureEnvelopeSchema } from '../../src/protocol/contracts.js';
import { ClientError, type Client } from './client.js';
import { StoredEventSchema, sseParser, type AgentPreset, type StoredEvent } from './chat.js';

const meta = z.strictObject({ runId: z.uuid(), durationMs: z.number().nonnegative() });
const opened = z.object({ conversation: ConversationSchema, messages: z.array(MessageSchema), events: z.array(StoredEventSchema) });
// Transport rejections (unknown conversation on the stream route, bad method) name the command "unknown".
async function envelope<T extends z.ZodType>(response: Response, command: string, data: T): Promise<z.output<T>> {
  const schema = z.union([z.strictObject({ protocol: z.literal('coursework.agent/v1'), command: z.literal(command), meta, ok: z.literal(true), data }),
    FailureEnvelopeSchema.refine(value => value.command === command || value.command === 'unknown')]);
  let raw: unknown;
  try { raw = await response.json(); } catch { throw new ClientError('INVALID_RESPONSE', 'Invalid server response'); }
  const result = schema.safeParse(raw);
  const value = result.data as { ok: true; data: z.output<T> } | { ok: false; error: { code: string; message: string } } | undefined;
  if (!value || value.ok && !response.ok) throw new ClientError('INVALID_RESPONSE', 'Invalid server response');
  if (!value.ok) throw new ClientError(value.error.code, value.error.message);
  return value.data;
}
/** Agent chat routes and owner-only browser routes; every request carries the owner session header, never a URL secret. */
export function createAgentClient(client: Client) {
  const get = <T extends z.ZodType>(route: string, query: Record<string, string | undefined>, data: T) => {
    const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return client.raw(`/api/agent/${route}${params.size ? `?${params}` : ''}`).then(response => envelope(response, `agent.${route}`, data));
  };
  const post = <T extends z.ZodType>(route: string, body: unknown, data: T) => client.raw(`/api/agent/${route}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(response => envelope(response, `agent.${route}`, data));
  const empty = z.strictObject({});
  return {
    list: () => get('list', {}, z.object({ conversations: z.array(ConversationSchema) })).then(value => value.conversations),
    open: (conversation: string) => get('open', { conversation }, opened),
    create: (preset?: AgentPreset) => post('create', preset ? { preset: preset.id, courseId: preset.courseId, assessmentId: preset.assessmentId, title: preset.title } : {}, ConversationSchema),
    send: (conversationId: string, prompt: string) => post('send', { conversationId, prompt }, z.object({ messageId: z.string() })),
    stop: (conversationId: string) => post('stop', { conversationId }, empty),
    remove: (conversationId: string) => post('delete', { conversationId }, empty),
    async *stream(conversation: string, after: string | undefined, signal: AbortSignal): AsyncGenerator<StoredEvent> {
      const response = await client.raw(`/api/agent/stream?${new URLSearchParams({ conversation })}`, { signal, headers: after ? { 'Last-Event-ID': after } : {} });
      if (!response.ok || !response.body) await envelope(response, 'agent.stream', z.never());
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      const parse = sseParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield* parse(value);
        }
      } finally { reader.cancel().catch(() => {}); }
    },
    async image(screenshotRef: string): Promise<Blob> {
      const response = await client.raw(`/api/browser.image?${new URLSearchParams({ screenshotRef })}`);
      if (!response.ok || response.headers.get('Content-Type') !== 'image/png') await envelope(response, 'browser.image', z.never());
      return response.blob();
    },
    view: (tabId: string) => client.raw(`/api/browser.view?${new URLSearchParams({ tabId })}`).then(response => envelope(response, 'browser.view', z.object({ focused: z.literal(true) }))),
  };
}
export type AgentClient = ReturnType<typeof createAgentClient>;
