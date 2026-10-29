// The course sources of a setup (openspec change generic-adapters, design §1, decision #440): Canvas, Ed, then the
// institution's framework source when it has one. Source ids are the checkpoint keys and run-directory file names,
// so UniMelb keeps `canvas`, `ed` and `handbook`.
import { institutionById } from '../institutions/registry.mjs';
import { canvasSource } from './canvas/index.mjs';
import { DEFAULT_SOURCE_CONFIG, sourceConfigEnv } from './config.mjs';
import { edSource } from './ed/index.mjs';

/** The ordered sources for `settings` and `institution`. */
export function resolveSources(_settings, institution) {
  return [canvasSource, edSource, ...(institution.framework ? [institution.framework] : [])];
}

/** Source ids of jobs created before the ids were stored with the job: the three UniMelb sources of that time. */
export const LEGACY_SOURCE_IDS = Object.freeze(['canvas', 'ed', 'handbook']);

/**
 * The setup sync and discovery use: settings, institution, ordered sources and the context the sources build their
 * commands from (with the collector environment). Until the settings file arrives (PR 3) this is today's setup.
 */
export function resolveSourceSetup(settings = DEFAULT_SOURCE_CONFIG) {
  const institution = institutionById(settings.institution);
  return { settings, institution, sources: resolveSources(settings, institution), context: { settings, institution, env: sourceConfigEnv(settings) } };
}

export { canvasSource, edSource };
