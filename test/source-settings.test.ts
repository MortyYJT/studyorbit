// Source settings and the generic institution (openspec change generic-adapters, design §4 and §8, decisions #441 and
// #447). Synthetic data only: temporary project directories, invented Canvas addresses and course codes.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileCodePattern, createGenericInstitution, folderSegment, generic } from '../scripts/institutions/generic.mjs';
import { DEFAULT_INSTITUTION, institutionById, institutionFor } from '../scripts/institutions/registry.mjs';
import {
  availableChoices, defaultSourceSettings, effectiveSourceSettings, loadSourceSettings, loadSourceSetup, saveSourceSettings, SourceSettingsError,
  sourceSettingsFile, systemTimeZone, validateSourceSettings,
} from '../scripts/lib/source-settings.mjs';
import { filterSubjects } from '../scripts/lib/course-list.mjs';
import { DEFAULT_SOURCE_CONFIG, SOURCE_CONFIG_ENV } from '../scripts/sources/config.mjs';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'studyorbit-settings-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const GENERIC = { institution: 'generic', canvasOrigin: 'https://canvas.example.edu', browser: 'edge-applescript', edRegion: 'auto', timeZone: 'America/New_York', codePattern: null };
const invalidField = async (input: unknown, platform = 'darwin', isFile?: (path: string) => Promise<boolean>) => {
  try { await validateSourceSettings(input, { platform, ...(isFile ? { isFile } : {}) }); } catch (error) {
    expect(error).toBeInstanceOf(SourceSettingsError);
    expect((error as SourceSettingsError).code).toBe('INVALID_SOURCE_SETTINGS');
    return (error as SourceSettingsError).field;
  }
  return 'accepted';
};

describe('source settings: defaults and file', () => {
  it('without a file: the default institution, its Canvas, Edge on macOS and the CDP bridge elsewhere, Ed auto', async () => {
    expect(await loadSourceSettings(root, { platform: 'darwin' })).toEqual({ saved: false, settings: {
      version: 1, institution: DEFAULT_INSTITUTION.id, canvasOrigin: null, browser: 'edge-applescript', browserPath: null, edRegion: 'auto', timeZone: null, codePattern: null,
    } });
    expect(defaultSourceSettings('linux').browser).toBe('cdp-chrome');
    expect(defaultSourceSettings('win32').browser).toBe('cdp-chrome');
    const effective = effectiveSourceSettings(defaultSourceSettings('darwin'));
    expect(effective.canvasOrigin).toBe(DEFAULT_INSTITUTION.defaults.canvasOrigin);
    expect(effective.timeZone).toBe(DEFAULT_INSTITUTION.defaults.timeZone);
    // The setup without a file equals today's collector configuration on macOS.
    const setup = await loadSourceSetup(root, { platform: 'darwin' });
    expect(setup.settings).toEqual(DEFAULT_SOURCE_CONFIG);
    expect(JSON.parse(setup.context.env[SOURCE_CONFIG_ENV]!)).toEqual(DEFAULT_SOURCE_CONFIG);
    expect(setup.sources.map(source => source.id)).toEqual(['canvas', 'ed', 'handbook']);
    expect(setup.timeZone).toBe(DEFAULT_INSTITUTION.defaults.timeZone);
  });

  it('writes atomically, owner-only, and reads back what it wrote', async () => {
    const saved = await saveSourceSettings(root, GENERIC, { platform: 'darwin' });
    const file = sourceSettingsFile(root);
    expect(file).toBe(join(root, '.local', 'config', 'sources.json'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, '.local', 'config'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(root, '.local', 'config'))).toEqual(['sources.json']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, ...GENERIC, browserPath: null });
    expect(await loadSourceSettings(root, { platform: 'darwin' })).toEqual({ saved: true, settings: saved });
    const setup = await loadSourceSetup(root, { platform: 'darwin' });
    expect([setup.institution.id, setup.timeZone, setup.sources.map(source => source.id)]).toEqual(['generic', 'America/New_York', ['canvas', 'ed']]);
  });

  it('leaves the file unchanged when the last check before the rename refuses', async () => {
    await saveSourceSettings(root, GENERIC, { platform: 'darwin' });
    const before = await readFile(sourceSettingsFile(root), 'utf8');
    await expect(saveSourceSettings(root, { ...GENERIC, edRegion: 'us' }, { platform: 'darwin', beforeWrite: () => { throw new SourceSettingsError('SYNC_RUNNING'); } }))
      .rejects.toMatchObject({ code: 'SYNC_RUNNING' });
    expect(await readFile(sourceSettingsFile(root), 'utf8')).toBe(before);
    expect(await readdir(join(root, '.local', 'config'))).toEqual(['sources.json']);
  });

  it('refuses to use a file it cannot read or that does not validate', async () => {
    await mkdir(join(root, '.local', 'config'), { recursive: true });
    for (const text of ['{not json', JSON.stringify({ ...GENERIC, canvasOrigin: 'http://canvas.example.edu' }), JSON.stringify({ ...GENERIC, browser: 'chrome-applescript' })]) {
      await writeFile(sourceSettingsFile(root), text);
      await expect(loadSourceSettings(root, { platform: 'linux' })).rejects.toMatchObject({ code: 'SOURCE_SETTINGS_UNREADABLE' });
    }
  });

  it('fills the time zone of a generic institution with the system zone when it is saved without one', async () => {
    const saved = await saveSourceSettings(root, { ...GENERIC, timeZone: null }, { platform: 'darwin' });
    expect(saved.timeZone).toBe(systemTimeZone());
    expect((await validateSourceSettings({ ...GENERIC, timeZone: ' Europe/Berlin ' }, { platform: 'darwin' })).timeZone).toBe('Europe/Berlin');
  });
});

