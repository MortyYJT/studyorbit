import { describe, expect, it } from 'vitest';
import type { CanvasTab, TabsStage } from '../../src/sync/canvas-api.js';
import { allowedUrls, isAllowed, routeTabs } from '../../src/sync/routing.js';

const origin = 'https://canvas.lms.unimelb.edu.au';
const course = (id: number | string, rest = '') => `${origin}/courses/${id}${rest}`;
const stage = (tabs: CanvasTab[]): TabsStage => ({ source: 'synthetic tabs', via: 'api', tabs });
const tab = (id: string, label: string, url?: string): CanvasTab =>
  ({ id, label, type: 'synthetic', ...(url ? { url } : {}) });

const routesById = (tabs: TabsStage) =>
  Object.fromEntries(routeTabs(tabs).tabs.map(entry => [entry.id, entry.route]));

describe('routeTabs (layered-sync task 4.2)', () => {
  it('routes every Canvas built-in id to its table entry', () => {
    const tabs = stage([
      tab('home', 'Home', course(12345)),
      tab('assignments', 'Assignments', course(12345, '/assignments')),
      tab('quizzes', 'Quizzes', course(12345, '/quizzes')),
      tab('grades', 'Grades', course(12345, '/grades')),
      tab('modules', 'Modules', course(12345, '/modules')),
      tab('pages', 'Pages', course(12345, '/pages')),
      tab('files', 'Files', course(12345, '/files')),
      tab('announcements', 'Announcements', course(12345, '/announcements')),
      tab('discussions', 'Discussions', course(12345, '/discussion_topics')),
      tab('people', 'People', course(12345, '/users')),
      tab('outcomes', 'Outcomes', course(12345, '/outcomes')),
      tab('collaborations', 'Collaborations', course(12345, '/collaborations')),
      tab('syllabus', 'Syllabus', course(12345, '/assignments/syllabus')),
    ]);
    expect(routesById(tabs)).toEqual({
      home: 'read',
      assignments: 'read',
      quizzes: 'read',
      grades: 'read',
      modules: 'save',
      pages: 'on-home-link',
      files: 'on-home-link',
      announcements: 'never',
      discussions: 'never',
      people: 'never',
      outcomes: 'never',
      collaborations: 'never',
      syllabus: 'on-home-link',
    });
    expect(routeTabs(tabs).unknown).toEqual([]);
  });

  it('links a syllabus that leaves Canvas and keeps a Canvas syllabus on the home link', () => {
    const ed = stage([tab('syllabus', 'Syllabus', 'https://edstem.org/au/courses/12345/syllabus')]);
    expect(routeTabs(ed).tabs[0]).toMatchObject({ id: 'syllabus', route: 'link' });
    expect(routeTabs(ed).unknown).toEqual([]);

    const canvas = stage([tab('syllabus', 'Syllabus', course(12345, '/assignments/syllabus'))]);
    expect(routeTabs(canvas).tabs[0]).toMatchObject({ id: 'syllabus', route: 'on-home-link' });
    expect(routeTabs(canvas).unknown).toEqual([]);
  });

  it('matches external tool labels case-insensitively, whole or as a clear prefix', () => {
    const tabs = stage([
      tab('context_external_tool_1', 'Lecture Capture', 'https://lecture.example.edu/1'),
      tab('context_external_tool_2', 'LECTURE CAPTURE', 'https://lecture.example.edu/2'),
      tab('context_external_tool_3', 'Gradescope (UoM)', 'https://gradescope.example.edu/3'),
      tab('context_external_tool_4', 'gradescope', 'https://gradescope.example.edu/4'),
      tab('context_external_tool_5', 'Echo360', 'https://echo360.example.edu/5'),
      tab('context_external_tool_6', 'Zoom', 'https://zoom.example.edu/6'),
      tab('context_external_tool_7', 'Office 365', 'https://office.example.edu/7'),
      tab('context_external_tool_8', 'Google Drive', 'https://drive.example.edu/8'),
      tab('context_external_tool_9', 'Readings Online', 'https://readings.example.edu/9'),
      tab('context_external_tool_10', 'Ed Discussion', 'https://edstem.org/au/courses/12345'),
    ]);
    expect(routesById(tabs)).toEqual({
      context_external_tool_1: 'link',
      context_external_tool_2: 'link',
      context_external_tool_3: 'never',
      context_external_tool_4: 'never',
      context_external_tool_5: 'never',
      context_external_tool_6: 'never',
      context_external_tool_7: 'never',
      context_external_tool_8: 'never',
      context_external_tool_9: 'never',
      context_external_tool_10: 'never',
    });
    // Known tools are `never`, not unknown: the run lists only tabs the table does not know.
    expect(routeTabs(tabs).unknown).toEqual([]);
  });

  it('routes an unknown tab never and lists it as unknown', () => {
    const unknown = tab('context_external_tool_4242', 'Library Resources', 'https://library.example.edu/');
    const routes = routeTabs(stage([tab('home', 'Home', course(12345)), unknown]));
    expect(routes.tabs.find(entry => entry.id === unknown.id)).toMatchObject({ route: 'never' });
    expect(routes.unknown).toEqual([expect.objectContaining({ id: unknown.id, label: 'Library Resources', route: 'never' })]);
  });

  it('keeps tab ids, labels and optional URLs unchanged', () => {
    const withUrl = tab('modules', 'Modules', course(12345, '/modules'));
    const withoutUrl = tab('announcements', 'Announcements');
    const routes = routeTabs(stage([withUrl, withoutUrl]));
    expect(routes.tabs[0]).toEqual({ id: 'modules', label: 'Modules', url: course(12345, '/modules'), route: 'save' });
    expect(routes.tabs[1]).toEqual({ id: 'announcements', label: 'Announcements', route: 'never' });
    expect(routes.tabs[1]).not.toHaveProperty('url');
  });
});

