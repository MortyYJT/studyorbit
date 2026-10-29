#!/usr/bin/env node
// Local stdio MCP server exposing StudyOrbit's read-only course tools (decision #331).
// Usage: node scripts/mcp-server.mjs [--project <dir>] [--desktop <dir>] [--courses <id,id>]
// stdout carries only MCP protocol messages; every diagnostic goes to stderr. Start it with `node`, not `npm run`,
// from an MCP client: npm prints a header line to stdout.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { courseContextLoader, createCourseMcpServer } from './lib/course-mcp.mjs';
import { loadSourceSetup } from './lib/source-settings.mjs';

/** Repository containing this script: the default project directory. */
const REPOSITORY = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ids = value => {
  const list = (value ?? '').split(',').map(id => id.trim()).filter(Boolean);
  return list.length ? list : null;
};

/**
 * Command-line options. `--courses` wins over `STUDYORBIT_COURSES`; both are comma-separated course IDs.
 * Paths are resolved against the working directory. Throws on unknown options or missing values.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function parseServerOptions(argv, env) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    project: { type: 'string' }, desktop: { type: 'string' }, courses: { type: 'string' },
  } });
  return {
    projectDir: values.project ? resolve(values.project) : REPOSITORY,
    desktop: values.desktop ? resolve(values.desktop) : undefined,
    courseIds: ids(values.courses) ?? ids(env.STUDYORBIT_COURSES),
  };
}

const log = message => process.stderr.write(`[studyorbit mcp] ${message}\n`);

async function main() {
  let options;
  try { options = parseServerOptions(process.argv.slice(2), process.env); }
  catch (error) {
    log(`${error instanceof Error ? error.message : error}`);
    log('Usage: node scripts/mcp-server.mjs [--project <dir>] [--desktop <dir>] [--courses <id,id>]');
    process.exitCode = 2;
    return;
  }
  const { version } = JSON.parse(readFileSync(resolve(REPOSITORY, 'package.json'), 'utf8'));
  const loadContext = courseContextLoader(options);
  // Tool descriptions name the institution's time zone; read once at startup (restart after changing the institution).
  let timeLabel;
  try { timeLabel = (await loadSourceSetup(options.projectDir)).institution.wording.timeLabel.en; }
  catch (error) { log(`Could not read the source settings: ${error instanceof Error ? error.message : error}`); }
  const server = createCourseMcpServer({
    loadContext, version, timeLabel,
    onLoadError: error => log(`Could not read the course list: ${error instanceof Error ? error.message : error}`),
  });
  // One startup read for the diagnostics only; tools read the files again on every call.
  try {
    const context = await loadContext();
    const synced = context.scope.filter(id => context.documents.some(doc => doc.course.id === id)).length;
    log(`${context.scope.length} of ${context.courses.length} listed courses in scope, ${synced} with synced data.`);
    if (options.courseIds && context.scope.length < options.courseIds.length) log('Some filtered course IDs are not in the course list and were ignored.');
  } catch (error) {
    log(`Could not read the course list yet (${error instanceof Error ? error.message : error}); tools return COURSES_UNAVAILABLE until it exists.`);
  }
  await server.connect(new StdioServerTransport());
  log('Ready on stdio (read-only).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
