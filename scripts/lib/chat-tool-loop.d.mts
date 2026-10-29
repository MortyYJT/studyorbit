import type { AnalysisConfig } from './llm-config.mjs';
import type { HistoryTurn, TokenCounts, ToolDefinition } from './llm-providers.mjs';
import type { ChatStep } from './chat-store.mjs';
export const TOOL_LOOP_LIMITS: Readonly<{ requests: number; calls: number; resultChars: number; result: number; args: number; preview: number }>;
export type StepEvent = { index: number; name: string; args: string; state: 'running' } | { index: number; state: 'done'; ok: boolean; preview: string };
export type ToolLoopResult = {
  ok: boolean; text: string; usage: TokenCounts | null; model: string | null; steps: ChatStep[]; reasoning: string;
  stopped?: true; error?: string; toolsRejected?: true;
};
export function rejectsTools(status: number, body: string): boolean;
export function runChatWithTools(
  config: AnalysisConfig,
  input: { system: string; history: HistoryTurn[]; tools: ToolDefinition[]; runTool: (name: string, args: unknown) => { ok: boolean; text: string } },
  options?: { signal?: AbortSignal; onDelta?: (text: string) => void; onStep?: (event: StepEvent) => void },
): Promise<ToolLoopResult>;
