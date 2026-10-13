import { chromium, type Page } from 'playwright';
import { CourseworkError } from '../protocol/errors.js';
import { ResidentBrowser, type BrowserState } from './resident.js';

export interface OwnedPage { close(): Promise<void> }
export interface BrowserConnection<P extends OwnedPage> {
  contexts(): { newPage(): Promise<P> }[];
  /** For connectOverCDP, Browser.close disconnects the client, leaving the resident running. */
  close(): Promise<void>;
}
export interface BrowserSession<P extends OwnedPage> { newPage(): Promise<P> }
export interface AttachOptions<P extends OwnedPage> {
  resident?: { current(): BrowserState | undefined };
  connect?: (endpoint: string) => Promise<BrowserConnection<P>>;
}
/** Exposes only tab creation; callers cannot close the shared default context or other tabs. */
export async function withResidentBrowser<T, P extends OwnedPage = Page>(
  options: AttachOptions<P>, operation: (session: BrowserSession<P>) => Promise<T>,
): Promise<T> {
  let connection: BrowserConnection<P> | undefined;
  const pages: P[] = [];
  try {
    const state = (options.resident ?? new ResidentBrowser()).current();
    if (!state) throw new CourseworkError('AUTH_EXPIRED', 'Run coursework browser start and ask the user to sign in.');
    const connect = options.connect ?? (async endpoint => chromium.connectOverCDP(endpoint, { noDefaults: true }) as unknown as Promise<BrowserConnection<P>>);
    connection = await connect(state.endpoint);
    const context = connection.contexts()[0];
    if (!context) throw new Error('Missing default context.');
    return await operation({ newPage: async () => {
      const page = await context.newPage(); pages.push(page); return page;
    } });
  } catch (error) {
    if (error instanceof CourseworkError && error.code === 'AUTH_EXPIRED') {
      throw new CourseworkError('AUTH_EXPIRED', 'Run coursework browser start and ask the user to sign in.');
    }
    if (error instanceof CourseworkError && error.code === 'LIMIT_EXCEEDED') {
      throw new CourseworkError('LIMIT_EXCEEDED', 'Browser request limit reached.');
    }
    throw new CourseworkError('SOURCE_UNAVAILABLE', 'Resident browser operation unavailable.');
  } finally {
    const closed = await Promise.allSettled(pages.map(page => page.close()));
    let failed = closed.some(result => result.status === 'rejected');
    try { await connection?.close(); } catch { failed = true; }
    if (failed) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Resident browser operation unavailable.');
  }
}