describe('allowedUrls and isAllowed (layered-sync task 4.2)', () => {
  const routeTabsFor = (tabs: CanvasTab[]) => routeTabs(stage(tabs));

  it('never gives a job the Gradescope or Echo360 URL', () => {
    const routes = routeTabsFor([
      tab('home', 'Home', course(12345)),
      tab('context_external_tool_1', 'Gradescope', 'https://gradescope.example.edu/course/12345'),
      tab('context_external_tool_2', 'Echo360', 'https://echo360.example.edu/section/12345'),
    ]);
    const allowed = allowedUrls(routes, []);
    expect(routes.tabs.map(entry => entry.route)).toEqual(['read', 'never', 'never']);
    for (const url of ['https://gradescope.example.edu/course/12345', 'https://echo360.example.edu/section/12345']) {
      expect([...allowed.read, ...allowed.save, ...allowed.link]).not.toContain(url);
      expect(isAllowed(url, allowed)).toBe(false);
    }
  });

  it('lets a same-course home link to a Files folder unlock the saver, and without it the Files tab is not allowed', () => {
    const files = course(12345, '/files');
    const routes = routeTabsFor([
      tab('home', 'Home', course(12345)),
      tab('files', 'Files', files),
    ]);
    const folder = course(12345, '/files/folder/678');
    const withLink = allowedUrls(routes, [{ label: 'Audio and PDF material', url: folder }]);
    expect(withLink.save).toContain(folder);
    expect(withLink.save).not.toContain(files);
    expect(isAllowed(folder, withLink)).toBe(true);
    expect(isAllowed(files, withLink)).toBe(false);

    const withoutLink = allowedUrls(routes, []);
    expect([...withoutLink.read, ...withoutLink.save, ...withoutLink.link]).not.toContain(files);
    expect(isAllowed(files, withoutLink)).toBe(false);
  });

  it('lets a same-course home link into Pages unlock the saver and leaves the Pages tab URL itself out', () => {
    const pages = course(12345, '/pages');
    const routes = routeTabsFor([
      tab('home', 'Home', course(12345)),
      tab('pages', 'Pages', pages),
    ]);
    const page = course(12345, '/pages/week-1-notes');
    const allowed = allowedUrls(routes, [{ label: 'Week 1 notes', url: page }]);
    expect(allowed.save).toContain(page);
    expect(allowed.save).not.toContain(pages);
  });

  it('takes read, save and link URLs from the tabs themselves', () => {
    const lecture = 'https://lecture.example.edu/au/course/12345';
    const routes = routeTabsFor([
      tab('home', 'Home', course(12345)),
      tab('assignments', 'Assignments', course(12345, '/assignments')),
      tab('modules', 'Modules', course(12345, '/modules')),
      tab('context_external_tool_1', 'Lecture Capture', lecture),
    ]);
    const allowed = allowedUrls(routes, []);
    expect(allowed.read).toEqual([course(12345), course(12345, '/assignments')]);
    expect(allowed.save).toEqual([course(12345, '/modules')]);
    expect(allowed.link).toEqual([lecture]);
    expect(isAllowed(course(12345, '/assignments'), allowed)).toBe(true);
  });

  it('rejects home links to another course, off Canvas, into a never area, or outside Pages and Files', () => {
    const routes = routeTabsFor([
      tab('home', 'Home', course(12345)),
      tab('pages', 'Pages', course(12345, '/pages')),
      tab('files', 'Files', course(12345, '/files')),
      tab('discussions', 'Discussions', course(12345, '/discussion_topics')),
    ]);
    const rejected = [
      course(999, '/files/folder/1'),
      'https://example.com/courses/12345/files/folder/1',
      course(12345, '/discussion_topics/123'),
      course(12345, '/assignments/700001'),
      course(12345, '/modules'),
    ];
    const allowed = allowedUrls(routes, rejected.map((url, index) => ({ label: `Synthetic link ${index}`, url })));
    for (const url of rejected) expect(isAllowed(url, allowed)).toBe(false);
    expect(allowed.save).toEqual([]);
  });

  it('does not unlock a home link into an area whose tab is not routed on-home-link', () => {
    const routes = routeTabsFor([tab('home', 'Home', course(12345))]);
    const folder = course(12345, '/files/folder/678');
    const allowed = allowedUrls(routes, [{ label: 'Files', url: folder }]);
    expect(isAllowed(folder, allowed)).toBe(false);
  });

  it('allows an off-origin Lecture Capture tab URL as a link but not an unrelated off-origin home link', () => {
    const lecture = 'https://lecture.example.edu/au/course/12345';
    const routes = routeTabsFor([
      tab('home', 'Home', course(12345)),
      tab('context_external_tool_1', 'Lecture Capture', lecture),
    ]);
    const allowed = allowedUrls(routes, [{ label: 'Lecture Capture', url: lecture }, { label: 'Video', url: 'https://video.example.edu/1' }]);
    expect(allowed.link).toEqual([lecture]);
    expect(isAllowed(lecture, allowed)).toBe(true);
    expect(isAllowed('https://video.example.edu/1', allowed)).toBe(false);
  });

  it('deduplicates URLs across tabs and home links', () => {
    const page = course(12345, '/pages/week-1');
    const routes = routeTabsFor([
      tab('pages', 'Pages', course(12345, '/pages')),
      tab('home', 'Home', course(12345)),
    ]);
    const allowed = allowedUrls(routes, [
      { label: 'Week 1', url: page },
      { label: 'Week 1 again', url: page },
    ]);
    expect(allowed.save).toEqual([page]);
    expect(allowed.read).toEqual([course(12345)]);
  });
});

