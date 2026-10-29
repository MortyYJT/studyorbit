import type { TokenCounts } from './llm-providers.mjs';
export type ChatStep = { name: string; args: string; ok: boolean; result: string; ms: number };
export type ChatMessage = {
  role: 'user' | 'assistant'; content: string; at: string; usage?: TokenCounts | null; model?: string | null; status?: 'stopped' | 'error';
  mode?: 'tools' | 'context'; fallback?: true; steps?: ChatStep[]; reasoning?: string;
};
export type Chat = { id: string; title: string; createdAt: string; updatedAt: string; courseIds: string[]; messages: ChatMessage[] };
export type ChatSummary = Omit<Chat, 'messages'> & { messageCount: number };
export function isChatId(value: unknown): value is string;
export function titleFrom(content: string): string;
export function createChat(projectDir: string, input?: { courseIds?: unknown; title?: unknown }): Promise<Chat>;
export function readChat(projectDir: string, id: string): Promise<Chat | null>;
export function listChats(projectDir: string): Promise<ChatSummary[]>;
export function deleteChat(projectDir: string, id: string): Promise<boolean>;
export function appendMessages(projectDir: string, id: string, messages: ChatMessage[], options?: { courseIds?: string[] }): Promise<Chat | null>;
