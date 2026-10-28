import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Language } from './i18n.js';
import { CourseDocumentSchema } from '../../shared/course-data.js';
import { calculateGrades, parentGrade } from '../../shared/course-calculations.js';

type RecordValue = Record<string, unknown>;
type Course = { id: string; name: string; subjectCode: string; term?: string };
type Kind = 'exam' | 'quiz' | 'assignment' | 'presentation' | 'participation' | 'hurdle' | 'ungraded' | 'unknown';
type Assessment = { key: string; name: string; due: string; weight: string; weightValue?: number; sourceZero: boolean; kind: Kind; score?: number; outOf?: number; group: string; parent: string; status: string; link: string; sources: { platform: string; link: string }[]; caution: boolean; hurdle: boolean; ungraded?: boolean; bonus?: boolean; rule?: string; scoring?: 'none' | 'points' | 'weighted' };
type Correction = { kind?: Kind; nature?: 'regular' | 'ungraded' | 'bonus' | 'alternative'; weight?: number | null; due?: string | null; name?: string; score?: number | null; outOf?: number | null; parent?: string; status?: string; link?: string; mergeInto?: string; bonus?: boolean; rule?: string; scoring?: 'none' | 'points' | 'weighted'; hidden?: boolean };
type CourseData = { course: Course; assessments: Assessment[]; materials: RecordValue[]; available: boolean };
type ParentAssessment = { name: string; displayName?: string; kind?: Kind; weight?: number; children: Assessment[]; scoringRule: string; score?: number; outOf?: number; status?: string; due?: string; sourceKey?: string };
type Work = { key: string; courseId: string; courseCode: string; title: string; due: string; minutes: number };
const workKey = 'coursework.local-planning.work.v1';
const capacityKey = 'coursework.local-planning.capacity.v1';
const correctionKey = 'coursework.local-planning.corrections.v1';
const manualKey = 'coursework.local-planning.assessments.v1';
const orderKey = 'coursework.local-planning.order.v1';
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
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
function statusLabel(value: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = { not_started: ['未开始', 'Not started'], in_progress: ['进行中', 'In progress'], submitted: ['已提交', 'Submitted'], graded: ['已出分', 'Graded'], unknown: ['—', '—'] };
  return labels[value]?.[zh ? 0 : 1] ?? value;
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
  const parsed = CourseDocumentSchema.safeParse(value);
  if (!parsed.success || parsed.data.course.id !== course.id) return { course, assessments: [], materials: [], available: false };
  const doc = parsed.data;
  const assessments: Assessment[] = doc.assessments.map(item => ({
    key: `${course.id}:${item.id}`, name: item.name,
    kind: item.kind === 'test' ? 'exam' : item.kind === 'other' ? 'unknown' : item.kind,
    due: item.due ?? '', weight: item.weight === null ? '' : `${item.weight}%`, weightValue: item.weight ?? undefined,
    sourceZero: item.weight === 0, score: item.score ?? undefined, outOf: item.maxScore ?? undefined,
    group: '', parent: item.parentId ? `${course.id}:${item.parentId}` : '', status: item.status === 'unknown' ? '' : item.status,
    link: item.sources.find(source => source.url)?.url ?? '', sources: item.sources.flatMap(source => source.url ? [{ platform: source.platform, link: source.url }] : []),
    caution: item.nature === 'alternative', hurdle: item.kind === 'hurdle', ungraded: item.nature === 'ungraded', bonus: item.nature === 'bonus', rule: item.rule ?? '', scoring: item.scoring,
  }));
  return { course, assessments, materials: doc.materials.map(item => ({ 名称: item.name, 链接: item.url })), available: true };
}
function assessmentParents(_course: CourseData, visible: Assessment[]): ParentAssessment[] {
  return visible.flatMap(source => {
    const children = visible.filter(item => item.parent === source.key && !item.caution);
    return children.length ? [{ name: source.key, displayName: source.name, sourceKey: source.key, weight: source.weightValue,
      kind: source.kind, children, scoringRule: source.scoring ?? 'none', score: source.score, outOf: source.outOf, status: source.status, due: source.due }] : [];
  });
}
function ScoreOverview({ assessments, parents, zh }: { assessments: Assessment[]; parents: ParentAssessment[]; zh: boolean }) {
  const [target, setTarget] = useState('H1');
  const { weight, earned, average } = calculateGrades(assessments, parents);
  return <section className="card score" aria-label={zh ? '分数构成' : 'Score structure'}>
    <svg className="donut" viewBox="0 0 170 170" role="img" aria-label={zh ? '已得成绩' : 'Earned grades'}>
      <circle className="track" cx="85" cy="85" r="70" />
      {weight > 0 && <circle cx="85" cy="85" r="70" fill="none" stroke="#e4c64d" strokeWidth="24" strokeDasharray={`${Math.min(earned, 100) * 4.398} 439.8`} transform="rotate(-90 85 85)" />}
      <text x="85" y="90" className="total">{weight ? earned.toFixed(1) : '—'}</text><text x="85" y="110" className="caption">{zh ? '已得 / 100' : 'earned / 100'}</text>
    </svg>
    <div><div className="facts">
      <div><div className="v">{average === undefined ? '—' : `${average.toFixed(1)}%`}</div><div className="muted">{zh ? '当前平均' : 'Current average'}</div></div>
      <div><div className="v">{weight ? `${weight.toFixed(2).replace(/\.00$/, '')}%` : '—'}</div><div className="muted">{zh ? '已出分占比' : 'Graded weight'}</div></div>
      <div><div className="v small">—</div><label className="inline muted">{zh ? '期末需要 · 目标' : 'Final needed · target'} <select value={target} onChange={event => setTarget(event.target.value)}>{['H1', 'H2A', 'H2B', 'H3', 'P'].map(band => <option key={band}>{band}</option>)}</select></label></div>
    </div><div className="key"><span><i className="earned" />{zh ? '已得' : 'Earned'}</span><span><i className="not-earned" />{zh ? '未得' : 'Not earned'}</span></div></div>
  </section>;
}

