import { randomBytes, timingSafeEqual } from 'node:crypto';
export interface OwnerSession { accepts(value: string | undefined): boolean; browserUrl(origin: string): string; containsSecret(text: string): boolean }
/** This credential is held only by the host and the system browser. */
export function createOwnerSession(): OwnerSession {
  const secret = randomBytes(32).toString('hex');
  return Object.freeze({
    accepts(value: string | undefined): boolean {
      return value !== undefined && Buffer.byteLength(value) === 64 && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
    },
    containsSecret: (text: string) => text.includes(secret),
    browserUrl: (origin: string) => `${origin}/#s=${secret}`,
  });
}
