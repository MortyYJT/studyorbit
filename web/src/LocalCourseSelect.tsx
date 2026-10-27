import { useEffect, useState } from 'react';
import type { Language } from './i18n.js';

type Course = { id: string; name: string; subjectCode: string; term?: string | null };
const key = 'coursework.selected-course-ids';
function storedIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** A small local selection flow for the course discovery prototype. */
export function LocalCourseSelect({ language }: { language: Language }) {
  const [courses, setCourses] = useState<Course[]>();
  const [selected, setSelected] = useState<string[]>(storedIds);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const zh = language === 'zh';

  async function load() {
    setError('');
    try {
      const response = await fetch('/api/local/course-candidates', { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? 'missing' : 'unavailable');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('courses' in data) || !Array.isArray(data.courses)
        || !data.courses.every((course: unknown) => course && typeof course === 'object'
          && typeof (course as Course).id === 'string' && typeof (course as Course).name === 'string'
          && typeof (course as Course).subjectCode === 'string')) throw new Error('unavailable');
      setCourses(data.courses as Course[]);
    } catch (err) {
      setCourses(undefined);
      setError(err instanceof Error && err.message === 'missing' ? 'missing' : 'unavailable');
    }
  }
  useEffect(() => { void load(); }, []);

  function save() {
    setSaving(true);
    try { localStorage.setItem(key, JSON.stringify(selected)); setSaved(true); setError(''); }
    catch { setError('save'); }
    finally { setSaving(false); }
  }
  return <section className="card local-course-select" aria-labelledby="local-course-title">
    <div className="row-heading"><h2 id="local-course-title">{zh ? '选择要排期的课程' : 'Choose courses to plan'}</h2>
      <button onClick={() => { setSaved(false); void load(); }}>{zh ? '刷新列表' : 'Refresh list'}</button></div>
    <p className="muted">{zh ? '勾选你要排期的课程，选择保存在当前浏览器中，可再次修改。' : 'Select courses to plan. Your choices are saved in this browser and can be changed later.'}</p>
    {error && <p role="status">{error === 'missing'
      ? (zh ? '尚未获取课程，请先在终端运行 npm run sync:courses。' : 'No course list yet. Run npm run sync:courses in your terminal.')
      : error === 'save' ? (zh ? '保存失败，请检查浏览器存储是否可用。' : 'Could not save your selection in this browser.')
      : (zh ? '无法读取课程列表，请确认开发服务器正在运行并刷新列表。' : 'Could not load the course list. Check the development server and refresh.')}</p>}
    {courses && (courses.length ? <>
      <fieldset className="course-select"><legend className="visually-hidden">{zh ? '课程列表' : 'Courses'}</legend>
        {courses.map(course => <label key={course.id} className="check-row">
          <input type="checkbox" checked={selected.includes(course.id)} onChange={event => {
            setSelected(previous => event.target.checked ? [...previous, course.id] : previous.filter(id => id !== course.id));
            setSaved(false);
          }} />
          <span><b>{course.subjectCode}</b> <span className="muted">{course.name}</span> {course.term && <small>{course.term}</small>}</span>
        </label>)}
      </fieldset>
      <button className="primary" onClick={save} disabled={saving}>{zh ? '保存选择' : 'Save selection'}</button>
      {saved && <p role="status">{zh ? '选择已保存。' : 'Selection saved.'}</p>}
    </> : <p>{zh ? '没有符合课程代码规则的候选项。' : 'No candidates match the subject-code rule.'}</p>)}
  </section>;
}
