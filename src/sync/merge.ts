import { scopeHash } from './ed-adapter.js';
import type { Course } from '../domain/schemas.js';
export interface ProviderCourse { provider: 'canvas' | 'ed'; externalId: string; rawCode: string; name: string; term: string }
export function normalizeCourseCode(value: string): string | undefined {
  const matches = [...value.matchAll(/(?<![A-Z0-9])[A-Z]{4}\d{5}(?!\d)/g)];
  return matches.length === 1 ? matches[0]![0] : undefined;
}
/** Duplicate codes on either provider disable merging for the entire term/code bucket. */
export function mergeCourses(input: ProviderCourse[]): { courses: Course[]; ambiguities: string[] } {
  const buckets = new Map<string, ProviderCourse[]>(); const ambiguities: string[] = [];
  for (const row of input) {
    const code = normalizeCourseCode(row.rawCode);
    const key = code ? `${row.term}:${code}` : `${row.provider}:${row.externalId}:${row.term}`;
    buckets.set(key, [...buckets.get(key) ?? [], row]);
  }
  const courses: Course[] = [];
  for (const [key, rows] of buckets) {
    const ambiguous = !normalizeCourseCode(rows[0]!.rawCode) || ['canvas', 'ed'].some(p => rows.filter(r => r.provider === p).length > 1);
    for (const group of ambiguous ? rows.map(r => [r]) : [rows]) {
      const first = group.find(r => r.provider === 'canvas') ?? group[0]!;
      const identity = ambiguous ? `${first.provider}:${first.externalId}:${first.term}` : key;
      const id = `course:${scopeHash(identity)}`;
      if (ambiguous) ambiguities.push(id);
      courses.push({ id, moduleId: 'school', code: normalizeCourseCode(first.rawCode) ?? '', name: first.name,
        term: first.term, assessmentsComplete: false, sources: group.map(r => ({ platform: r.provider, externalId: r.externalId })) });
    }
  }
  return { courses, ambiguities };
}