describe('routing hardening (#195 review)', () => {
  const tabs = stage([tab('home', 'Home', course(12345)), tab('files', 'Files', course(12345, '/files'))]);

  it('stores the normalised home link and refuses userinfo and encoded separators', () => {
    const allowed = allowedUrls(routeTabs(tabs), [
      { label: 'Upper', url: 'HTTPS://CANVAS.LMS.UNIMELB.EDU.AU:443/courses/12345/files/folder/week1' },
      { label: 'Userinfo', url: 'https://u:p@canvas.lms.unimelb.edu.au/courses/12345/files/x' },
      { label: 'Encoded slash', url: course(12345, '/files/..%2Fdiscussion_topics') },
      { label: 'Encoded backslash', url: course(12345, '/files/..%5Cdiscussion_topics') },
    ]);
    expect(allowed.save).toEqual([course(12345, '/files/folder/week1')]);
  });

  it('routes a label naming two tools to never', () => {
    const routed = routeTabs(stage([tab('context_external_tool_1', 'Lecture Capture & Zoom', `${origin}/courses/12345/external_tools/1`)]));
    expect(routed.tabs[0]!.route).toBe('never');
  });

  it('compares home links with the expected course id when one is given', () => {
    const odd = stage([tab('home', 'Home', course(12345)), tab('files', 'Files', course(999, '/files'))]);
    const link = { label: 'Other course', url: course(999, '/files/x') };
    expect(allowedUrls(routeTabs(odd), [link], { courseId: '12345' }).save).toEqual([]);
    expect(allowedUrls(routeTabs(tabs), [{ label: 'Own', url: course(12345, '/files/x') }], { courseId: '12345' }).save)
      .toEqual([course(12345, '/files/x')]);
  });
});
