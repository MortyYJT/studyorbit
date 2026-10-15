import { chromium } from 'playwright';
import { CANVAS_ORIGIN } from '../sync/ed-scope.js';
import { ED_ORIGIN } from '../capture/ed-transport.js';
import { CourseworkError } from '../protocol/errors.js';
import { ResidentBrowser, type BrowserState } from './resident.js';
import type { SiteStatus } from './status.js';

export type SignInSite = 'canvas' | 'ed';
export interface SignInResult { site: SignInSite; status: SiteStatus }
interface SignInPage {
  url(): string;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  bringToFront(): Promise<void>;
}
interface SignInConnection {
  contexts(): { pages(): SignInPage[]; newPage(): Promise<SignInPage> }[];
  close(): Promise<void>;
}
interface SignInOptions {
  resident?: { current(): BrowserState | undefined };
  connect?: (endpoint: string) => Promise<SignInConnection>;
}
function isSignInPage(site: SignInSite, value: string): boolean {
  try {
    const url = new URL(value);
    // The university's Canvas app redirects here for SSO/MFA. Do not match other SSO apps.
    // Entry link: https://lms.unimelb.edu.au/canvas
    if (site === 'canvas' && url.origin === 'https://sso.unimelb.edu.au'
      && /^\/app\/universityofmelbourne_canvas_[^/]+\/[^/]+\/sso\/saml\/?$/.test(url.pathname)) return true;
    return url.origin === (site === 'canvas' ? CANVAS_ORIGIN : ED_ORIGIN)
      && /\/(?:login|auth|signin|sign_in|sso)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}
/** Owner host operation: inspect URLs only and leave the selected page open for manual sign-in. */
export async function bringSignInToFront(site: SignInSite, options: SignInOptions = {}): Promise<SignInResult> {
  try {
    const state = (options.resident ?? new ResidentBrowser()).current();
    if (!state) throw new CourseworkError('AUTH_EXPIRED', 'Run coursework browser start and ask the user to sign in.');
    const key = `${state.endpoint}:${site}`;
    const active = inFlight.get(key);
    if (active) return await active;
    const pending = focusSignIn(site, state, options);
    inFlight.set(key, pending);
    try { return await pending; }
    finally { inFlight.delete(key); }
  } catch (error) {
    if (error instanceof CourseworkError && error.code === 'AUTH_EXPIRED') throw error;
    throw new CourseworkError('SOURCE_UNAVAILABLE', 'Resident sign-in unavailable.');
  }
}
// Coalesce repeated UI clicks in this host, without retaining tabs or endpoints after completion.
const inFlight = new Map<string, Promise<SignInResult>>();
async function focusSignIn(site: SignInSite, state: BrowserState, options: SignInOptions): Promise<SignInResult> {
  let connection: SignInConnection | undefined;
  try {
    const connect = options.connect ?? (async endpoint => chromium.connectOverCDP(endpoint, { noDefaults: true }));
    connection = await connect(state.endpoint);
    const context = connection.contexts()[0];
    if (!context) throw new Error('Missing resident context.');
    let page: SignInPage | undefined = context.pages().find(candidate => isSignInPage(site, candidate.url()));
    if (!page) {
      page = await context.newPage();
      await page.goto(site === 'canvas' ? `${CANVAS_ORIGIN}/login/saml` : `${ED_ORIGIN}/au/login`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    }
    await page.bringToFront();
    // A redirect to a dashboard alone does not establish signedIn. Never inspect tokens or forms.
    const signedOut = isSignInPage(site, page.url());
    return { site, status: { state: signedOut ? 'signedOut' : 'unknown', checkedAt: new Date().toISOString(),
      ...(signedOut ? { hint: { code: 'AUTH_EXPIRED' as const, next: `Sign in to ${site === 'canvas' ? 'Canvas' : 'Ed'} by hand in the resident browser.` as const } } : {}) } };
  } catch (error) {
    if (error instanceof CourseworkError && error.code === 'AUTH_EXPIRED') throw error;
    throw new CourseworkError('SOURCE_UNAVAILABLE', 'Resident sign-in unavailable.');
  } finally {
    // CDP Browser.close disconnects this client; it leaves the resident and all its tabs running.
    try { await connection?.close(); }
    catch { throw new CourseworkError('SOURCE_UNAVAILABLE', 'Resident sign-in unavailable.'); }
  }
}
