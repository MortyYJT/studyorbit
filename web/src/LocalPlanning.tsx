import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Language } from './i18n.js';

type RecordValue = Record<string, unknown>;
type Course = { id: string; name: string; subjectCode: string; term?: string };
type Assessment = { key: string; name: string; due: string; weight: string; weightValue?: number; score?: number; outOf?: number; group: string; status: string; link: string; caution: boolean };
type CourseData = { course: Course; assessments: Assessment[]; groups: RecordValue[]; materials: RecordValue[]; issues: RecordValue[]; available: boolean };
type Work = { key: string; courseId: string; courseCode: string; title: string; due: string; minutes: number };
const workKey = 'coursework.local-planning.work.v1';
const capacityKey = 'coursework.local-planning.capacity.v1';
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const list = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = record(value);
    return text(v['页面原文'] ?? v['原文'] ?? v['时间'] ?? v['日期'] ?? v['值'] ?? v['数值']);
  }
  return '';
}
function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return undefined;
}
function url(value: unknown): string {
  const candidate = text(value);
  try { const parsed = new URL(candidate); return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : ''; } catch { return ''; }
}
function readWork(): Work[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(workKey) ?? '[]');
    return Array.isArray(value) ? value.filter(item => item && typeof item.key === 'string' && typeof item.courseId === 'string' && typeof item.courseCode === 'string' && typeof item.title === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due) && typeof item.minutes === 'number' && Number.isFinite(item.minutes) && item.minutes > 0) : [];
  } catch { return []; }
}
function localDay(date = new Date()): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function addDays(day: string, count: number): string { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10); }
function normalize(course: Course, value: unknown): CourseData {
  const report = record(value);
  const sources = list(report['来源']);
  const equalFour = sources.some(item => /four written assignments equally weighted and worth a total of 15%/i.test(text(item['关键原文'])));
  const assessments = list(report['考核项目']).map((item, index): Assessment => {
    const name = text(item['名称']) || `未命名考核 ${index + 1}`;
    const link = url(item['链接'] ?? item['原始链接']);
    const caution = /\b(?:aea|special consideration|supplementary|deferred|alternative|replacement)\b|特殊|替代|补考|延期/i.test(`${name} ${text(item['类型'])}`);
    // Historic reports mix group and item weights. Only the explicitly evidenced case is projected.
    const overview = sources.map(source => text(source['关键原文'])).join(' ');
    const weightValue = equalFour && /^assignment\s*[1-4]$/i.test(name) ? 3.75
      : /^mid-semester test$/i.test(name) && /mid-semester test[^.]*\(10%\)/i.test(overview) ? 10 : undefined;
    const weight = weightValue === 3.75 ? '3.75% · 平均推算' : weightValue === 10 ? '10%' : '';
    const result = record(item['已出成绩']);
    const score = number(result['分数'] ?? item['成绩']);
    const points = record(item['满分']);
    const outOf = number(result['满分'] ?? points['实际满分'] ?? item['满分']);
    return { key: `${course.id}:${link || `${index}:${name}`}`, name, due: text(item['截止时间']), weight, weightValue, score, outOf, group: text(item['分组'] ?? item['评分组']), status: text(item['状态']), link, caution };
  });
  const rawGroups = report['考核分组'];
  return { course, assessments, groups: Array.isArray(rawGroups) ? list(rawGroups) : list(record(rawGroups)['页面原始行'] ?? record(rawGroups)['分组']), materials: list(report['课程资料']), issues: list(report['未能获取']), available: !!value };
}

