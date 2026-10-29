// Data-source settings (openspec change generic-adapters, design §8, decision #447): the owner's institution, Canvas
// address, browser, Ed region and, for the generic institution, time zone and course-code pattern, in
// `.local/config/sources.json` (file 0600, directory 0700), written atomically. A missing file means today's setup:
// the default institution and its Canvas, Edge through Apple Events on macOS (the CDP bridge elsewhere), Ed region
// `auto`. The settings are read once per sync and once per discovery and passed down; collectors never read the file.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { compileCodePattern, systemTimeZone } from '../institutions/generic.mjs';
import { DEFAULT_INSTITUTION, institutionFor, INSTITUTIONS } from '../institutions/registry.mjs';
import { canvasOrigin } from '../sources/config.mjs';
import { resolveSourceSetup } from '../sources/registry.mjs';

export const SOURCE_SETTINGS_VERSION = 1;
export const ED_REGIONS = Object.freeze(['auto', 'au', 'us', 'eu']);
/**
 * The browser bridges: where each is available and whether it is experimental. The CDP bridges (the server's
 * dedicated browser; meant for Windows and Linux, also usable on macOS) are experimental and not verified on Windows
 * or Linux (scripts/browser/cdp-host.mjs).
 */
export const BROWSERS = Object.freeze({
  'edge-applescript': Object.freeze({ label: Object.freeze({ zh: 'Microsoft Edge（macOS，Apple 事件）', en: 'Microsoft Edge (macOS, Apple Events)' }), platforms: Object.freeze(['darwin']), experimental: false, implemented: true }),
  'chrome-applescript': Object.freeze({ label: Object.freeze({ zh: 'Google Chrome（macOS，Apple 事件）', en: 'Google Chrome (macOS, Apple Events)' }), platforms: Object.freeze(['darwin']), experimental: false, implemented: true }),
  'cdp-chrome': Object.freeze({ label: Object.freeze({ zh: 'Google Chrome（专用浏览器）', en: 'Google Chrome (dedicated browser)' }), platforms: null, experimental: true, implemented: true }),
  'cdp-edge': Object.freeze({ label: Object.freeze({ zh: 'Microsoft Edge（专用浏览器）', en: 'Microsoft Edge (dedicated browser)' }), platforms: null, experimental: true, implemented: true }),
});
const FIELDS = ['version', 'institution', 'canvasOrigin', 'browser', 'browserPath', 'edRegion', 'timeZone', 'codePattern'];

export const sourceSettingsFile = projectDir => join(projectDir, '.local', 'config', 'sources.json');

/** A settings problem: `code` is the API error, `field` the offending field (null for the whole body or file). */
export class SourceSettingsError extends Error {
  constructor(code, field = null, reason = '') {
    super(reason || code);
    this.name = 'SourceSettingsError';
    this.code = code;
    this.field = field;
    this.reason = reason;
  }
}

export { systemTimeZone };

export const browserAvailable = (browser, platform) => Object.hasOwn(BROWSERS, browser) && (BROWSERS[browser].platforms === null || BROWSERS[browser].platforms.includes(platform));

/** The canonical name of a time zone `Intl.DateTimeFormat` accepts, or null. */
export function canonicalTimeZone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone; } catch { return null; }
}

/** The settings of a project without a settings file on `platform`. */
export function defaultSourceSettings(platform = process.platform) {
  return {
    version: SOURCE_SETTINGS_VERSION, institution: DEFAULT_INSTITUTION.id, canvasOrigin: null,
    browser: platform === 'darwin' ? 'edge-applescript' : 'cdp-chrome', browserPath: null, edRegion: 'auto', timeZone: null, codePattern: null,
  };
}

/**
 * Validates settings sent by the page or read from the file and returns them in stored form. Throws a
 * SourceSettingsError `INVALID_SOURCE_SETTINGS` naming the field. `isFile(path)` checks `browserPath` (skipped when
 * omitted); `now` decides nothing. A generic institution without a time zone gets the system's zone (design §4).
 */
