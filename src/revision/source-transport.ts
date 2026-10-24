import type { Page } from 'playwright';
import { withResidentBrowser, type AttachOptions } from '../browser/attach.js';
import { CourseworkError } from '../protocol/errors.js';
import { ED_ORIGIN } from '../capture/ed-transport.js';
import { MAX_SOURCE_BYTES, type SourceResponse, type SourceTransport } from './source-fetch.js';
import { sourceURL } from './sources.js';

/** Cookies and Ed tokens remain inside the resident page; no remote page script is executed. */
export class ResidentSourceTransport implements SourceTransport {
  constructor(private readonly options: AttachOptions<Page> = {}) {}
  async read(value: string): Promise<SourceResponse> {
    const url = sourceURL(value);
    const result = await withResidentBrowser(this.options, async session => {
      const page = await session.newPage();
      await page.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.url() === `${url.origin}/` && request.method() === 'GET') {
          await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Source reader</title>' });
        } else if (!request.isNavigationRequest() && request.url() === url.href && request.method() === 'GET') {
          await route.continue();
        } else await route.abort();
      });
      // Establish the storage origin without loading provider scripts or following a login redirect.
      await page.goto(`${url.origin}/`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      const result = await page.evaluate(async ({ target, origin, ed, max }) => {
        if (location.origin !== origin) return { error: 'SOURCE_UNAVAILABLE' } as const;
        const token = ed ? localStorage.getItem('authToken:au') : undefined;
        if (ed && !token) return { error: 'AUTH_EXPIRED' } as const;
        let response: Response;
        try {
          response = await fetch(target, { method: 'GET', credentials: 'same-origin', redirect: 'manual',
            signal: AbortSignal.timeout(30000), ...(token ? { headers: { 'x-token': token } } : {}) });
        } catch { return { error: 'SOURCE_UNAVAILABLE' } as const; }
        if (response.status === 401 || response.status === 403) return { error: 'AUTH_EXPIRED' } as const;
        if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400 || response.url !== target) {
          return { error: 'SOURCE_UNAVAILABLE', refusal: 'redirect' } as const;
        }
        if (!response.ok) return { error: 'SOURCE_UNAVAILABLE' } as const;
        if (Number(response.headers.get('content-length')) > max) {
          await response.body?.cancel(); return { error: 'LIMIT_EXCEEDED' } as const;
        }
        const reader = response.body?.getReader();
        if (!reader) return { error: 'SOURCE_UNAVAILABLE' } as const;
        let length = 0; const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            length += chunk.value.length;
            if (length > max) { await reader.cancel(); return { error: 'LIMIT_EXCEEDED' } as const; }
            chunks.push(chunk.value);
          }
        } catch { return { error: 'SOURCE_UNAVAILABLE' } as const; }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const contentType = response.headers.get('content-type') ?? '';
        let text: string | undefined;
        const authors: { name: string }[] = [];
        const visible = (html: string): string | undefined => {
          const document = new DOMParser().parseFromString(html, 'text/html');
          if (document.querySelector('input[type="password"], form[action*="login"]')) return undefined;
          document.querySelectorAll('.author,[data-author],[data-author-name],[rel=author],[itemprop=author],.user-name,.student-name').forEach(element => {
            const name = element.getAttribute?.('data-author-name') ?? element.getAttribute?.('data-author') ?? element.textContent;
            if (name?.trim()) authors.push({ name: name.trim() });
            element.remove();
          });
          document.querySelectorAll('script,style,noscript,iframe,input,textarea,select,[hidden],[aria-hidden="true"],.peer-answers,.peer-response,.student-response,[data-peer-answer],[data-peer-answers]').forEach(element => element.remove());
          return document.body.textContent ?? '';
        };
        if (/^text\/html\b/i.test(contentType)) {
          text = visible(new TextDecoder().decode(bytes));
          if (text === undefined) return { error: 'AUTH_EXPIRED' } as const;
        } else if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
          const values: string[] = []; let nodes = 0;
          const walk = (value: unknown, depth = 0): void => {
            if (++nodes > 20000 || depth > 30) throw new Error('Bounded JSON only.');
            if (typeof value === 'string') {
              const extracted = /<[a-z!/]/i.test(value) ? visible(value) : value;
              if (extracted === undefined) throw new Error('Authentication content.');
              values.push(extracted);
            } else if (Array.isArray(value)) value.forEach(item => walk(item, depth + 1));
            else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
              if (/^(?:authors?|users?|people|students?|classmates?|peers?|.*token.*|cookies?|headers|password|credentials?|.*(?:answers?|solutions?).*)$/i.test(key)) continue;
              walk(item, depth + 1);
            }
          };
          try { walk(JSON.parse(new TextDecoder().decode(bytes))); text = values.join('\n'); }
          catch { return { error: 'SOURCE_UNAVAILABLE' } as const; }
        }
        if (token && (new TextDecoder().decode(bytes).includes(token) || text?.includes(token))) {
          return { error: 'SOURCE_UNAVAILABLE' } as const;
        }
        return { url: response.url, status: response.status, contentType, body: Array.from(bytes), ...(text !== undefined ? { text } : {}), ...(authors.length ? { privacyScope: { authors } } : {}) };
      }, { target: url.href, origin: url.origin, ed: url.origin === ED_ORIGIN, max: MAX_SOURCE_BYTES });
      return result;
    });
    if ('error' in result) throw new CourseworkError(result.error!, 'refusal' in result && result.refusal === 'redirect'
      ? 'Redirects and unsuccessful source responses are refused.' : 'Source browser read refused.');
    return { ...result, body: new Uint8Array(result.body) };
  }
}