function ScoreOverview({ assessments, zh }: { assessments: Assessment[]; zh: boolean }) {
  const [target, setTarget] = useState('H1');
  const graded = assessments.filter(item => item.weightValue !== undefined && item.score !== undefined && item.outOf !== undefined && item.outOf > 0 && item.score >= 0 && item.score <= item.outOf && !item.caution);
  const weight = graded.reduce((sum, item) => sum + item.weightValue!, 0);
  const earned = graded.reduce((sum, item) => sum + item.weightValue! * item.score! / item.outOf!, 0);
  const average = weight ? earned / weight * 100 : undefined;
  return <section className="card local-score" aria-label={zh ? '分数构成' : 'Score structure'}>
    <svg className="donut" viewBox="0 0 170 170" role="img" aria-label={zh ? '已确认成绩' : 'Confirmed grades'}>
      <circle className="track" cx="85" cy="85" r="70" />
      {weight > 0 && <circle cx="85" cy="85" r="70" fill="none" stroke="#e4c64d" strokeWidth="24" strokeDasharray={`${Math.min(earned, 100) * 4.398} 439.8`} transform="rotate(-90 85 85)" />}
      <text x="85" y="90" className="total">{weight ? earned.toFixed(1) : '—'}</text><text x="85" y="110" className="caption">{zh ? '已确认 / 100' : 'confirmed / 100'}</text>
    </svg>
    <div className="local-score-content"><h2>{zh ? '分数构成' : 'Score structure'}</h2><div className="facts">
      <div><div className="v">{average === undefined ? '—' : `${average.toFixed(1)}%`}</div><div className="muted">{zh ? '当前平均' : 'Current average'}</div></div>
      <div><div className="v">{weight ? `${weight.toFixed(2).replace(/\.00$/, '')}%` : '—'}</div><div className="muted">{zh ? '已确认出分占比' : 'Confirmed graded weight'}</div></div>
      <div><div className="v small">{zh ? '权重或计分规则待核' : 'Weights or grading rules unverified'}</div><label className="inline muted">{zh ? '期末需要 · 目标' : 'Final needed · target'} <select value={target} onChange={event => setTarget(event.target.value)}>{['H1', 'H2A', 'H2B', 'H3', 'P'].map(band => <option key={band}>{band}</option>)}</select></label></div>
    </div><p className="muted">{zh ? '只计算有明确单项权重、分数和满分的项目；未包含其他已出分项目，不代表最终成绩。' : 'Only items with verified individual weight and score are included; other grades may be missing.'}</p></div>
  </section>;
}

