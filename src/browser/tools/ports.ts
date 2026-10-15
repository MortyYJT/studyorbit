import type { PendingConfirmation } from '../../domain/schemas.js';
import type { RequestClock } from '../../capture/limiter.js';
import type { SqliteRepository } from '../../store/sqlite.js';
import type { AssessmentAutonomy } from '../../protocol/autonomy.js';
import type { AuditEvent } from '../../protocol/context.js';
import type { AgentEvent } from '../../agent/adapter.js';
export interface PageTarget { ref: string; description: string; kind: string }
/** Projection of visible DOM only. Never includes input values or serialized HTML. */
export interface PageSnapshot { text: string; targets: PageTarget[]; people: string[]; peers: string[] }
export interface ToolPage {
  navigate(url: string): Promise<void>; url(): string; signedOut(): Promise<boolean>;
  read(): Promise<PageSnapshot>; front(): Promise<void>; highlight(ref: string): Promise<void>;
  isVisible(ref: string): Promise<boolean>; act(action: 'click' | 'fill' | 'select' | 'submit', ref: string, value?: string): Promise<void>;
  screenshot(): Promise<string>; close(): Promise<void>;
}
export interface ToolBrowser { newPage(tabId?: string): Promise<ToolPage>; focus?(tabId: string): Promise<void>; close(): Promise<void> }
export type BrowserStore = Pick<SqliteRepository, 'loadCourse' | 'loadAssessment' | 'readConversations'>;
export interface ToolScope { conversationId: string; emit(event: AgentEvent): void; isActive?(): boolean }
export interface ConfirmationStore { list(): PendingConfirmation[]; save(row: PendingConfirmation): void; transition?(id: string, state: 'confirmed' | 'cancelled' | 'expired'): PendingConfirmation | undefined }
export interface BrowserToolOptions {
  store: BrowserStore; autonomy: AssessmentAutonomy; audit: { record(event: AuditEvent): Promise<void> };
  browser: ToolBrowser; confirmations: ConfirmationStore; clock?: RequestClock; recoverOnStart?: boolean;
}
