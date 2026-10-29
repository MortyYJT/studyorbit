// Load the selected-course candidates and their newest valid course document from the owner's Desktop
// course folders (the institution's folder under the Desktop, `分数结构*.json`). Shared by the course-reports
// route and Agent chat so both read exactly the same data. Version 1 and 2 files are both valid; the stored document
// is returned unchanged, and consumers convert it with `toDisplayDocument` (shared/course-data.ts).
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CourseDocumentSchema } from '../../shared/course-data.ts';
import { courseListOrigin, filterSubjects } from './course-list.mjs';
import { DEFAULT_INSTITUTION } from '../institutions/registry.mjs';

function courseListFile(projectDir) { return join(projectDir, '.local', 'lms', 'courses.json'); }

/**
 * Newest valid course document (version 1 or 2) of `courseId` among `分数结构*.json` in `dir`, by modification time, or null.
 * Also used by the sync to find the earlier document for the legacy ID map.
 */
export async function newestCourseDocument(dir, courseId) {
  let names;
  try { names = (await readdir(dir)).filter(name => /^分数结构(?:-[a-zA-Z0-9-]+)?\.json$/.test(name)); }
  catch { return null; }
  const files = (await Promise.all(names.map(async name => {
    try { return { name, mtime: (await stat(join(dir, name))).mtimeMs }; } catch { return null; }
  }))).filter(Boolean);
  files.sort((a, b) => b.mtime - a.mtime);
  for (const file of files) {
    try {
      const data = CourseDocumentSchema.safeParse(JSON.parse(await readFile(join(dir, file.name), 'utf8')));
      if (data.success && data.data.course.id === courseId) return data.data;
    } catch { /* Older valid reports may still be usable. */ }
  }
  return null;
}

/** Desktop course folder of a course: the institution's path segments under `desktop`. */
function courseFolder(course, desktop, institution) {
  return join(desktop, ...institution.courseFolder({ term: course.term, subjectCode: course.subjectCode }));
}

async function newestReport(course, desktop, institution) {
  if (!institution.isSubjectCode(course.subjectCode)) return null;
  return { id: course.id, report: await newestCourseDocument(courseFolder(course, desktop, institution), course.id) };
}

/**
 * Course candidates from `.local/lms/courses.json` and the newest valid report for each, under `institution`.
 * Throws when the course list is missing (ENOENT) or invalid, and with code `COURSE_LIST_STALE` when `canvasOrigin` is
 * given and the list was discovered on another Canvas (design §2).
 */
export async function loadCourseReports(projectDir, { desktop = join(homedir(), 'Desktop'), institution = DEFAULT_INSTITUTION, canvasOrigin } = {}) {
  const input = JSON.parse(await readFile(courseListFile(projectDir), 'utf8'));
  if (!Array.isArray(input.courses)) throw new Error('Invalid course file');
  if (canvasOrigin !== undefined && courseListOrigin(input) !== canvasOrigin) throw Object.assign(new Error('COURSE_LIST_STALE'), { code: 'COURSE_LIST_STALE' });
  const candidates = input.courses.filter(item => !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string');
  const courses = filterSubjects(candidates, institution);
  const reports = await Promise.all(courses.map(course => newestReport(course, desktop, institution)));
  return { courses, reports: reports.filter(Boolean) };
}
