// Institution plugins by id (openspec change generic-adapters, design §4, decision #441): `unimelb`, today's behaviour
// and the default, and `generic`, any Canvas. The generic plugin is configured by the owner's settings.
import { createGenericInstitution, generic } from './generic.mjs';
import { unimelb } from './unimelb/index.mjs';

export const INSTITUTIONS = Object.freeze({ unimelb, generic });
export const DEFAULT_INSTITUTION = unimelb;

/** The plugin of `id`, unconfigured (collectors use it this way: they need only codes, terms and the framework). */
export function institutionById(id) {
  if (!Object.hasOwn(INSTITUTIONS, id)) throw new Error(`未知的学校：${String(id)}`);
  return INSTITUTIONS[id];
}

/** The plugin of the settings, with the generic plugin's code pattern and time zone applied. */
export function institutionFor(settings) {
  const institution = institutionById(settings?.institution ?? DEFAULT_INSTITUTION.id);
  return institution.id === 'generic' ? createGenericInstitution({ codePattern: settings.codePattern ?? null, timeZone: settings.timeZone ?? null }) : institution;
}
