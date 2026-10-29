import type { Institution, InstitutionId } from './types.d.mts';

export const INSTITUTIONS: Readonly<Record<InstitutionId, Institution>>;
export const DEFAULT_INSTITUTION: Institution;
export function institutionById(id: string): Institution;
export function institutionFor(settings: { institution?: string; codePattern?: string | null; timeZone?: string | null } | null | undefined): Institution;
