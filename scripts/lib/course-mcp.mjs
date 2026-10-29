// MCP server for the shared read-only course tools (decisions #330, #331). All MCP SDK use lives here (and in the
// tests), so moving to the SDK v2 packages later touches one module. The server never writes files, starts syncs,
// reads model settings or makes network requests: every call only reads the course files and runs `runTool`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toDisplayDocument } from '../../shared/course-data.ts';
import { courseTools, courseToolsFor, runTool } from '../../shared/course-tools.ts';
import { loadCourseReports } from './course-reports.mjs';
import { loadSourceSetup } from './source-settings.mjs';

/** Every tool only reads local course files. */
export const TOOL_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

/** Fixed text for a context that could not be loaded; the cause (which may hold local paths) goes to `onLoadError`. */
const UNAVAILABLE = JSON.stringify({ error: {
  code: 'COURSES_UNAVAILABLE',
  message: 'The StudyOrbit course list could not be read. Ask the user to sync courses in StudyOrbit first, and answer without course data.',
} });

/**
 * An McpServer named `studyorbit` with one tool per registry tool. The SDK validates arguments against the zod input
 * first (invalid arguments get its own `isError` result); valid calls load a fresh context and return `runTool`'s text.
 * `timeLabel` names the time zone in the tool descriptions (the institution's English time label; default the default
 * institution's).
 * @param {{ loadContext: () => Promise<import('../../shared/course-tools.ts').ToolContext> | import('../../shared/course-tools.ts').ToolContext,
 *   version: string, onLoadError?: (error: unknown) => void, timeLabel?: string }} options
 */
export function createCourseMcpServer({ loadContext, version, onLoadError, timeLabel }) {
  const server = new McpServer({ name: 'studyorbit', version });
  for (const tool of timeLabel === undefined ? courseTools : courseToolsFor(timeLabel)) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: TOOL_ANNOTATIONS }, async args => {
      let context;
      try { context = await loadContext(); }
      catch (error) {
        onLoadError?.(error);
        return { content: [{ type: 'text', text: UNAVAILABLE }], isError: true };
      }
      const result = runTool(tool.name, args, context);
      return { content: [{ type: 'text', text: result.text }], isError: !result.ok };
    });
  }
  return server;
}

/** YYYY-MM-DD of `date` in `timeZone`, as the chat route computes it. */
function dayIn(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * A `loadContext` that reads the same files as the app on every call: the source settings, the course list in the
 * project and the newest valid document per course in the institution's Desktop course folders. The scope is every
 * listed course, or the listed courses named in `courseIds`. There is no planning snapshot. Rejects when the settings or
 * the course list cannot be read, or the list came from another Canvas than the settings'.
 * @param {{ projectDir: string, desktop?: string, courseIds?: string[] | null, now?: () => Date }} options
 */
export function courseContextLoader({ projectDir, desktop, courseIds = null, now = () => new Date() }) {
  return async () => {
    const setup = await loadSourceSetup(projectDir);
    const loaded = await loadCourseReports(projectDir, { ...(desktop ? { desktop } : {}), institution: setup.institution, canvasOrigin: setup.settings.canvasOrigin });
    const courses = loaded.courses.map(course => ({ id: course.id, code: course.subjectCode, name: course.name }));
    const documents = loaded.reports.flatMap(entry => entry.report ? [toDisplayDocument(entry.report)] : []);
    const listed = courses.map(course => course.id);
    const scope = courseIds ? listed.filter(id => courseIds.includes(id)) : listed;
    return { documents, courses, scope, today: dayIn(now(), setup.timeZone), planning: null, timeZone: setup.timeZone };
  };
}
