import type { SentPlanning } from '../../shared/planning-snapshot.ts';

export const AGENT_CONTEXT_LIMIT: number;
export const FOCUS_MAX_AGE_MS: number;
export type AgentContextInput = { selectedCourseIds: string[]; focusCourseId: string | null; planning: SentPlanning | null };
export type AgentContext = AgentContextInput & { savedAt: string };
export function parseAgentContext(value: unknown): { ok: true; context: AgentContextInput } | { ok: false };
export function writeAgentContext(projectDir: string, context: AgentContextInput, now?: () => Date): Promise<AgentContext>;
export function readAgentContext(projectDir: string): Promise<AgentContext | null>;
