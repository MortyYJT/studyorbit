import type { CanvasTab, TabsStage } from './canvas-api.js';
import { CANVAS_ORIGIN } from './course-json.js';

/**
 * Page routing from a Canvas `tabs` capture (layered-sync task 4.2, #195, decision #201).
 *
 * Pure functions only: no clipboard, no network and no agent calls. A job builder asks for the URLs its
 * route allows; the guarantee is that no job is ever handed a URL whose tab route forbids it. Prompts say
 * "open no other page" as well (task 5.2), but this table is the enforcement point.
 */

export type TabRoute = 'read' | 'save' | 'link' | 'on-home-link' | 'never';

export interface RoutedTab { id: string; label: string; url?: string; route: TabRoute }

/** Per-tab routes plus the tabs routed `never` only because the fixed table does not know them. */
export interface TabRouting { tabs: RoutedTab[]; unknown: RoutedTab[] }

/** A `course.map` link: the label and URL the main job reported from the course home page. */
export interface HomeLink { label: string; url: string }

/** The URLs a job may be given, grouped by the route that permits them. */
export interface AllowedUrls { read: string[]; save: string[]; link: string[] }

/**
 * Canvas built-in tab ids. `syllabus` is the one id whose route depends on its URL, so it is handled
 * separately in `routeForTab`.
 */
const BUILTIN_ROUTES = new Map<string, TabRoute>([
  ['home', 'read'],
  ['assignments', 'read'],
  ['quizzes', 'read'],
  ['grades', 'read'],
  ['modules', 'save'],
  ['pages', 'on-home-link'],
  ['files', 'on-home-link'],
  ['announcements', 'never'],
  ['discussions', 'never'],
  ['people', 'never'],
  ['outcomes', 'never'],
  ['collaborations', 'never'],
  ['syllabus', 'on-home-link'],
]);

/**
 * External tools are matched by label, case-insensitively, as the whole label or a clear prefix
 * ("Gradescope (UoM)"). The prefix must end at a non-alphanumeric character, so "Zoomer" is not Zoom.
 */
const EXTERNAL_TOOLS: ReadonlyArray<readonly [name: string, route: TabRoute]> = [
  ['lecture capture', 'link'],
  ['gradescope', 'never'],
  ['echo360', 'never'],
  ['zoom', 'never'],
  ['office 365', 'never'],
  ['google drive', 'never'],
  ['readings online', 'never'],
  // Ed is read through `edstem-cli` or the Ed job (task 7.2), never through a Canvas job.
  ['ed discussion', 'never'],
];

const EXTERNAL_TOOL_ID = /^context_external_tool_\d+$/;

function toolRoute(label: string): TabRoute | undefined {
  const normal = label.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [name, route] of EXTERNAL_TOOLS) {
    if (normal === name) return route;
    if (normal.startsWith(name) && !/[a-z0-9]/.test(normal[name.length] ?? '')) return route;
  }
  return undefined;
}

function leavesCanvas(url: string | undefined): boolean {
  if (!url) return false;
  try { return new URL(url).origin !== CANVAS_ORIGIN; } catch { return false; }
}

/**
 * The spec names only the Ed case. We read it as the general rule: a syllabus URL outside Canvas is a
 * `link` (a job may record it); a Canvas syllabus is `on-home-link`. `allowedUrls` still unlocks only
 * Pages and Files home links, so a Canvas syllabus URL is not added to `allowed` by itself.
 */
function syllabusRoute(url: string | undefined): TabRoute {
  return leavesCanvas(url) ? 'link' : 'on-home-link';
}

function routeForTab(tab: CanvasTab): { route: TabRoute; known: boolean } {
  const builtin = BUILTIN_ROUTES.get(tab.id);
  if (builtin) return { route: tab.id === 'syllabus' ? syllabusRoute(tab.url) : builtin, known: true };
  if (EXTERNAL_TOOL_ID.test(tab.id)) {
    const route = toolRoute(tab.label);
    if (route) return { route, known: true };
  }
  return { route: 'never', known: false };
}

/** Route every tab from the fixed table; tabs the table does not know are `never` and listed. */
export function routeTabs(stage: TabsStage): TabRouting {
  const tabs: RoutedTab[] = [];
  const unknown: RoutedTab[] = [];
  for (const tab of stage.tabs) {
    const { route, known } = routeForTab(tab);
    const routed: RoutedTab = { id: tab.id, label: tab.label, ...(tab.url ? { url: tab.url } : {}), route };
    tabs.push(routed);
    if (!known) unknown.push(routed);
  }
  return { tabs, unknown };
}

function addUnique(urls: string[], url: string): void {
  if (!urls.includes(url)) urls.push(url);
}

function canvasCourseId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== CANVAS_ORIGIN) return undefined;
    return /^\/courses\/(\d+)(?:\/|$)/.exec(parsed.pathname)?.[1];
  } catch { return undefined; }
}

/** The course id when every Canvas tab URL that has one names the same course. */
function sharedCourseId(tabs: readonly RoutedTab[]): string | undefined {
  const ids = new Set(tabs.map(tab => canvasCourseId(tab.url)).filter((id): id is string => id !== undefined));
  return ids.size === 1 ? [...ids][0] : undefined;
}

/**
 * A home link unlocks Pages or Files only when it is on Canvas, belongs to the same course as that
 * `on-home-link` tab, and points into that tab's area. Any other home link (another course, an off-origin
 * URL, a `never` area) returns undefined and is never given to a job.
 */
function homeLinkSaveUrl(url: string, tabs: readonly RoutedTab[]): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.origin !== CANVAS_ORIGIN) return undefined;
  const area = /^\/courses\/(\d+)\/(pages|files)(?:\/|$)/.exec(parsed.pathname);
  if (!area) return undefined;
  const [, courseId, areaName] = area;
  const areaTab = tabs.find(tab => tab.id === areaName && tab.route === 'on-home-link');
  if (!areaTab) return undefined;
  const tabCourseId = canvasCourseId(areaTab.url) ?? sharedCourseId(tabs);
  return tabCourseId === courseId ? url : undefined;
}

/**
 * Collect the URLs a job may receive. `read`, `save` and `link` URLs come from the tabs themselves;
 * Pages and Files contribute no URL of their own, only same-course home links the saver may open.
 */
export function allowedUrls(routes: TabRouting, homeLinks: readonly HomeLink[]): AllowedUrls {
  const allowed: AllowedUrls = { read: [], save: [], link: [] };
  for (const tab of routes.tabs) {
    if ((tab.route === 'read' || tab.route === 'save' || tab.route === 'link') && tab.url) addUnique(allowed[tab.route], tab.url);
  }
  for (const link of homeLinks) {
    const url = homeLinkSaveUrl(link.url, routes.tabs);
    if (url) addUnique(allowed.save, url);
  }
  return allowed;
}

/** Whether a URL is allowed for a job under any route. Exact string match after `allowedUrls` built the lists. */
export function isAllowed(url: string, allowed: AllowedUrls): boolean {
  return allowed.read.includes(url) || allowed.save.includes(url) || allowed.link.includes(url);
}
