// Ed regions (openspec change generic-adapters, design §3, decision #443): the API bases mirror the `edstem` CLI's
// own region table (edstem-cli `ED_REGIONS`, checked 2026-10-30). Lesson links use `https://edstem.org/<region>/...`;
// that pattern is verified for `au` only.
export const ED_API_BASES = Object.freeze({ au: 'https://edstem.org/api/', us: 'https://us.edstem.org/api/', eu: 'https://eu.edstem.org/api/' });
export const REGION_MISMATCH = 'Ed 登录区域与设置不一致';

export const isEdRegion = value => typeof value === 'string' && Object.hasOwn(ED_API_BASES, value);

/** The web link of an Ed lesson in `region`. */
export const edLessonUrl = (region, unit, lesson) => `https://edstem.org/${region}/courses/${unit}/lessons/${lesson}`;
