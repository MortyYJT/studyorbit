import type { Institution } from '../institutions/types.d.mts';

export function courseOutputSchema(): { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
export function buildAnalysisPrompt(input: { course: { id: string; subjectCode: string; name?: string; [key: string]: unknown }; term: string; canvas: unknown; ed: unknown; handbook?: unknown; institution?: Institution }): string;
