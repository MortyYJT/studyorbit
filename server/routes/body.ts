// Shared by the routes added with the assistant: the write rule every route applies (exact same-origin Origin and a
// JSON content type) and a bounded JSON body reader.
import type { IncomingMessage } from 'node:http';

export function sameOriginJson(req: IncomingMessage): boolean {
  return !!req.headers.origin && req.headers.origin === `http://${req.headers.host}` && req.headers['content-type']?.split(';')[0] === 'application/json';
}

/** Collects the bytes first and decodes once: a UTF-8 character can be split across chunks. */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size > limit) return { ok: false, tooLarge: true };
  }
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
  catch { return { ok: false, tooLarge: false }; }
}
