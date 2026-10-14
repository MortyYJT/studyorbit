import { scopeHash } from './ed-adapter.js';
import type { Course } from '../domain/schemas.js';
export interface ProviderCourse { provider: 'canvas' | 'ed'; externalId: string; rawCode: string; name: string; term: string }
export function normalizeCourseCode(value: string): string | undefined {
  const matches = [...value.matchAll(/(?<![A-Z0-9])[A-Z]{4}\d{5}(?!\d)/g)];
  return matches.length === 1 ? matches[0]![0] : undefined;
}
/** Duplicate codes on either provider disable merging for the entire term/code bucket. */
export function mergeCourses(input: ProviderCourse[], previous: readonly Course[] = []): { courses: Course[]; ambiguities: string[] } {
  const buckets = new Map<string, ProviderCourse[]>(); const ambiguities: string[] = [];
  for (const row of input) {
    const code = normalizeCourseCode(row.rawCode);
    const key = code ? `${row.term}:${code}` : `${row.provider}:${row.externalId}:${row.term}`;
    buckets.set(key, [...buckets.get(key) ?? [], row]);
  }
  const courses: Course[] = [];
  for (const rows of buckets.values()) {
    const ambiguous = !normalizeCourseCode(rows[0]!.rawCode) || ['canvas', 'ed'].some(p => rows.filter(r => r.provider === p).length > 1);
    for (const group of ambiguous ? rows.map(r => [r]) : [rows]) {
      const first = group.find(r => r.provider === 'canvas') ?? group[0]!;
      // A persisted course follows its anchor source when a merged bucket splits.
      const candidates = previous.filter(c => {
        const anchor = c.sources?.find(s => s.platform === 'canvas') ?? c.sources?.[0];
        return c.term === first.term && anchor && group.some(r => r.provider === anchor.platform && r.externalId === anchor.externalId);
      });
      const retained = candidates.find(c => c.sources?.some(s => s.platform === first.provider && s.externalId === first.externalId)) ?? candidates[0];
      const identity = `${first.provider}:${first.externalId}:${first.term}`;
      const candidate = `course:${scopeHash(identity)}`;
      // An Ed-anchored historical ID may now belong to the Canvas anchor after merging.
      const id = retained?.id ?? (previous.some(c => c.id === candidate) ? `course:${scopeHash(`${identity}:split`)}` : candidate);
      if (ambiguous) ambiguities.push(id);
      courses.push({ id, moduleId: 'school', code: normalizeCourseCode(first.rawCode) ?? '', name: first.name,
        term: first.term, assessmentsComplete: false, sources: group.map(r => ({ platform: r.provider, externalId: r.externalId })) });
    }
  }
  return { courses, ambiguities };
}