export function LocalPlanning({ language, refreshVersion, courseId, onCourse, onBack, syncIssues }: { language: Language; refreshVersion: number; courseId?: string; onCourse: (id: string) => void; onBack: () => void; syncIssues: { id: string; status: string; reason: string }[] }) {
  const zh = language === 'zh';
  const [courses, setCourses] = useState<CourseData[]>([]);
  const [error, setError] = useState('');
  const [work, setWork] = useState<Work[]>(readWork);
  const [capacity, setCapacity] = useState(() => { try { const n = Number(localStorage.getItem(capacityKey)); return Number.isFinite(n) && n > 0 && n <= 1440 ? n : 120; } catch { return 120; } });
  const [week, setWeek] = useState(() => { const today = localDay(); return addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7)); });
  const [chosen, setChosen] = useState<Assessment>();
  const [saveError, setSaveError] = useState(false);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const response = await fetch('/api/local/course-reports', { cache: 'no-store' });
        if (!response.ok) throw new Error('unavailable');
        const data: { courses: Course[]; reports: { id: string; report: unknown }[] } = await response.json();
        let ids: string[] = [];
        try { const selected: unknown = JSON.parse(localStorage.getItem('coursework.selected-course-ids') ?? '[]'); if (Array.isArray(selected)) ids = selected.filter((id): id is string => typeof id === 'string'); } catch { /* No saved selection. */ }
        if (live) { setCourses(data.courses.filter(course => ids.includes(course.id)).map(course => normalize(course, data.reports.find(item => item.id === course.id)?.report))); setError(''); }
      } catch { if (live) setError(zh ? '无法读取本地课程数据，请先同步课程。' : 'Could not load local course data. Sync courses first.'); }
    }
    void load(); return () => { live = false; };
  }, [refreshVersion, zh]);
  const selected = courses.find(item => item.course.id === courseId);
  const plan = useMemo(() => {
    const days = new Map<string, { work: Work; minutes: number }[]>();
    const used = new Map<string, number>();
    const overflow: { work: Work; minutes: number }[] = [];
    const today = localDay();
    for (const item of [...work].filter(item => courses.some(course => course.course.id === item.courseId)).sort((a, b) => a.due.localeCompare(b.due) || a.key.localeCompare(b.key))) {
      let remaining = item.minutes;
      // Bound computation even if a user enters an extremely distant deadline.
      for (let day = today, i = 0; day <= item.due && i < 366 && remaining > 0; day = addDays(day, 1), i++) {
        const amount = Math.min(remaining, Math.max(0, capacity - (used.get(day) ?? 0)));
        if (amount > 0) { days.set(day, [...(days.get(day) ?? []), { work: item, minutes: amount }]); used.set(day, (used.get(day) ?? 0) + amount); remaining -= amount; }
      }
      if (remaining > 0) overflow.push({ work: item, minutes: remaining });
    }
    return { days, overflow };
  }, [work, capacity, courses]);
  function saveWork(next: Work[]): boolean { try { localStorage.setItem(workKey, JSON.stringify(next)); setWork(next); setSaveError(false); return true; } catch { setSaveError(true); return false; } }
  function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !chosen) return;
    const data = new FormData(event.currentTarget); const due = String(data.get('due') ?? ''); const minutes = Number(data.get('minutes'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(minutes) || minutes <= 0 || minutes > 100000) return;
    if (saveWork([...work.filter(item => item.key !== chosen.key), { key: chosen.key, courseId: selected.course.id, courseCode: selected.course.subjectCode, title: chosen.name, due, minutes }])) setChosen(undefined);
  }
  if (courseId) return <>
    <button onClick={onBack}>← {zh ? '返回周计划' : 'Back to week'}</button>
    {error && <p className="needs">{error}</p>}
    {selected ? <div className="local-course-detail">
      <div className="page-heading"><div><p className="muted">{selected.course.subjectCode} · {selected.course.term}</p><h1>{selected.course.name}</h1></div></div>
      {!selected.available && <p className="needs">{zh ? '这门课尚无可用的同步结果。' : 'No sync result is available for this course yet.'}</p>}
      {syncIssues.filter(item => item.id === selected.course.id && item.status === 'failed').map(item => <p className="needs" key={item.id}>{zh ? '最近一次同步未能完成；如果下方有资料，可能来自之前的结果。' : 'The latest sync failed; any information below may be from an earlier result.'} {item.reason}</p>)}
      {selected.available && <ScoreOverview assessments={selected.assessments} zh={zh} />}
      {!!selected.groups.length && <section className="card"><h2>{zh ? '分数构成' : 'Score structure'}</h2><p className="muted">{zh ? '以下是来源中的分组权重；可能包含重复或冲突，暂不自动合计。' : 'Source group weights may overlap or conflict; totals are not calculated.'}</p>
        {selected.groups.map((group, index) => <div className="local-group" key={index}><span>{text(group['名称'] ?? group['组名原文'] ?? group['组名']) || '—'}</span><strong>{text(group['课程占比'] ?? group['权重'] ?? group['页面原文权重']) || '待核'}{typeof (group['课程占比'] ?? group['权重'] ?? group['页面原文权重']) === 'number' ? '%' : ''}</strong></div>)}</section>}
      <section className="card"><h2>{zh ? '考核项目' : 'Assessments'}</h2>
        {!selected.assessments.length && <p className="muted">{zh ? '暂未获取考核项目。' : 'No assessments found yet.'}</p>}
        {[...new Set(selected.assessments.map(item => item.group))].map(group => <div key={group || 'ungrouped'} className="local-assessment-group">
          <div className="ghead"><b>{group || (zh ? '未归组考核' : 'Other assessments')}</b></div>
          {selected.assessments.filter(item => item.group === group).map(item => <article className="local-assessment" key={item.key}>
          <div><strong>{item.name}</strong>{item.link && <> · <a href={item.link} target="_blank" rel="noreferrer">{zh ? '查看来源' : 'Source'}</a></>}
            <p className="muted">{zh ? '截止时间' : 'Due'}: {item.due || (zh ? '未知' : 'Unknown')} · {zh ? '课程占比' : 'Weight'}: {item.weight || (zh ? '待核' : 'Unverified')} · {zh ? '成绩' : 'Score'}: {item.score === undefined ? '—' : `${item.score}${item.outOf !== undefined ? ` / ${item.outOf}` : ''}`}</p>
            {item.status && <small>{item.status}</small>}{item.caution && <p className="local-caution">{zh ? '可能是替代或特殊安排，请先确认是否适用于你，再决定是否排期。' : 'This may be an alternative assessment; confirm it applies before scheduling.'}</p>}</div>
          <button onClick={() => setChosen(item)}>{work.some(entry => entry.key === item.key) ? (zh ? '修改排期' : 'Edit plan') : (zh ? '加入排期' : 'Plan')}</button>
        </article>)}</div>)}
      </section>
      {chosen && <section className="card"><h2>{zh ? '安排学习' : 'Plan study'} · {chosen.name}</h2><p className="muted">{zh ? '请根据来源确认日期，并填写你预计的学习时间；系统按每日可用时间分配。' : 'Confirm the date from the source and enter your estimated study time.'}</p>
        <form key={chosen.key} onSubmit={schedule} className="local-plan-form"><label>{zh ? '截止日期' : 'Due date'}<input name="due" type="date" required defaultValue={work.find(item => item.key === chosen.key)?.due} /></label>
          <label>{zh ? '预计学习分钟数' : 'Estimated minutes'}<input name="minutes" type="number" min="1" max="100000" required defaultValue={work.find(item => item.key === chosen.key)?.minutes} /></label>
          <div><button className="primary" type="submit">{zh ? '保存并排期' : 'Save and plan'}</button> <button type="button" onClick={() => setChosen(undefined)}>{zh ? '取消' : 'Cancel'}</button></div></form></section>}
      {!!selected.materials.length && <section className="card"><h2>{zh ? '课程资料' : 'Course materials'}</h2><ul className="local-materials">{selected.materials.map((item, index) => { const link = url(item['原始链接'] ?? item['链接']); const name = text(item['名称']) || '资料'; return <li key={index}>{link ? <a href={link} target="_blank" rel="noreferrer">{name}</a> : name}</li>; })}</ul></section>}
      {!!selected.issues.filter(item => !/按要求|按用户.*限制|没有下载|不读取|not download/i.test(text(item['原因']))).length && <details className="card"><summary>{zh ? '课程资料与待核信息' : 'Course notes and missing information'}</summary>{selected.issues.filter(item => !/按要求|按用户.*限制|没有下载|不读取|not download/i.test(text(item['原因']))).map((item, index) => <p key={index}><strong>{text(item['项目'])}</strong> {text(item['原因'])}</p>)}</details>}
    </div> : <p>{zh ? '课程不可用或未选中。' : 'Course unavailable or not selected.'}</p>}
    {saveError && <p role="alert">{zh ? '保存失败，请检查浏览器存储。' : 'Could not save; check browser storage.'}</p>}
  </>;
  return <div className="local-planning">
    {error && <p className="needs">{error}</p>}
    <section className="card"><div className="row-heading"><h2>{zh ? '我的课程' : 'My courses'}</h2></div>
      {!courses.length && <p className="muted">{zh ? '同步并选择课程后，课程会显示在这里。' : 'Sync and select courses to see them here.'}</p>}
      <div className="local-course-cards">{courses.map(item => <button key={item.course.id} className="local-course-card" onClick={() => onCourse(item.course.id)}><strong>{item.course.subjectCode}</strong><span>{item.course.name}</span><small>{item.available ? `${item.assessments.length} ${zh ? '项考核' : 'assessments'}` : (zh ? '等待课程数据' : 'Waiting for data')} →</small></button>)}</div>
    </section>
    <section className="card"><div className="week-toolbar"><div className="week-nav"><button onClick={() => setWeek(addDays(week, -7))}>←</button><strong>{week} — {addDays(week, 6)}</strong><button onClick={() => setWeek(addDays(week, 7))}>→</button><button onClick={() => { const day = localDay(); setWeek(addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7))); }}>{zh ? '本周' : 'Today'}</button></div>
      <label className="inline">{zh ? '每天可用分钟' : 'Minutes per day'} <input style={{ width: 90 }} type="number" min="1" max="1440" value={capacity} onChange={event => { const value = Number(event.target.value); if (value > 0 && value <= 1440) { try { localStorage.setItem(capacityKey, String(value)); setCapacity(value); setSaveError(false); } catch { setSaveError(true); } } }} /></label></div>
      <p className="muted">{zh ? '在课程中选择考核，填写截止日期和预计时间后，自动按截止日期与每天可用时间分配。排期按日期计算，请另外核对截止当天的具体时间。计划保存在当前浏览器。' : 'Choose an assessment, confirm its due date and estimate; time is allocated according to daily availability. Check the exact deadline time separately. Plans are saved in this browser.'}</p>
      <div className="local-week-grid">{Array.from({ length: 7 }, (_, index) => { const day = addDays(week, index); const entries = plan.days.get(day) ?? []; return <div className="local-day" key={day}><strong>{day.slice(5)}</strong><small>{['一', '二', '三', '四', '五', '六', '日'][index]}</small>{entries.map(entry => <div className="local-plan-entry" key={entry.work.key}><b>{entry.work.courseCode}</b><span>{entry.work.title}</span><small>{entry.minutes} min</small></div>)}{!entries.length && <small>—</small>}</div>; })}</div>
      {!!plan.overflow.length && <div className="needs"><strong>{zh ? '时间不足或截止日期已过' : 'Insufficient time or overdue'}</strong>{plan.overflow.map(item => <p key={item.work.key}>{item.work.courseCode} · {item.work.title} · {zh ? '尚未安排' : 'Unscheduled'} {item.minutes} min</p>)}</div>}
      {!!work.length && <details><summary>{zh ? '已加入的学习任务' : 'Planned work'}</summary>{work.filter(item => courses.some(course => course.course.id === item.courseId)).map(item => <div className="local-group" key={item.key}><span>{item.courseCode} · {item.title} · {item.due} · {item.minutes} min</span><button onClick={() => saveWork(work.filter(row => row.key !== item.key))}>{zh ? '移除' : 'Remove'}</button></div>)}</details>}
      {saveError && <p role="alert">{zh ? '保存失败，请检查浏览器存储。' : 'Could not save; check browser storage.'}</p>}
    </section>
  </div>;
}
