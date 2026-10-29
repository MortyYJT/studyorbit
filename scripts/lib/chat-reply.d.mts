import type { AnalysisConfig } from './llm-config.mjs';
import type { ChatMessage } from './chat-store.mjs';
import type { StepEvent } from './chat-tool-loop.mjs';
import type { HistoryTurn, TokenCounts } from './llm-providers.mjs';
import type { CourseDocument, DisplayDocument } from '../../shared/course-data.js';
import type { SentPlanning } from '../../shared/planning-snapshot.js';
import type { Institution } from '../institutions/types.d.mts';
export const HISTORY_BUDGET: number;
export const REASONING_LIMIT: number;
export function chatMode(provider: string): 'tools' | 'context';
export function replyHistory(messages: Pick<ChatMessage, 'role' | 'content' | 'reasoning'>[], options: { reasoning: boolean }): HistoryTurn[];
export function runChatReply(
  input: {
    config: AnalysisConfig; messages: ChatMessage[]; documents: (CourseDocument | DisplayDocument)[];
    courses: { id: string; code?: string; name?: string }[]; scope: string[]; today: string; language: 'zh' | 'en'; planning: SentPlanning | null;
    /** Forces a mode (Q&A evaluation only); tool mode throws for Codex. */
    mode?: 'tools' | 'context';
    /** Wording of the institution (default the default institution). */
    institution?: Institution;
    /** Time zone of due dates (default the institution's). */
    timeZone?: string;
  },
  options?: { signal?: AbortSignal; onDelta?: (text: string) => void; onStep?: (event: StepEvent) => void; cwd?: string },
): Promise<{ ok: boolean; stopped?: true; error?: string; usage: TokenCounts | null; model: string | null; message: ChatMessage | null }>;
