import { z } from 'zod';
import type { Message } from '../domain/schemas.js';

/**
 * SDK-independent events. Tool metadata stays inside the existing message output part. `screenshotRef` and `viewUrl`
 * stay optional for historical resident-browser steps; stored confirmation events and parts remain readable as JSON.
 */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_step'), tool: z.string().min(1), outcome: z.enum(['ok', 'error', 'denied', 'waiting']),
    input: z.json().optional(), output: z.json().optional(), screenshotRef: z.string().optional(), viewUrl: z.string().optional() }),
  z.object({ type: z.literal('result'), turns: z.number().int().nonnegative(), costUsd: z.number().nonnegative().optional(), sessionRef: z.string().min(1).optional() }),
  z.object({ type: z.literal('error'), code: z.enum(['AGENT_UNAVAILABLE', 'INTERNAL']), message: z.string(),
    turns: z.number().int().nonnegative().optional(), costUsd: z.number().nonnegative().optional() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type StreamEvent = AgentEvent | { type: 'stopped' };
export interface StoredEvent { id: string; messageId: string; event: StreamEvent }
/** recordsSteps delegates journaling to the tool service, including waiting and safe error steps. */
export interface AgentTool { recordsSteps?: boolean; name: string; description: string; inputSchema: unknown; execute(input: unknown, scope?: { conversationId: string; emit(event: AgentEvent): void; isActive(): boolean }): Promise<unknown> }
export interface AgentInput {
  /** Absent for background jobs that have no stored conversation. */
  conversationId?: string; brief?: string;
  prompt: string; sessionRef?: string; transcript: readonly Message[]; tools: readonly AgentTool[];
  courseId?: string; assessmentId?: string; preset?: string;
}
export interface AgentRun extends AsyncIterable<AgentEvent> { interrupt(): void | Promise<void> }
export interface AgentAdapter { readonly id: string; start(input: AgentInput): AgentRun }

/** Explicit fallback for hosts without an available agent, including tests. */
export const unavailableAdapter: AgentAdapter = {
  id: 'claude',
  start: () => ({
    async *[Symbol.asyncIterator]() { yield { type: 'error', code: 'AGENT_UNAVAILABLE', message: 'Sign in to the installed agent and retry.' } as const; },
    interrupt() {},
  }),
};