function WeightBreakdown({ assessments, parents, zh }: { assessments: Assessment[]; parents: ParentAssessment[]; zh: boolean }) {
  const rows = assessments.filter(item => !item.parent && !item.bonus && !item.ungraded && !item.caution).flatMap(item => {
    const parent = parents.find(group => group.sourceKey === item.key);
    const weight = parent ? parent.weight : item.weightValue;
    return weight !== undefined && weight > 0 ? [{ key: item.key, name: parent?.displayName || item.name, weight }] : [];
  });
  if (!rows.length) return null;
  return <section className="weight-breakdown"><h2>{zh ? '分数占比' : 'Assessment weights'}</h2><div className="weight-breakdown-list">{rows.map(item => <div className="weight-breakdown-item" key={item.key}><span>{item.name}</span><strong>{item.weight}%</strong></div>)}</div></section>;
}

export function LocalPlanning({ language, refreshVersion, courseId, onCourse, onBack, syncIssues }: { language: Language; refreshVersion: number; courseId?: string; onCourse: (id: string) => void; onBack: () => void; syncIssues: { id: string; status: string; reason: string }[] }) {
  const zh = language === 'zh';
  const [courses, setCourses] = useState<CourseData[]>([]);
  const [error, setError] = useState('');
  const [work, setWork] = useState<Work[]>(readWork);
  const [corrections, setCorrections] = useState<Record<string, Correction>>(() => { try { return record(JSON.parse(localStorage.getItem(correctionKey) ?? '{}')) as Record<string, Correction>; } catch { return {}; } });
  const [manual, setManual] = useState<Record<string, Assessment[]>>(() => { try { return record(JSON.parse(localStorage.getItem(manualKey) ?? '{}')) as Record<string, Assessment[]>; } catch { return {}; } });
  const [order, setOrder] = useState<Record<string, string[]>>(() => { try { return record(JSON.parse(localStorage.getItem(orderKey) ?? '{}')) as Record<string, string[]>; } catch { return {}; } });
  const [adding, setAdding] = useState(false);
  const [capacity, setCapacity] = useState(() => { try { const n = Number(localStorage.getItem(capacityKey)); return Number.isFinite(n) && n > 0 && n <= 1440 ? n : 120; } catch { return 120; } });
  const [week, setWeek] = useState(() => { const today = localDay(); return addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7)); });
  const [chosen, setChosen] = useState<Assessment>();
  const [mode, setMode] = useState<'plan' | 'month'>('plan');
  const [courseTab, setCourseTab] = useState<'assessments' | 'revision'>('assessments');
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
  const original = courses.find(item => item.course.id === courseId);
  const selected = original && { ...original, assessments: [...original.assessments, ...(Array.isArray(manual[original.course.id]) ? manual[original.course.id] : [])].map(item => {
    const change = record(corrections[item.key]); const overrideWeight = number(change.weight);
    const validKind = ['exam', 'quiz', 'assignment', 'presentation', 'participation', 'hurdle', 'ungraded', 'unknown'].includes(String(change.kind)) ? change.kind as Kind : item.kind;
    return { ...item, kind: validKind, ...(typeof change.name === 'string' && change.name ? { name: change.name } : {}),
      ...(change.weight === null ? { weightValue: undefined, weight: '', sourceZero: false } : overrideWeight !== undefined && overrideWeight >= 0 && overrideWeight <= 100 ? { weightValue: overrideWeight, weight: `${overrideWeight}%`, sourceZero: overrideWeight === 0 } : {}),
      ...(change.score === null ? { score: undefined } : number(change.score) !== undefined ? { score: number(change.score) } : {}),
      ...(change.outOf === null ? { outOf: undefined } : number(change.outOf) !== undefined ? { outOf: number(change.outOf) } : {}),
      ...(typeof change.parent === 'string' ? { parent: change.parent } : {}), ...(typeof change.status === 'string' ? { status: change.status } : {}),
      ...(typeof change.nature === 'string' ? { bonus: change.nature === 'bonus', caution: change.nature === 'alternative', ungraded: change.nature === 'ungraded' } : typeof change.bonus === 'boolean' ? { bonus: change.bonus } : {}), ...(typeof change.rule === 'string' ? { rule: change.rule } : {}),
      ...(typeof change.link === 'string' ? { link: url(change.link) } : {}),
      ...(change.due === null ? { due: '' } : typeof change.due === 'string' ? { due: change.due } : {}) };
  }) };
  const primaryItems = (selected?.assessments ?? []).filter(item => !corrections[item.key]?.mergeInto && !corrections[item.key]?.hidden && !(item.parent && corrections[item.parent]?.hidden));
  const parents = selected ? assessmentParents(selected, primaryItems).map(parent => {
    const change = corrections[`${selected.course.id}:group:${parent.name}`];
    return change ? { ...parent, displayName: change.name || parent.displayName || parent.name, kind: change.kind ?? parent.kind, scoringRule: change.scoring ?? parent.scoringRule, weight: change.weight === null ? undefined : change.weight ?? parent.weight,
      score: change.score === null ? undefined : change.score ?? parent.score, outOf: change.outOf === null ? undefined : change.outOf ?? parent.outOf, status: change.status ?? parent.status, due: change.due === null ? undefined : change.due ?? parent.due } : parent;
  }) : [];
  function saveCorrections(next: Record<string, Correction>): boolean { try { localStorage.setItem(correctionKey, JSON.stringify(next)); setCorrections(next); setSaveError(false); return true; } catch { setSaveError(true); return false; } }
  function saveManual(next: Record<string, Assessment[]>): boolean { try { localStorage.setItem(manualKey, JSON.stringify(next)); setManual(next); setSaveError(false); return true; } catch { setSaveError(true); return false; } }
  function move(key: string, siblings: string[], direction: number) {
    if (!courseId) return; const index = siblings.indexOf(key); const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= siblings.length) return;
    const reordered = [...siblings]; [reordered[index], reordered[destination]] = [reordered[destination]!, reordered[index]!];
    const existing = Array.isArray(order[courseId]) ? order[courseId] : [];
    const next = { ...order, [courseId]: [...existing.filter(id => !reordered.includes(id)), ...reordered] };
    try { localStorage.setItem(orderKey, JSON.stringify(next)); setOrder(next); setSaveError(false); } catch { setSaveError(true); }
  }
  function sorted<T>(items: T[], key: (item: T) => string): T[] {
    const ranks = courseId && Array.isArray(order[courseId]) ? order[courseId] : [];
    return [...items].sort((a, b) => { const x = ranks.indexOf(key(a)), y = ranks.indexOf(key(b)); return (x < 0 ? Infinity : x) - (y < 0 ? Infinity : y); });
  }
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
  if (courseId) return <div className="course-page">
    <button className="crumb" onClick={onBack}>← {zh ? '本周' : 'This week'}</button>
    {error && <p className="needs">{error}</p>}
    {selected ? <>
      <div className="chead"><h1>{selected.course.subjectCode}</h1><span className="muted">{selected.course.name}</span><small>{selected.course.term}</small></div>
      {!selected.available && <p className="needs">{zh ? '这门课尚无可用的同步结果。' : 'No sync result is available for this course yet.'}</p>}
      {syncIssues.filter(item => item.id === selected.course.id && item.status === 'failed').map(item => <p className="needs" key={item.id}>{zh ? '最近一次同步未完成，正在显示已保存的课程信息。' : 'The latest sync failed. Showing saved course information.'}</p>)}
      {selected.available && <ScoreOverview assessments={primaryItems.filter(item => {
        const source = item.parent ? primaryItems.find(parent => parent.key === item.parent) : undefined;
        return !item.caution && !(source && (source.bonus || source.caution || source.ungraded || source.kind === 'ungraded' || source.sourceZero));
      })} parents={parents.filter(parent => {
        const source = primaryItems.find(item => item.key === parent.sourceKey);
        return source && !source.bonus && !source.caution && !source.ungraded && source.kind !== 'ungraded' && !source.sourceZero;
      })} zh={zh} />}
      {selected.available && <WeightBreakdown assessments={primaryItems} parents={parents} zh={zh} />}
      <div className="tabs" role="tablist"><button role="tab" aria-selected={courseTab === 'assessments'} onClick={() => setCourseTab('assessments')}>{zh ? '考核' : 'Assessments'}</button><button role="tab" aria-selected={courseTab === 'revision'} onClick={() => setCourseTab('revision')}>{zh ? '复习' : 'Revision'}</button></div>
      {courseTab === 'assessments' ? <div className="assessment-list">
        <button onClick={() => setAdding(value => !value)}>{adding ? (zh ? '取消' : 'Cancel') : (zh ? '新增考核' : 'Add assessment')}</button>
        {adding && <form className="local-confirm" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const name = String(data.get('name') ?? '').trim(); if (!name) return;
          const kind = String(data.get('kind') ?? 'unknown') as Kind; const weightText = String(data.get('weight') ?? '').trim(); const weight = weightText ? Number(weightText) : undefined;
          if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 100)) return;
          const scoreText = String(data.get('score') ?? '').trim(); const maxText = String(data.get('outOf') ?? '').trim(); const score = scoreText ? Number(scoreText) : undefined; const outOf = maxText ? Number(maxText) : undefined;
          if ((score !== undefined && (!Number.isFinite(score) || score < 0)) || (outOf !== undefined && (!Number.isFinite(outOf) || outOf < 0)) || (score !== undefined && outOf !== undefined && score > outOf)) return;
          const item: Assessment = { key: `${selected.course.id}:manual:${crypto.randomUUID()}`, name, kind, due: String(data.get('due') ?? ''), weight: weight === undefined ? '' : `${weight}%`, weightValue: weight, sourceZero: weight === 0, score, outOf, group: '', parent: String(data.get('parent') ?? '').trim(), status: '', link: url(data.get('link')), sources: [], hurdle: kind === 'hurdle', ungraded: data.get('nature') === 'ungraded', bonus: data.get('nature') === 'bonus', caution: data.get('nature') === 'alternative' };
          if (saveManual({ ...manual, [selected.course.id]: [...(manual[selected.course.id] ?? []), item] })) setAdding(false);
        }}><label>{zh ? '名称' : 'Name'}<input name="name" required /></label><label>{zh ? '类型' : 'Type'}<select name="kind"><option value="assignment">{zh ? '作业' : 'Assignment'}</option><option value="quiz">Quiz</option><option value="exam">Test</option><option value="presentation">{zh ? '展示' : 'Presentation'}</option><option value="participation">{zh ? '参与' : 'Participation'}</option><option value="hurdle">Hurdle</option></select></label><label>{zh ? '性质' : 'Nature'}<select name="nature"><option value="regular">{zh ? '普通考核' : 'Regular'}</option><option value="bonus">{zh ? '加分' : 'Bonus'}</option><option value="ungraded">{zh ? '不计分' : 'Ungraded'}</option><option value="alternative">{zh ? '替代考试' : 'Alternative'}</option></select></label><label>{zh ? '占比 %' : 'Weight %'}<input type="number" name="weight" min="0" max="100" step="any" /></label><label>{zh ? '得分' : 'Score'}<input type="number" name="score" min="0" step="any" /></label><label>{zh ? '满分' : 'Out of'}<input type="number" name="outOf" min="0" step="any" /></label><label>{zh ? '截止日期' : 'Due date'}<input type="date" name="due" /></label><label>{zh ? '归属' : 'Parent'}<select name="parent"><option value="">{zh ? '无' : 'None'}</option>{primaryItems.filter(item => !item.parent).map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label><label>{zh ? '链接' : 'Link'}<input type="url" name="link" /></label><button type="submit">{zh ? '保存' : 'Save'}</button></form>}
        <div className="arow head" aria-hidden="true"><span>{zh ? '名称' : 'Name'}</span><span>{zh ? '截止' : 'Due'}</span><span className="num">{zh ? '权重' : 'Weight'}</span><span className="num">{zh ? '分数' : 'Score'}</span><span>{zh ? '状态' : 'Status'}</span><span>{zh ? '排期' : 'Plan'}</span></div>
        {!selected.assessments.length && <p className="muted">{zh ? '暂未获取考核项目。' : 'No assessments found yet.'}</p>}
        {(() => {
          const kinds: Kind[] = ['quiz', 'assignment', 'exam', 'presentation', 'participation', 'hurdle', 'unknown', 'ungraded'];
          const labels: Record<Kind, string> = zh ? { exam: '考试', quiz: '测验', assignment: '作业', presentation: '展示', participation: '参与', hurdle: 'Hurdle', ungraded: '其他项目', unknown: '其他' } : { exam: 'Exams', quiz: 'Quizzes', assignment: 'Assignments', presentation: 'Presentations', participation: 'Participation', hurdle: 'Hurdles', ungraded: 'Other items', unknown: 'Other' };
          const all = selected.assessments;
          const visible = primaryItems;
          const childKeys = new Set(parents.flatMap(parent => [...parent.children.map(item => item.key), ...(parent.sourceKey ? [parent.sourceKey] : [])]));
          const row = (item: Assessment, siblings: string[]) => <details key={item.key} className="assessment-entry"><summary className="arow">
            <span className="aname">{item.name}{item.bonus && <span className="kind">{zh ? '加分' : 'Bonus'}</span>}</span>
            <span className="muted">{item.due || (zh ? '未知' : 'Unknown')}</span><span className="num">{item.bonus ? (item.outOf !== undefined ? `${zh ? '最多' : 'Up to'} ${item.outOf} ${zh ? '分' : 'pts'}` : '—') : item.sourceZero ? '0%' : item.weight || '—'}</span>
            <span className="num points">{item.score !== undefined ? `${item.score}${item.outOf !== undefined ? ` / ${item.outOf}` : ''}` : item.bonus && item.outOf !== undefined ? `— / ${item.outOf}` : '—'}</span>
            <span>{statusLabel(corrections[item.key]?.status || item.status || (item.score !== undefined ? 'graded' : 'unknown'), zh)}</span><span>{work.some(entry => entry.key === item.key) ? (zh ? '已排期' : 'Planned') : '—'}</span></summary>
            <div className="assessment-expanded">
              <div className="assessment-order"><button type="button" disabled={siblings.indexOf(item.key) <= 0} onClick={() => move(item.key, siblings, -1)}>{zh ? '上移' : 'Move up'}</button><button type="button" disabled={siblings.indexOf(item.key) >= siblings.length - 1} onClick={() => move(item.key, siblings, 1)}>{zh ? '下移' : 'Move down'}</button></div>
              {item.rule && <p>{item.rule}</p>}
              {(item.link || item.sources.length > 0) && <p>{item.link && !item.sources.some(source => source.link === item.link) && <><a href={item.link} target="_blank" rel="noreferrer">{zh ? '我的链接' : 'My link'}</a>{item.sources.length > 0 && ' · '}</>}{item.sources.map((source, index) => <span key={`${source.link}-${index}`}>{index > 0 && ' · '}<a href={source.link} target="_blank" rel="noreferrer">{source.platform.toLowerCase() === 'ed' ? 'Ed' : source.platform.toLowerCase() === 'canvas' ? 'Canvas' : (zh ? '来源' : 'Source')}</a></span>)}</p>}
              {all.filter(other => corrections[other.key]?.mergeInto === item.key).map(other => <div key={other.key} className="local-group"><span>{zh ? '已合并来源' : 'Merged source'}: {other.name} {other.link && <a href={other.link} target="_blank" rel="noreferrer">{zh ? '查看' : 'View'}</a>}</span><button onClick={() => { const next = { ...corrections }; const change = { ...next[other.key] }; delete change.mergeInto; next[other.key] = change; saveCorrections(next); }}>{zh ? '撤销合并' : 'Undo merge'}</button></div>)}
              <details className="assessment-edit"><summary>{zh ? '编辑或合并' : 'Edit or merge'}</summary><form className="local-confirm" key={item.key} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const rawWeight = String(data.get('weight') ?? '').trim(); const newWeight = rawWeight === '' ? undefined : Number(rawWeight); if (newWeight !== undefined && (!Number.isFinite(newWeight) || newWeight < 0 || newWeight > 100)) return;
                const name = String(data.get('name') ?? '').trim(); if (!name) return;
                const scoreText = String(data.get('score') ?? '').trim(), maxText = String(data.get('outOf') ?? '').trim(); const score = scoreText ? Number(scoreText) : null, outOf = maxText ? Number(maxText) : null;
                if ((score !== null && (!Number.isFinite(score) || score < 0)) || (outOf !== null && (!Number.isFinite(outOf) || outOf < 0)) || (score !== null && outOf !== null && score > outOf)) return;
                const next: Correction = { ...corrections[item.key], name, kind: String(data.get('kind')) as Kind, nature: String(data.get('nature')) as Correction['nature'], rule: String(data.get('rule') ?? '').trim(), weight: newWeight ?? null, score, outOf, due: String(data.get('due') ?? '') || null, parent: String(data.get('parent') ?? '').trim(), status: String(data.get('status') ?? '').trim(), link: String(data.get('link') ?? '').trim() };
                saveCorrections({ ...corrections, [item.key]: next }); }}>
                <label>{zh ? '名称' : 'Name'}<input name="name" required defaultValue={item.name} /></label>
                <label>{zh ? '类型' : 'Type'}<select name="kind" defaultValue={item.kind}>{(['quiz', 'assignment', 'exam', 'presentation', 'participation', 'hurdle', 'unknown'] as Kind[]).map(kind => <option value={kind} key={kind}>{labels[kind]}</option>)}</select></label>
                <label>{zh ? '性质' : 'Nature'}<select name="nature" defaultValue={item.bonus ? 'bonus' : item.caution ? 'alternative' : item.ungraded || item.kind === 'ungraded' ? 'ungraded' : 'regular'}><option value="regular">{zh ? '普通考核' : 'Regular'}</option><option value="bonus">{zh ? '加分' : 'Bonus'}</option><option value="ungraded">{zh ? '不计分' : 'Ungraded'}</option><option value="alternative">{zh ? '替代考试' : 'Alternative'}</option></select></label><label>{zh ? '规则' : 'Rule'}<input name="rule" defaultValue={item.rule ?? ''} /></label>
                <label>{zh ? '单项占比 %' : 'Item weight %'}<input name="weight" type="number" min="0" max="100" step="any" defaultValue={item.weightValue} /></label>
                <label>{zh ? '得分' : 'Score'}<input name="score" type="number" min="0" step="any" defaultValue={item.score} /></label><label>{zh ? '满分' : 'Out of'}<input name="outOf" type="number" min="0" step="any" defaultValue={item.outOf} /></label>
                <label>{zh ? '截止时间' : 'Due'}<input name="due" defaultValue={item.due} placeholder="YYYY-MM-DD" /></label><label>{zh ? '归属' : 'Parent'}<select name="parent" defaultValue={item.parent}><option value="">{zh ? '无' : 'None'}</option>{visible.filter(candidate => candidate.key !== item.key && !candidate.parent && !visible.some(child => child.parent === item.key)).map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.name}</option>)}</select></label><label>{zh ? '状态' : 'Status'}<input name="status" defaultValue={corrections[item.key]?.status ?? ''} /></label><label>{zh ? '链接' : 'Link'}<input type="url" name="link" defaultValue={item.link} /></label><button type="submit">{zh ? '保存' : 'Save'}</button>
              </form>
              <div className="local-merge"><label>{zh ? '如果是同一个考核，合并到' : 'If this is the same assessment, merge into'}<select defaultValue="" onChange={event => { const target = event.target.value; if (!target) return; saveCorrections({ ...corrections, [item.key]: { ...corrections[item.key], mergeInto: target } }); }}><option value="">{zh ? '选择考核' : 'Choose assessment'}</option>{visible.filter(other => other.key !== item.key && !all.some(child => corrections[child.key]?.mergeInto === item.key || child.parent === item.key)).map(other => <option value={other.key} key={other.key}>{other.name}</option>)}</select></label><small>{zh ? '来源保留，可撤销。已有排期不会自动移除。' : 'Sources remain and merges can be undone. Existing plans are not removed.'}</small></div>
              </details><button onClick={() => setChosen(item)}>{zh ? '安排学习' : 'Plan study'}</button> <button onClick={() => saveCorrections({ ...corrections, [item.key]: { ...corrections[item.key], hidden: true } })}>{zh ? '移除' : 'Remove'}</button>
            </div></details>;
          const scoredParticipation = (item: Assessment) => item.kind === 'participation' && !item.ungraded && (item.bonus === true || !item.sourceZero && (item.weightValue ?? 0) > 0);
          const standaloneHurdle = (item: Assessment) => item.kind === 'hurdle';
          const groupedItem = (kind: Kind) => visible.filter(item => !childKeys.has(item.key) && !item.caution && (kind === 'hurdle' ? standaloneHurdle(item) : !standaloneHurdle(item) && (kind === 'participation' ? scoredParticipation(item) : item.kind === kind && (!item.sourceZero || item.bonus) && !item.ungraded && item.kind !== 'ungraded')));
          const foldedItems = visible.filter(item => !childKeys.has(item.key) && (item.caution || !standaloneHurdle(item) && (!item.bonus && item.sourceZero || item.ungraded || item.kind === 'ungraded' || item.kind === 'participation' && !scoredParticipation(item))));
          const foldedParent = (parent: ParentAssessment) => {
            const source = visible.find(item => item.key === parent.sourceKey);
            if (!source) return false;
            if (source.caution) return true;
            if ((parent.kind ?? source.kind) === 'hurdle') return false;
            return Boolean(source.ungraded || source.kind === 'ungraded' || !source.bonus && (parent.weight === 0 || (parent.kind === 'participation' && !(parent.weight && parent.weight > 0))));
          };
          return <>
            {kinds.map(kind => { const items = kind === 'ungraded' ? foldedItems : groupedItem(kind); const combined: { key: string; item?: Assessment; parent?: ParentAssessment }[] = [
              ...parents.filter(parent => kind === 'ungraded' ? foldedParent(parent) : !foldedParent(parent) && (parent.kind ?? 'assignment') === kind).map(parent => ({ key: `${selected.course.id}:group:${parent.name}`, parent })), ...items.map(item => ({ key: item.key, item })) ];
              const ordered = sorted(combined, entry => entry.key); if (!ordered.length) return null;
              const siblingKeys = ordered.map(entry => entry.key);
              const open = kind !== 'ungraded' && (kind !== 'participation' || items.some(item => item.hurdle || scoredParticipation(item)) || ordered.some(entry => (entry.parent?.weight ?? 0) > 0));
              return <details className="agroup category" key={kind} open={open || undefined}><summary className="ghead"><b>{labels[kind]}</b><small>{ordered.length}</small></summary>
                {ordered.map(entry => entry.item ? row(entry.item, siblingKeys) : (() => { const parent = entry.parent!; const grade = parentGrade(parent); const children = sorted(parent.children, item => item.key); const childOrder = children.map(item => item.key);
                  return <details className="assessment-parent" key={entry.key}><summary className="arow"><span className="aname"><strong>{parent.displayName || parent.name}</strong></span><span className="muted">{parent.due || `${parent.children.length} ${zh ? '个子项' : 'items'}`}</span><span className="num">{parent.weight === undefined ? '—' : `${parent.weight}%`}</span><span className="num">{grade ? `${Number(grade.score.toFixed(2))} / ${Number(grade.outOf.toFixed(2))}` : '—'}</span><span>{statusLabel(parent.status || (grade ? 'graded' : 'unknown'), zh)}</span><span>—</span></summary>
                    <div className="assessment-children"><div className="assessment-order"><button type="button" disabled={siblingKeys.indexOf(entry.key) <= 0} onClick={() => move(entry.key, siblingKeys, -1)}>{zh ? '上移' : 'Move up'}</button><button type="button" disabled={siblingKeys.indexOf(entry.key) >= siblingKeys.length - 1} onClick={() => move(entry.key, siblingKeys, 1)}>{zh ? '下移' : 'Move down'}</button></div>
                    {children.map(item => row(item, childOrder))}
                    <details className="assessment-edit"><summary>{zh ? '编辑父考核' : 'Edit parent'}</summary><form className="local-confirm" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const name = String(data.get('name') ?? '').trim(); if (!name) return;
                      const w = String(data.get('weight') ?? '').trim(), n = String(data.get('score') ?? '').trim(), m = String(data.get('outOf') ?? '').trim(); const weight = w ? Number(w) : null, score = n ? Number(n) : null, outOf = m ? Number(m) : null;
                      if ((weight !== null && (!Number.isFinite(weight) || weight < 0 || weight > 100)) || (score !== null && (!Number.isFinite(score) || score < 0)) || (outOf !== null && (!Number.isFinite(outOf) || outOf < 0)) || (score !== null && outOf !== null && score > outOf)) return;
                      saveCorrections({ ...corrections, [parent.sourceKey!]: { ...corrections[parent.sourceKey!], nature: String(data.get('nature')) as Correction['nature'] }, [entry.key]: { ...corrections[entry.key], name, kind: String(data.get('kind')) as Kind, scoring: String(data.get('scoring')) as 'none' | 'points' | 'weighted', weight, score, outOf, due: String(data.get('due') ?? '') || null, status: String(data.get('status') ?? '').trim() } }); }}>
                      <label>{zh ? '名称' : 'Name'}<input name="name" required defaultValue={parent.displayName || parent.name} /></label><label>{zh ? '类型' : 'Type'}<select name="kind" defaultValue={parent.kind ?? 'assignment'}>{(['quiz', 'assignment', 'exam', 'presentation', 'participation', 'hurdle', 'unknown'] as Kind[]).map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label><label>{zh ? '性质' : 'Nature'}<select name="nature" defaultValue={(() => { const source = visible.find(item => item.key === parent.sourceKey); return source?.bonus ? 'bonus' : source?.caution ? 'alternative' : source?.ungraded ? 'ungraded' : 'regular'; })()}><option value="regular">{zh ? '普通考核' : 'Regular'}</option><option value="bonus">{zh ? '加分' : 'Bonus'}</option><option value="ungraded">{zh ? '不计分' : 'Ungraded'}</option><option value="alternative">{zh ? '替代考试' : 'Alternative'}</option></select></label><label>{zh ? '占比 %' : 'Weight %'}<input type="number" min="0" max="100" step="any" name="weight" defaultValue={parent.weight} /></label><label>{zh ? '子项计分方式' : 'Child scoring'}<select name="scoring" defaultValue={parent.scoringRule}><option value="none">{zh ? '不自动汇总' : 'No aggregation'}</option><option value="points">{zh ? '按分值' : 'By points'}</option><option value="weighted">{zh ? '按各项权重' : 'By weights'}</option></select></label><label>{zh ? '得分' : 'Score'}<input type="number" min="0" step="any" name="score" defaultValue={parent.score} /></label><label>{zh ? '满分' : 'Out of'}<input type="number" min="0" step="any" name="outOf" defaultValue={parent.outOf} /></label><label>{zh ? '日期' : 'Due date'}<input type="date" name="due" defaultValue={parent.due} /></label><label>{zh ? '状态' : 'Status'}<input name="status" defaultValue={parent.status} /></label><button type="submit">{zh ? '保存' : 'Save'}</button></form></details>
                    <button onClick={() => saveCorrections({ ...corrections, [parent.sourceKey!]: { ...corrections[parent.sourceKey!], hidden: true } })}>{zh ? '移除' : 'Remove'}</button> <button onClick={() => setChosen({ key: entry.key, name: parent.displayName || parent.name, due: parent.due || '', weight: parent.weight === undefined ? '' : `${parent.weight}%`, sourceZero: false, kind: 'assignment', group: parent.name, status: parent.status || '', link: '', sources: [], parent: '', caution: false, hurdle: false })}>{zh ? '安排整个作业' : 'Plan assignment'}</button></div></details>;
                })())}
              </details>; })}
            {selected.assessments.some(item => corrections[item.key]?.hidden) && <details className="no-marks"><summary>{zh ? '已移除' : 'Removed'}</summary>{selected.assessments.filter(item => corrections[item.key]?.hidden).map(item => <div className="local-group" key={item.key}><span>{item.name}</span><button onClick={() => saveCorrections({ ...corrections, [item.key]: { ...corrections[item.key], hidden: false } })}>{zh ? '恢复' : 'Restore'}</button></div>)}</details>}
          </>;
        })()}

      </div> : <section><p className="muted">{zh ? '复习功能尚未接入。' : 'Revision is not connected yet.'}</p>
        {!!selected.materials.length && <><h2>{zh ? '课程资料' : 'Materials'}</h2><ul className="linked">{selected.materials.map((item, index) => { const link = url(item['原始链接'] ?? item['链接']); const name = text(item['名称']) || '资料'; return <li key={index}>{link ? <a href={link} target="_blank" rel="noreferrer">{name}</a> : name}</li>; })}</ul></>}</section>}
      {chosen && <div className="local-drawer-overlay" role="presentation"><section className="local-drawer" role="dialog" aria-modal="true" aria-label={chosen.name}>
        <div className="dialog-heading"><h2>{chosen.name}</h2><button onClick={() => setChosen(undefined)}>{zh ? '关闭' : 'Close'}</button></div>
        <div className="field"><span className="k">{zh ? '截止' : 'Due'}</span><span>{chosen.due || '—'}</span></div>
        <div className="field"><span className="k">{zh ? '权重' : 'Weight'}</span><span>{chosen.weight || '—'}</span></div>
        <div className="field"><span className="k">{zh ? '分数' : 'Score'}</span><span>{chosen.score === undefined ? '—' : `${chosen.score}${chosen.outOf !== undefined ? ` / ${chosen.outOf}` : ''}`}</span></div>
        {chosen.link && <p><a href={chosen.link} target="_blank" rel="noreferrer">{zh ? '查看来源' : 'Source'}</a></p>}
        <h3>{zh ? '安排学习' : 'Plan study'}</h3><p className="muted">{zh ? '填写截止日期和预计学习时间。' : 'Enter the due date and estimated study time.'}</p>
        <form key={chosen.key} onSubmit={schedule}><label>{zh ? '截止日期' : 'Due date'}<input name="due" type="date" required defaultValue={work.find(item => item.key === chosen.key)?.due ?? corrections[chosen.key]?.due} /></label><label>{zh ? '预计学习分钟数' : 'Estimated minutes'}<input name="minutes" type="number" min="1" max="100000" required defaultValue={work.find(item => item.key === chosen.key)?.minutes} /></label><button className="primary" type="submit">{zh ? '保存并排期' : 'Save and plan'}</button></form>
      </section></div>}

    </> : <p>{zh ? '课程不可用或未选中。' : 'Course unavailable or not selected.'}</p>}
    {saveError && <p role="alert">{zh ? '保存失败，请检查浏览器存储。' : 'Could not save; check browser storage.'}</p>}
  </div>;
  const today = localDay();
  const dayName = (day: string) => new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  const shortDate = (day: string) => new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  const currentMonth = week.slice(0, 7);
  const first = `${currentMonth}-01`;
  const monthStart = addDays(first, -((new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7));
  const shift = (direction: number) => {
    if (mode === 'plan') setWeek(addDays(week, direction * 7));
    else { const d = new Date(`${first}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + direction); setWeek(d.toISOString().slice(0, 10)); }
  };
  return <>
    {error && <p className="needs">{error}</p>}
    <div className="week-layout"><div className="week-main">
      <div className="week-toolbar"><div className="week-nav" role="group" aria-label={zh ? '周切换' : 'Navigate weeks'}>
        <button onClick={() => shift(-1)}>‹</button><button onClick={() => setWeek(addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7)))}>{zh ? '今天' : 'Today'}</button><button onClick={() => shift(1)}>›</button><span className="range">{mode === 'plan' ? `${shortDate(week)} – ${shortDate(addDays(week, 6))}` : currentMonth}</span></div>
        <div className="week-actions"><span className="muted">{zh ? '学期' : 'Term'}: {courses[0]?.course.term || '—'}</span><div className="seg" role="group" aria-label={zh ? '视图' : 'View'}><button aria-pressed={mode === 'plan'} onClick={() => { setWeek(addDays(week, -((new Date(`${week}T12:00:00Z`).getUTCDay() + 6) % 7))); setMode('plan'); }}>{zh ? '计划' : 'Plan'}</button><button aria-pressed={mode === 'month'} onClick={() => setMode('month')}>{zh ? '月历' : 'Month'}</button></div><button disabled title={zh ? '手动任务尚未接入' : 'Manual tasks are not connected yet'}>{zh ? '添加任务' : 'Add task'}</button></div></div>
      <div className="card notice"><label className="inline">{zh ? '每天可用分钟' : 'Minutes per day'} <input style={{ width: 90 }} type="number" min="1" max="1440" value={capacity} onChange={event => { const value = Number(event.target.value); if (value > 0 && value <= 1440) { try { localStorage.setItem(capacityKey, String(value)); setCapacity(value); setSaveError(false); } catch { setSaveError(true); } } }} /></label> <small>{zh ? '在课程中选择考核并填写截止日期和预计时间。' : 'Choose an assessment and enter its due date and estimate.'}</small></div>
      {mode === 'plan' ? <div className="card week-card"><div className="week-grid">{Array.from({ length: 7 }, (_, index) => {
        const day = addDays(week, index); const entries = plan.days.get(day) ?? []; const due = work.filter(item => item.due === day && courses.some(course => course.course.id === item.courseId));
        return <section key={day} className={`day${day === today ? ' today' : ''}${day < today ? ' past' : ''}`}>
          <div className="day-head"><b>{dayName(day)}</b><span className="hours-used">{Math.round(entries.reduce((sum, item) => sum + item.minutes, 0) / 6) / 10} / {Math.round(capacity / 6) / 10} {zh ? '小时' : 'h'}</span></div>
          <div className="day-deadlines">{due.map(item => <span className="due" key={item.key}>{zh ? '截止' : 'Due'} · {item.courseCode} · {item.title}</span>)}</div>
          <div className="day-items">{entries.length ? entries.map(entry => <button className="blk" key={entry.work.key} onClick={() => onCourse(entry.work.courseId)}><span className="tm">{entry.minutes} min</span><span className="tt">{entry.work.title}</span><span className="cr">{entry.work.courseCode}</span></button>) : <span className="muted empty-day">{zh ? '无计划' : 'No plan'}</span>}</div>
        </section>; })}</div><div className="plan-lists"><section className="plan-list"><h3>{zh ? '超出 — 截止前排不下' : 'Overflow'}</h3>{plan.overflow.length ? <ul>{plan.overflow.map(item => <li key={item.work.key}>{item.work.courseCode} · {item.work.title} · {item.minutes} min</li>)}</ul> : <p className="muted">{zh ? '无。' : 'None.'}</p>}</section><section className="plan-list"><h3>{zh ? '未预估 — 预估后才会排进计划' : 'Unestimated'}</h3><p className="muted">{zh ? '在课程页选择考核并填写预计时间。' : 'Choose an assessment and provide an estimate.'}</p></section></div></div>
        : <div className="card month" role="grid"><div className="month-row" role="row">{Array.from({ length: 7 }, (_, i) => <div className="dow" key={i}>{dayName(addDays('2026-01-05', i)).replace(/\d+/g, '')}</div>)}</div>{Array.from({ length: 6 }, (_, row) => <div className="month-row" role="row" key={row}>{Array.from({ length: 7 }, (_, col) => { const day = addDays(monthStart, row * 7 + col); return <div role="gridcell" className={`cell${day.slice(0, 7) === currentMonth ? '' : ' out'}${day === today ? ' today' : ''}`} key={day}><button className="num" onClick={() => { setWeek(addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7))); setMode('plan'); }}>{Number(day.slice(8))}</button>{work.filter(item => item.due === day && courses.some(course => course.course.id === item.courseId)).map(item => <span className="due" key={item.key}>{item.courseCode} · {item.title}</span>)}</div>; })}</div>)}</div>}
      {!!work.length && <details><summary>{zh ? '已加入的学习任务' : 'Planned work'}</summary>{work.filter(item => courses.some(course => course.course.id === item.courseId)).map(item => <div className="local-group" key={item.key}><span>{item.courseCode} · {item.title} · {item.due} · {item.minutes} min</span><button onClick={() => saveWork(work.filter(row => row.key !== item.key))}>{zh ? '移除' : 'Remove'}</button></div>)}</details>}
      {saveError && <p role="alert">{zh ? '保存失败，请检查浏览器存储。' : 'Could not save; check browser storage.'}</p>}
    </div><aside className="rail card"><h2>{zh ? '课程' : 'Courses'}</h2>{courses.length ? courses.map(item => <button key={item.course.id} className="crs" onClick={() => onCourse(item.course.id)}>
      <svg className="ring unknown" viewBox="0 0 44 44" role="img" aria-label={zh ? '课程' : 'Course'}><circle className="bg" cx="22" cy="22" r="18" /></svg>
      <span><b>{item.course.subjectCode}</b><small className="crs-name">{item.course.name}</small><small>{zh ? '下一个' : 'Next'}: {work.filter(entry => entry.courseId === item.course.id && entry.due >= today).sort((a, b) => a.due.localeCompare(b.due))[0]?.title ?? (zh ? '无' : 'None')}</small></span></button>) : <p className="muted">{zh ? '同步并选择课程后显示。' : 'Sync and select courses.'}</p>}</aside></div>
  </>;
}
