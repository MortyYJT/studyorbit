// Load the selected-course candidates and their newest valid course document from the owner's Desktop
// course folders (`~/Desktop/墨尔本大学 <year> S<n>/<CODE>/分数结构*.json`). Shared by the course-reports
// route and Agent chat so both read exactly the same data.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CourseDocumentSchema } from '../../shared/course-data.ts';
import { filterSubjects } from './course-list.mjs';

function courseListFile(projectDir) { return join(projectDir, '.local', 'lms', 'courses.json'); }

/** Desktop folder label for a Canvas term, e.g. "2026 S2". */
function termLabel(term) {
  const value = typeof term === 'string' ? term : '';
  const match = /(20\d{2}).*?(?:semester|sem)\s*([12])/i.exec(value);
  return match ? `${match[1]} S${match[2]}` : value.replace(/[^\w\u4e00-\u9fff -]/g, '').trim().slice(0, 50) || '未知学期';
}

async function newestReport(course, desktop) {
  if (!/^[A-Z]{4}[1-9]\d{4}$/.test(course.subjectCode)) return null;
  const dir = join(desktop, `墨尔本大学 ${termLabel(course.term)}`, course.subjectCode);
  try {
    const names = (await readdir(dir)).filter(name => /^分数结构(?:-[a-zA-Z0-9-]+)?\.json$/.test(name));
    const files = await Promise.all(names.map(async name => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })));
    files.sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      try {
        const data = CourseDocumentSchema.safeParse(JSON.parse(await readFile(join(dir, file.name), 'utf8')));
        if (data.success && data.data.course.id === course.id) return { id: course.id, report: data.data };
      } catch { /* Older valid reports may still be usable. */ }
    }
  } catch { /* A selected course may not have a report yet. */ }
  return { id: course.id, report: null };
}

/**
 * Course candidates from `.local/lms/courses.json` and the newest valid report for each.
 * Throws when the course list is missing (ENOENT) or invalid.
 */
export async function loadCourseReports(projectDir, { desktop = join(homedir(), 'Desktop') } = {}) {
  const input = JSON.parse(await readFile(courseListFile(projectDir), 'utf8'));
  if (!Array.isArray(input.courses)) throw new Error('Invalid course file');
  const candidates = input.courses.filter(item => !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string');
  const courses = filterSubjects(candidates);
  const reports = await Promise.all(courses.map(course => newestReport(course, desktop)));
  return { courses, reports: reports.filter(Boolean) };
}
