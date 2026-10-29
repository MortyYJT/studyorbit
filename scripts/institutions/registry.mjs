// Institution plugins by id (openspec change generic-adapters, design §4, decision #441). Only `unimelb` until the
// `generic` plugin arrives with the settings (PR 3).
import { unimelb } from './unimelb/index.mjs';

export const INSTITUTIONS = Object.freeze({ unimelb });
export const DEFAULT_INSTITUTION = unimelb;

export function institutionById(id) {
  if (!Object.hasOwn(INSTITUTIONS, id)) throw new Error(`未知的学校：${String(id)}`);
  return INSTITUTIONS[id];
}