describe('source settings: validation', () => {
  it('names the field of every rule', async () => {
    expect(await invalidField(null)).toBeNull();
    expect(await invalidField({ ...GENERIC, token: 'x' })).toBe('token');
    expect(await invalidField({ ...GENERIC, version: 2 })).toBe('version');
    expect(await invalidField({ ...GENERIC, institution: 'elsewhere' })).toBe('institution');
    expect(await invalidField({ ...GENERIC, browser: 'safari' })).toBe('browser');
    expect(await invalidField({ ...GENERIC, canvasOrigin: 'http://canvas.example.edu' })).toBe('canvasOrigin');
    expect(await invalidField({ ...GENERIC, canvasOrigin: 'https://canvas.example.edu/login' })).toBe('canvasOrigin');
    expect(await invalidField({ ...GENERIC, canvasOrigin: 'https://10.1.2.3' })).toBe('canvasOrigin');
    expect(await invalidField({ ...GENERIC, canvasOrigin: null })).toBe('canvasOrigin');
    expect(await invalidField({ ...GENERIC, edRegion: 'asia' })).toBe('edRegion');
    expect(await invalidField({ ...GENERIC, timeZone: 'Mars/Olympus' })).toBe('timeZone');
    expect(await invalidField({ ...GENERIC, codePattern: '[A-Z]+\\d+' })).toBe('codePattern');
    expect(await invalidField({ ...GENERIC, codePattern: '(a)(b)' })).toBe('codePattern');
    expect(await invalidField({ ...GENERIC, codePattern: '([' })).toBe('codePattern');
    expect(await invalidField({ ...GENERIC, codePattern: `(${'a'.repeat(199)})` })).toBe('codePattern');
    expect(await invalidField({ ...GENERIC, codePattern: '^([A-Z]+\\d+)' })).toBe('accepted');
  });

  it('keeps the default institution fixed: no time zone, no code pattern; its Canvas may be left empty', async () => {
    const fixed = { institution: DEFAULT_INSTITUTION.id, canvasOrigin: null, browser: 'edge-applescript' };
    expect(await invalidField({ ...fixed, timeZone: 'America/New_York' })).toBe('timeZone');
    expect(await invalidField({ ...fixed, codePattern: '^(X)' })).toBe('codePattern');
    expect(await validateSourceSettings(fixed, { platform: 'darwin' })).toEqual({ ...defaultSourceSettings('darwin') });
  });

  it('offers AppleScript browsers on macOS only and checks the CDP browser path', async () => {
    expect(await invalidField({ ...GENERIC, browser: 'edge-applescript' }, 'linux')).toBe('browser');
    expect(await invalidField({ ...GENERIC, browser: 'chrome-applescript' }, 'win32')).toBe('browser');
    expect(await invalidField({ ...GENERIC, browser: 'cdp-edge' }, 'win32')).toBe('accepted');
    expect(await invalidField({ ...GENERIC, browserPath: '/Applications/Edge' })).toBe('browserPath');
    expect(await invalidField({ ...GENERIC, browser: 'cdp-chrome', browserPath: 'chrome' }, 'linux')).toBe('browserPath');
    const exists = (found: boolean) => async () => found;
    expect(await invalidField({ ...GENERIC, browser: 'cdp-chrome', browserPath: '/opt/chrome/chrome' }, 'linux', exists(false))).toBe('browserPath');
    expect(await invalidField({ ...GENERIC, browser: 'cdp-chrome', browserPath: '/opt/chrome/chrome' }, 'linux', exists(true))).toBe('accepted');
    const choices = availableChoices('linux');
    expect(choices.browsers.map(browser => [browser.id, browser.available, browser.experimental])).toEqual([
      ['edge-applescript', false, false], ['chrome-applescript', false, false], ['cdp-chrome', true, true], ['cdp-edge', true, true],
    ]);
    expect(choices.institutions.map(item => item.id)).toEqual([DEFAULT_INSTITUTION.id, 'generic']);
    expect(choices.edRegions).toEqual(['auto', 'au', 'us', 'eu']);
  });
});

