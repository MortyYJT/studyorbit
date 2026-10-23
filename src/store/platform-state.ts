import type { AssessmentLink, SourceItem } from '../domain/schemas.js';
import type { Repository } from './repository.js';

export interface PlatformState { linked: boolean; submitted: boolean; removed: boolean }

/** Latest link per source item wins; earlier links of a moved item no longer count. */
export function currentLinks(links: readonly AssessmentLink[]): Map<string, AssessmentLink> {
  return new Map(links.map(link => [link.sourceItemId, link]));
}

/** Platform facts of the items currently linked to one assessment; shared by the planner and reads. */
export function platformState(sources: readonly (SourceItem | undefined)[]): PlatformState {
  return { linked: sources.length > 0, submitted: sources.some(source => source?.facts?.submitted === true),
    removed: sources.some(source => source?.removed === true) };
}

export function linkedSources(store: Pick<Repository, 'loadSourceItem'>, links: Map<string, AssessmentLink>, assessmentId: string) {
  return [...links.values()].filter(link => link.assessmentId === assessmentId).map(link => store.loadSourceItem(link.sourceItemId));
}

export function assessmentPlatformState(store: Pick<Repository, 'listAssessmentLinks' | 'loadSourceItem'>, assessmentId: string): PlatformState {
  return platformState(linkedSources(store, currentLinks(store.listAssessmentLinks()), assessmentId));
}
