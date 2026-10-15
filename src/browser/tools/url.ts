import { CANVAS_ORIGIN } from '../../sync/ed-scope.js';
import { ED_ORIGIN } from '../../capture/ed-transport.js';
import { CourseworkError } from '../../protocol/errors.js';
export function browserURL(value: string): URL {
  let url: URL; let decoded: string;
  try { url = new URL(value); decoded = decodeURIComponent(url.pathname + url.search + url.hash); }
  catch { throw new CourseworkError('INVALID_INPUT', 'A validated provider URL is required.'); }
  if (/\/(?:login|auth|signin|sign_in|sso)(?:[/?#]|$)/i.test(decoded)) throw new CourseworkError('AUTH_EXPIRED', 'Ask the owner to sign in by hand.');
  if (![CANVAS_ORIGIN, ED_ORIGIN].includes(url.origin) || url.username || url.password || /%[a-f0-9]{2}|\\|token|password|credential|session|secret|code=/i.test(decoded)) {
    throw new CourseworkError('INVALID_INPUT', 'Only validated Canvas and Ed pages are allowed.');
  }
  return url;
}
export function discussion(url: URL): boolean { return /\/(?:discussion(?:_topics|s)?|threads?|replies)(?:[/?#]|$)/i.test(url.pathname); }
export function quizPage(url: URL): boolean {
  return url.origin === CANVAS_ORIGIN ? /^\/courses\/[^/]+\/quizzes\/[^/]+(?:\/|$)/.test(url.pathname)
    : /^\/au\/courses\/[^/]+\/lessons\/[^/]+\/(?:attempt|slides?)(?:\/|$)/.test(url.pathname);
}
export function coursePage(url: URL): { platform: 'canvas' | 'ed'; externalId: string } | undefined {
  const platform = url.origin === CANVAS_ORIGIN ? 'canvas' : 'ed';
  const match = (platform === 'canvas' ? /^\/courses\/([^/]+)(?:\/|$)/ : /^\/au\/courses\/([^/]+)(?:\/|$)/).exec(url.pathname);
  return match ? { platform, externalId: match[1]! } : undefined;
}