export async function validateSourceSettings(input, { platform = process.platform, isFile } = {}) {
  const invalid = (field, reason) => new SourceSettingsError('INVALID_SOURCE_SETTINGS', field, reason);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(null, '设置必须是一个对象');
  const unknown = Object.keys(input).find(key => !FIELDS.includes(key));
  if (unknown) throw invalid(unknown, '未知字段');
  if (input.version !== undefined && input.version !== SOURCE_SETTINGS_VERSION) throw invalid('version', '版本不受支持');
  const { institution } = input;
  if (typeof institution !== 'string' || !Object.hasOwn(INSTITUTIONS, institution)) throw invalid('institution', '未知的学校');
  const generic = institution === 'generic';

  const { browser } = input;
  if (typeof browser !== 'string' || !Object.hasOwn(BROWSERS, browser)) throw invalid('browser', '未知的浏览器');
  if (!browserAvailable(browser, platform)) throw invalid('browser', '这个浏览器在当前系统上不可用');

  let origin = null;
  if (input.canvasOrigin !== undefined && input.canvasOrigin !== null && input.canvasOrigin !== '') {
    try { origin = canvasOrigin(input.canvasOrigin); } catch (error) { throw invalid('canvasOrigin', error.message); }
  }
  if (generic && origin === null) throw invalid('canvasOrigin', '请先在设置里填写 Canvas 地址');

  const edRegion = input.edRegion ?? 'auto';
  if (!ED_REGIONS.includes(edRegion)) throw invalid('edRegion', 'Ed 区域只能是 auto、au、us 或 eu');

  let timeZone = null;
  const timeZoneGiven = input.timeZone !== undefined && input.timeZone !== null && input.timeZone !== '';
  if (timeZoneGiven) {
    if (!generic) throw invalid('timeZone', '这个学校使用固定时区');
    timeZone = canonicalTimeZone(input.timeZone);
    if (!timeZone) throw invalid('timeZone', '无法识别的时区');
  } else if (generic) timeZone = systemTimeZone();

  let codePattern = null;
  if (input.codePattern !== undefined && input.codePattern !== null && input.codePattern !== '') {
    if (!generic) throw invalid('codePattern', '这个学校使用固定的课程代码规则');
    const compiled = compileCodePattern(input.codePattern);
    if (!compiled.ok) throw invalid('codePattern', compiled.reason);
    codePattern = input.codePattern;
  }

  let browserPath = null;
  if (input.browserPath !== undefined && input.browserPath !== null && input.browserPath !== '') {
    if (!browser.startsWith('cdp-')) throw invalid('browserPath', '只有专用浏览器可以指定程序路径');
    if (typeof input.browserPath !== 'string' || input.browserPath.length > 1000 || !isAbsolute(input.browserPath)) throw invalid('browserPath', '程序路径必须是绝对路径');
    if (isFile && !(await isFile(input.browserPath))) throw invalid('browserPath', '找不到这个程序文件');
    browserPath = input.browserPath;
  }
  return { version: SOURCE_SETTINGS_VERSION, institution, canvasOrigin: origin, browser, browserPath, edRegion, timeZone, codePattern };
}

/** Whether `path` is an existing regular file. */
export async function isExistingFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/**
 * The stored settings and whether the file exists. A missing file gives the defaults; a file that cannot be read or
 * does not validate throws `SOURCE_SETTINGS_UNREADABLE`, so a sync never runs on settings the owner did not choose.
 */
export async function loadSourceSettings(projectDir, { platform = process.platform } = {}) {
  let text;
  try { text = await readFile(sourceSettingsFile(projectDir), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { settings: defaultSourceSettings(platform), saved: false };
    throw new SourceSettingsError('SOURCE_SETTINGS_UNREADABLE');
  }
  try {
    return { settings: await validateSourceSettings(JSON.parse(text), { platform }), saved: true };
  } catch { throw new SourceSettingsError('SOURCE_SETTINGS_UNREADABLE'); }
}

/** Validates `input` and writes it atomically (0600 in a 0700 directory). Returns the stored settings. */
export async function saveSourceSettings(projectDir, input, { platform = process.platform, isFile = isExistingFile, beforeWrite } = {}) {
  const settings = await validateSourceSettings(input, { platform, isFile });
  const file = sourceSettingsFile(projectDir);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // Last chance to refuse (a sync started meanwhile); the file is unchanged when this throws.
    beforeWrite?.();
    await rename(temp, file);
  } catch (error) { await rm(temp, { force: true }); throw error; }
  return settings;
}

/**
 * The settings in effect: the institution's Canvas origin when none is stored, and the time zone (stored, else the
 * institution's, else the system's).
 */
export function effectiveSourceSettings(settings) {
  const institution = institutionFor(settings);
  return {
    ...settings,
    canvasOrigin: settings.canvasOrigin ?? institution.defaults.canvasOrigin,
    timeZone: settings.timeZone ?? institution.defaults.timeZone ?? systemTimeZone(),
  };
}

/** What the page may choose on `platform`. */
export function availableChoices(platform = process.platform) {
  return {
    institutions: Object.values(INSTITUTIONS).map(institution => ({ id: institution.id, label: institution.label, defaultCanvasOrigin: institution.defaults.canvasOrigin, fixedTimeZone: institution.defaults.timeZone, frameworkLabel: institution.framework?.label ?? null })),
    browsers: Object.entries(BROWSERS).map(([id, browser]) => ({ id, label: browser.label, experimental: browser.experimental, implemented: browser.implemented, available: browserAvailable(id, platform) })),
    edRegions: [...ED_REGIONS],
  };
}

/** The setup of the project's settings (scripts/sources/registry.mjs `resolveSourceSetup`), read now. */
export async function loadSourceSetup(projectDir, { platform = process.platform } = {}) {
  const { settings } = await loadSourceSettings(projectDir, { platform });
  return resolveSourceSetup(effectiveSourceSettings(settings));
}