describe('the generic institution', () => {
  it('takes a safe course code by default and the capture group of the owner pattern', () => {
    expect(generic.subjectCode(' CS101 ')).toBe('CS101');
    expect(generic.subjectCode('Intro to CS: Section 1')).toBeNull();
    expect(generic.subjectCode(null)).toBeNull();
    expect(generic.subjectCode('')).toBeNull();
    expect(generic.subjectCode('x'.repeat(51))).toBeNull();
    const custom = createGenericInstitution({ codePattern: '^([A-Z]+/\\d+) ' });
    expect(custom.subjectCode('CS/101 Fall')).toBe('CS/101');
    expect(custom.subjectCode('Community')).toBeNull();
    expect(custom.subjectCode(`CS/101 ${'x'.repeat(100)}`)).toBeNull();
    // A captured code the sync would refuse is never a candidate (fresh-context review of PR 3).
    expect(createGenericInstitution({ codePattern: '^(.+)$' }).subjectCode('AB\u0007C')).toBeNull();
    expect(filterSubjects([{ id: '1', code: 'CS101' }, { id: '2', code: null }, { id: '3' }], generic)).toEqual([{ id: '1', code: 'CS101', subjectCode: 'CS101' }]);
    expect(generic.isSubjectCode('CS/101')).toBe(true);
    expect(generic.isSubjectCode(' CS101')).toBe(false);
    expect(generic.isSubjectCode('A\nB')).toBe(false);
    expect(compileCodePattern('(a)|(b)')).toMatchObject({ ok: false });
    expect(() => createGenericInstitution({ codePattern: 'no group' })).toThrow();
  });

  it('reads the year of a term without a session and matches Ed by code and year', () => {
    expect(generic.termKey('Fall 2026')).toEqual({ year: '2026', session: null });
    expect(generic.termKey('Default Term')).toEqual({ year: null, session: null });
    expect(generic.edSessionMatches('Semester 2', generic.termKey('Fall 2026'))).toBe(true);
  });

  it('builds safe Desktop folders: StudyOrbit <term>/<code>', () => {
    expect(generic.courseFolder({ term: 'Fall 2026', subjectCode: 'CS/101' })).toEqual(['StudyOrbit Fall 2026', 'CS_101']);
    expect(generic.courseFolder({ term: null, subjectCode: 'CON' })).toEqual(['StudyOrbit Unknown term', '_CON']);
    expect(generic.courseFolder({ term: '2026 秋季', subjectCode: 'cs101' })).toEqual(['StudyOrbit 2026', 'cs101']);
    expect(folderSegment('.')).toBe('_');
    expect(folderSegment('..')).toBe('_');
    expect(folderSegment('CS101. ')).toBe('CS101');
    expect(folderSegment('lpt1.txt')).toBe('_lpt1.txt');
    expect(folderSegment('a\\b:c*d?"e<f>g|h')).toBe('a_b_c_d__e_f_g_h');
    expect(folderSegment('')).toBe('_');
  });

  it('uses the configured time zone, neutral wording and no framework source', () => {
    const configured = institutionFor({ institution: 'generic', timeZone: 'America/New_York', codePattern: null });
    expect(configured.defaults).toEqual({ canvasOrigin: null, timeZone: 'America/New_York' });
    expect(configured.framework).toBeNull();
    const text = JSON.stringify(configured.wording);
    for (const word of ['Melbourne', '墨尔本', 'Handbook']) expect(text).not.toContain(word);
    expect(configured.wording.timeLabel).toEqual({ zh: '本地时间', en: 'local' });
    expect(institutionById('generic')).toBe(generic);
    expect(institutionFor(null)).toBe(DEFAULT_INSTITUTION);
  });
});
