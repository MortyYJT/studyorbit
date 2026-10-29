import type { Institution } from './types.d.mts';

export const DEFAULT_CODE: RegExp;
export const CODE_INPUT_LIMIT: number;
export function systemTimeZone(): string;
export function folderSegment(value: unknown): string;
export function compileCodePattern(pattern: unknown): { ok: true; regex: RegExp } | { ok: false; reason: string };
export function createGenericInstitution(options?: { codePattern?: string | null; timeZone?: string | null }): Institution;
export const generic: Institution;
