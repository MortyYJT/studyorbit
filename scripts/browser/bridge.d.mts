export type ReadKind = 'same-origin-json' | 'body-text' | 'navigation-status';
export type TabHandle = string[];
export type PageState = 'loading' | 'ready' | 'redirect' | (string & {});
/** The narrow browser bridge (design §5): no operation accepts JavaScript text. */
export interface BrowserBridge {
  id: string;
  open(url: string, expectedPrefix: string): Promise<TabHandle>;
  state(tab: TabHandle, expectedPrefix: string): Promise<PageState>;
  read(tab: TabHandle, expectedPrefix: string, kind: ReadKind): Promise<string>;
  close(tab: TabHandle): Promise<void>;
  dispose(): Promise<void>;
}
export const READ_EXPRESSIONS: Readonly<Record<ReadKind, string>>;
export const READ_KINDS: readonly ReadKind[];
export const LOAD_LIMIT_MS: number;
export const POLL_MS: number;
export const READ_RETRY_MS: number;
export function assertAllowedUrl(url: string, allowedOrigins: readonly string[]): URL;
export function markedUrl(url: string, uuid?: string): string;
export function assertReadKind(kind: unknown): ReadKind;
export class TabUnrecognisedError extends Error {}
export type PageOptions<T> = {
  accept(text: string): T;
  messages: { identity: string; redirect: string; timeout: string };
  isAborted?(): boolean;
  onUnread?(tab: TabHandle, error: unknown): Promise<void> | void;
  onCloseError?(): void;
  closeFailureFails?: boolean;
  sleep?(ms: number): Promise<void>;
  now?(): number;
};
export function withPage<T>(bridge: BrowserBridge, url: string, expectedPrefix: string, kind: ReadKind, options: PageOptions<T>): Promise<T>;
