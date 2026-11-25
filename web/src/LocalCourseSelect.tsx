import { useEffect, useState } from 'react';
import type { Language } from './i18n.js';
import { useReveal } from './motion.js';

type Course = { id: string; name: string; subjectCode: string; term?: string | null };
const key = 'studyorbit.selected-course-ids';
function storedIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** A small local selection flow for the course discovery prototype. */
export function LocalCourseSelect({ language, refreshVersion, onSaved, onSync, syncing = false }: { language: Language; refreshVersion: number; onSaved: (ids: string[]) => void; /** Fetches the course list (the sidebar's "Sync now"); offered when there is no list to choose from. */ onSync?: () => void; syncing?: boolean }) {
  const [courses, setCourses] = useState<Course[]>();
  const [selected, setSelected] = useState<string[]>(storedIds);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const zh = language === 'zh';
  const reveal = useReveal(courses !== undefined || error !== '');

  async function load() {
    setError('');
    try {
      const response = await fetch('/api/local/course-candidates', { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? 'missing' : response.status === 409 ? 'stale' : 'unavailable');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('courses' in data) || !Array.isArray(data.courses)
        || !data.courses.every((course: unknown) => course && typeof course === 'object'
          && typeof (course as Course).id === 'string' && typeof (course as Course).name === 'string'
          && typeof (course as Course).subjectCode === 'string')) throw new Error('unavailable');
      setCourses(data.courses as Course[]);
    } catch (err) {
      setCourses(undefined);
      setError(err instanceof Error && (err.message === 'missing' || err.message === 'stale') ? err.message : 'unavailable');
    }
  }
  useEffect(() => { void load(); }, [refreshVersion]);

  function save() {
    setSaving(true);
    try { const ids = (courses ?? []).filter(course => selected.includes(course.id)).map(course => course.id);
      localStorage.setItem(key, JSON.stringify(ids)); setError(''); onSaved(ids); }
    catch { setError('save'); }
    finally { setSaving(false); }
  }
  return <section className="card local-course-select" aria-labelledby="local-course-title">
    <div className="row-heading"><h2 id="local-course-title">{zh ? '选择要排期的课程' : 'Choose courses to plan'}</h2>
      <button onClick={() => void load()}>{zh ? '刷新列表' : 'Refresh list'}</button></div>
    <p className="muted">{zh ? '勾选你要排期的课程，选择保存在当前浏览器中，可再次修改。' : 'Select courses to plan. Your choices are saved in this browser and can be changed later.'}</p>
    {error && <p role="status">{error === 'missing'
      ? (zh ? '还没有课程列表。「立即同步」先用已登录 Canvas 的浏览器（Edge 或 Chrome）读出你的课程，再让你勾选。' : 'No course list yet. "Sync now" reads your courses with the browser that is signed in to Canvas (Edge or Chrome), then lets you choose.')
      : error === 'stale' ? (zh ? 'Canvas 地址已更改，要用「立即同步」重新读取课程。' : 'The Canvas address changed. Use "Sync now" to read the courses again.')
      : error === 'save' ? (zh ? '保存失败，请检查浏览器存储是否可用。' : 'Could not save your selection in this browser.')
      : (zh ? '无法读取课程列表，请确认开发服务器正在运行并刷新列表。' : 'Could not load the course list. Check the development server and refresh.')}</p>}
    {/* The sidebar's button is behind this dialog, so the same action is offered here. */}
    {onSync && (error === 'missing' || error === 'stale') && <button className="primary" onClick={onSync} disabled={syncing}>{zh ? '立即同步' : 'Sync now'}</button>}
    {/* While the list loads, the rows already selected and the button keep their place. */}
    {!courses && !error && <div className={`course-select-pending pending${reveal === 'placeholder' ? ' late' : ''}`} aria-busy="true">
      <div className="course-select">{Array.from({ length: Math.max(selected.length, 1) }, (_, index) => <div className="check-row" key={index}><i className="skeleton" /></div>)}</div><div className="button-space" /></div>}
    {courses && (courses.length ? <div className={reveal === 'faded' ? 'fill-in' : undefined}>
      <fieldset className="course-select"><legend className="visually-hidden">{zh ? '课程列表' : 'Courses'}</legend>
        {courses.map(course => <label key={course.id} className="check-row">
          <input type="checkbox" checked={selected.includes(course.id)} onChange={event => {
            setSelected(previous => event.target.checked ? [...previous, course.id] : previous.filter(id => id !== course.id));
          }} />
          <span><b>{course.subjectCode}</b> <span className="muted">{course.name}</span> {course.term && <small>{course.term}</small>}</span>
        </label>)}
      </fieldset>
      <button className="primary" onClick={save} disabled={saving}>{zh ? '保存选择' : 'Save selection'}</button>
    </div> : <p>{zh ? '没有符合课程代码规则的候选项。' : 'No candidates match the subject-code rule.'}</p>)}
  </section>;
}
