// The course sources of a setup (openspec change generic-adapters, design §1, decision #440): Canvas, Ed, then the
// institution's framework source when it has one. Source ids are the checkpoint keys and run-directory file names,
// so the default institution keeps `canvas`, `ed` and `handbook`.
import { institutionFor } from '../institutions/registry.mjs';
import { systemTimeZone } from '../institutions/generic.mjs';
import { canvasSource } from './canvas/index.mjs';
import { collectorConfig, DEFAULT_SOURCE_CONFIG, sourceConfigEnv } from './config.mjs';
import { edSource } from './ed/index.mjs';

/** The ordered sources for `settings` and `institution`. */
export function resolveSources(_settings, institution) {
  return [canvasSource, edSource, ...(institution.framework ? [institution.framework] : [])];
}

/** Source ids of jobs created before the ids were stored with the job: the three sources of the default institution then. */
export const LEGACY_SOURCE_IDS = Object.freeze(['canvas', 'ed', 'handbook']);

/**
 * The setup sync and discovery use, from effective source settings (scripts/lib/source-settings.mjs; default today's
 * setup): the institution (configured), ordered sources, the time zone, and the context the sources build their
 * commands from, with the collector configuration and its environment.
 */
export function resolveSourceSetup(settings = DEFAULT_SOURCE_CONFIG) {
  const institution = institutionFor(settings);
  const config = collectorConfig({ ...settings, canvasOrigin: settings.canvasOrigin ?? institution.defaults.canvasOrigin });
  const timeZone = settings.timeZone ?? institution.defaults.timeZone ?? systemTimeZone();
  return { settings: config, institution, timeZone, sources: resolveSources(settings, institution), context: { settings: config, institution, env: sourceConfigEnv(config) } };
}

export { canvasSource, edSource };
