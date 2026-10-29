import type { Institution } from './types.d.mts';

export const INSTITUTIONS: Readonly<Record<string, Institution>>;
export const DEFAULT_INSTITUTION: Institution;
export function institutionById(id: string): Institution;
