import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { Language } from './i18n.js';
import { durations, easeOut, reducedMotion, useCountUp, useSlidingIndicator } from './motion.js';
import { RichText } from './Agent.js';
import type { RevisionNote } from '../../scripts/lib/revision-store.mjs';
import { CourseDocumentSchema, toDisplayDocument } from '../../shared/course-data.js';
import { bandTargets, calculateGrades, finalNeeded, parentGrade, type Band } from '../../shared/course-calculations.js';
import { parseAvailability, schedulePlan } from '../../shared/planning.js';
import { markMigrated, migrateStoredKeys, migrationPlan, storageKeys, writeCourseSlice, type CourseSlice } from './local-stores.js';
import type { CorrectionsView } from '../../shared/corrections.js';

type RecordValue = Record<string, unknown>;
type Course = { id: string; name: string; subjectCode: string; term?: string };
type Kind = 'exam' | 'quiz' | 'assignment' | 'presentation' | 'participation' | 'hurdle' | 'ungraded' | 'unknown';
type Assessment = { key: string; name: string; due: string; weight: string; weightValue?: number; sourceZero: boolean; kind: Kind; score?: number; outOf?: number; group: string; parent: string; status: string; link: string; sources: { platform: string; link: string }[]; caution: boolean; hurdle: boolean; ungraded?: boolean; bonus?: boolean; rule?: string; scoring?: 'none' | 'points' | 'weighted'; unsourced?: ('weight' | 'rule')[]; weightQuote?: string; ruleQuote?: string };
type Correction = { kind?: Kind; nature?: 'regular' | 'ungraded' | 'bonus' | 'alternative'; weight?: number | null; due?: string | null; name?: string; score?: number | null; outOf?: number | null; parent?: string; status?: string; link?: string; mergeInto?: string; bonus?: boolean; rule?: string; scoring?: 'none' | 'points' | 'weighted'; hidden?: boolean };
type CourseData = { course: Course; assessments: Assessment[]; materials: RecordValue[]; available: boolean };
type ParentAssessment = { name: string; displayName?: string; kind?: Kind; weight?: number; children: Assessment[]; scoringRule: string; score?: number; outOf?: number; status?: string; due?: string; sourceKey?: string; weightUnsourced?: boolean; weightQuote?: string };
export type SidebarCourse = { id: string; code: string; name: string; graded?: number };
// `due` is the deadline; `spent` and `done` record actual time (older entries have neither). courseId '' is a personal task.
type Work = { key: string; courseId: string; courseCode: string; title: string; due: string; minutes: number; spent?: number; done?: boolean };
const workKey = storageKeys.work;
const correctionKey = storageKeys.corrections;
const manualKey = storageKeys.manual;
const orderKey = storageKeys.order;
const targetKey = 'coursework.local-planning.targets.v1';
const availabilityKey = 'coursework.local-planning.availability.v1';
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
    return Array.isArray(value) ? value.filter(item => item && typeof item.key === 'string' && typeof item.courseId === 'string' && typeof item.courseCode === 'string' && typeof item.title === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due) && typeof item.minutes === 'number' && Number.isFinite(item.minutes) && item.minutes > 0).map(item => ({ ...item, spent: typeof item.spent === 'number' && Number.isFinite(item.spent) && item.spent >= 0 ? item.spent : undefined, done: item.done === true })) : [];
  } catch { return []; }
}
function readStore<T>(key: string): Record<string, T> { try { return record(JSON.parse(localStorage.getItem(key) ?? '{}')) as Record<string, T>; } catch { return {}; } }
type Stores = { corrections: Record<string, Correction>; manual: Record<string, Assessment[]>; order: Record<string, string[]> };
const courseOfKey = (key: string) => /^(\d{1,20}):/.exec(key)?.[1];
// One course's part of the three stores that live in `.local/corrections/` once the course is migrated (decision #294).
function sliceOf(stores: Stores, courseId: string): CourseSlice {
  return { corrections: Object.fromEntries(Object.entries(stores.corrections).filter(([key]) => courseOfKey(key) === courseId)),
    manual: Array.isArray(stores.manual[courseId]) ? stores.manual[courseId] : [], order: Array.isArray(stores.order[courseId]) ? stores.order[courseId] : [] };
}
function withSlice(stores: Stores, courseId: string, slice: CourseSlice): Stores {
  const manual = { ...stores.manual }, order = { ...stores.order };
  delete manual[courseId]; delete order[courseId];
  if (slice.manual.length) manual[courseId] = slice.manual as Assessment[];
  if (slice.order.length) order[courseId] = slice.order;
  return { corrections: { ...Object.fromEntries(Object.entries(stores.corrections).filter(([key]) => courseOfKey(key) !== courseId)), ...slice.corrections as Record<string, Correction> }, manual, order };
}
function changedCourses(before: Stores, after: Stores): string[] {
  const ids = new Set([...Object.keys(before.corrections), ...Object.keys(after.corrections)].flatMap(key => courseOfKey(key) ?? []));
  for (const id of [...Object.keys(before.manual), ...Object.keys(after.manual), ...Object.keys(before.order), ...Object.keys(after.order)]) if (/^\d{1,20}$/.test(id)) ids.add(id);
  return [...ids].filter(id => JSON.stringify(sliceOf(before, id)) !== JSON.stringify(sliceOf(after, id)));
}
const viewSlice = (view: CorrectionsView): CourseSlice => ({ corrections: view.corrections, manual: view.manual, order: view.order });
// The calendar day of a due value for a date input: a date-only value as is, a date-time as its Melbourne day.
function dateInput(due: string | undefined): string | undefined {
  if (!due) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const date = new Date(due);
  return Number.isNaN(date.getTime()) ? undefined : localDay(date);
}
function readAvailability(): number[] { try { return parseAvailability(JSON.parse(localStorage.getItem(availabilityKey) ?? 'null')); } catch { return parseAvailability(null); } }
function localDay(date = new Date()): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function addDays(day: string, count: number): string { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10); }
function normalize(course: Course, value: unknown): CourseData {
  const parsed = CourseDocumentSchema.safeParse(value);
  if (!parsed.success || parsed.data.course.id !== course.id) return { course, assessments: [], materials: [], available: false };
  const doc = toDisplayDocument(parsed.data);
  const assessments: Assessment[] = doc.assessments.map(item => ({
    key: `${course.id}:${item.id}`, name: item.name,
    kind: item.kind === 'test' ? 'exam' : item.kind === 'other' ? 'unknown' : item.kind,
    due: item.due ?? '', weight: item.weight === null ? '' : `${item.weight}%`, weightValue: item.weight ?? undefined,
    sourceZero: item.weight === 0, score: item.score ?? undefined, outOf: item.maxScore ?? undefined,
    group: '', parent: item.parentId ? `${course.id}:${item.parentId}` : '', status: item.status === 'unknown' ? '' : item.status,
    link: item.sources.find(source => source.url)?.url ?? '', sources: item.sources.flatMap(source => source.url ? [{ platform: source.platform, link: source.url }] : []),
    caution: item.nature === 'alternative', hurdle: item.kind === 'hurdle', ungraded: item.nature === 'ungraded', bonus: item.nature === 'bonus', rule: item.rule ?? '', scoring: item.scoring,
    unsourced: item.unsourced, weightQuote: item.weightQuote ?? undefined, ruleQuote: item.ruleQuote ?? undefined,
  }));
  return { course, assessments, materials: doc.materials.map(item => ({ 名称: item.name, 链接: item.url })), available: true };
}
// A correction that supplies a value removes the 「无出处」 tag; a quote is shown only while the value is the synced one.
function correctedSources(item: Assessment, change: RecordValue): Pick<Assessment, 'unsourced' | 'weightQuote' | 'ruleQuote'> {
  const weight = number(change.weight);
  const weightSupplied = weight !== undefined && weight >= 0 && weight <= 100;
  const ruleSupplied = typeof change.rule === 'string' && change.rule.trim() !== '';
  const weightChanged = change.weight === null ? item.weightValue !== undefined : weightSupplied && weight !== item.weightValue;
  const ruleChanged = typeof change.rule === 'string' && change.rule.trim() !== (item.rule ?? '').trim();
  return {
    unsourced: item.unsourced?.filter(field => !(field === 'weight' ? weightSupplied : ruleSupplied)),
    weightQuote: weightChanged ? undefined : item.weightQuote, ruleQuote: ruleChanged ? undefined : item.ruleQuote,
  };
}
function assessmentParents(_course: CourseData, visible: Assessment[]): ParentAssessment[] {
  return visible.flatMap(source => {
    const children = visible.filter(item => item.parent === source.key && !item.caution);
    return children.length ? [{ name: source.key, displayName: source.name, sourceKey: source.key, weight: source.weightValue,
      kind: source.kind, children, scoringRule: source.scoring ?? 'none', score: source.score, outOf: source.outOf, status: source.status, due: source.due,
      weightUnsourced: source.unsourced?.includes('weight') ?? false, weightQuote: source.weightQuote }] : [];
  });
}
const ringLength = 439.8;
const averageText = (value: number) => `${value.toFixed(1)}%`;
const weightText = (value: number) => `${value.toFixed(2).replace(/\.00$/, '')}%`;
// Contract v2: a weight or rule the sync could not trace to the collected data is shown as 「无出处」 (decision #247).
function Unsourced({ zh }: { zh: boolean }) {
  return <span className="unsourced" title={zh ? '同步时没有在采集到的课程数据里找到依据，可自行核对后修正' : 'The sync found no source for this in the collected course data; check it and correct it if needed'}>{zh ? '无出处' : 'No source'}</span>;
}
function readTargets(): Record<string, Band> {
  try { const value = record(JSON.parse(localStorage.getItem(targetKey) ?? '{}')); return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Band] => typeof entry[1] === 'string' && entry[1] in bandTargets)); }
  catch { return {}; }
}
function ScoreOverview({ assessments, parents, identified, zh, animateKey }: { assessments: Assessment[]; parents: ParentAssessment[]; identified: number; zh: boolean; animateKey: string }) {
  // The chosen band is remembered per course; animateKey is the course id.
  const [target, setTargetState] = useState<Band>(() => readTargets()[animateKey] ?? 'H1');
  useEffect(() => { setTargetState(readTargets()[animateKey] ?? 'H1'); }, [animateKey]);
  const setTarget = (band: Band) => { setTargetState(band); try { localStorage.setItem(targetKey, JSON.stringify({ ...readTargets(), [animateKey]: band })); } catch { /* Kept for this view only. */ } };
  const { weight, earned, average } = calculateGrades(assessments, parents);
  const needed = finalNeeded({ earned, weight }, bandTargets[target]);
  const neededText = needed.status === 'secured' ? (zh ? '已稳' : 'Secured') : needed.status === 'unreachable' ? (zh ? '已无法达到' : 'Out of reach') : `${needed.percent.toFixed(1)}%`;
  const missing = Number((100 - identified).toFixed(2));
  // The earned arc draws in from zero and the two facts count up when a course opens; edits apply at once.
  const earnedRing = useRef<SVGCircleElement>(null);
  const offset = ringLength - Math.min(earned, 100) * 4.398;
  useLayoutEffect(() => {
    if (reducedMotion()) return;
    earnedRing.current?.animate([{ strokeDashoffset: ringLength }, { strokeDashoffset: offset }], { duration: 700, easing: easeOut });
  }, [animateKey]);
  const averageShown = useCountUp(average, averageText, animateKey);
  const weightShown = useCountUp(weight || undefined, weightText, animateKey);
  return <section className="score" aria-label={zh ? '分数构成' : 'Score structure'}>
    <svg className="donut" viewBox="0 0 170 170" role="img" aria-label={zh ? '已得成绩' : 'Earned grades'}>
      <circle className="track" cx="85" cy="85" r="70" />
      {weight > 0 && <circle ref={earnedRing} className="earned" cx="85" cy="85" r="70" strokeDasharray={`${ringLength} ${ringLength}`} strokeDashoffset={offset} transform="rotate(-90 85 85)" />}
      <text x="85" y="90" className="total">{weight ? earned.toFixed(1) : '—'}</text><text x="85" y="110" className="caption">{zh ? '已得 / 100' : 'earned / 100'}</text>
    </svg>
    <div><div className="facts">
      <div><div className="muted">{zh ? '当前平均' : 'Current average'}</div><div className="v">{averageShown}</div></div>
      <div><div className="muted">{zh ? '已出分占比' : 'Graded weight'}</div><div className="v">{weightShown}</div></div>
      <div><label className="inline muted">{zh ? '期末需要 · 目标' : 'Final needed · target'} <select value={target} onChange={event => setTarget(event.target.value as Band)}>{(Object.keys(bandTargets) as Band[]).map(band => <option key={band} value={band}>{band} · {bandTargets[band]}</option>)}</select></label>
        <div className="v needed" title={zh ? '剩余未出分部分平均需要的得分率' : 'Average needed across the weight not yet marked'}>{needed.status === 'unreachable' && <i className="signal" aria-hidden="true" />}{neededText}</div>
        {needed.status === 'reachable' && <small className="muted">{zh ? '剩余部分平均' : 'avg. on the rest'}</small>}
        {missing > 0 && <small className="muted block">{zh ? `另有 ${missing}% 权重未识别，按待出分计算` : `${missing}% of weight is unidentified and counted as remaining`}</small>}</div>
    </div><div className="key"><span><i className="earned" />{zh ? '已得' : 'Earned'}</span><span><i className="not-earned" />{zh ? '未得' : 'Not earned'}</span></div></div>
  </section>;
}

function weightRows(assessments: Assessment[], parents: ParentAssessment[]) {
  return assessments.filter(item => !item.parent && !item.bonus && !item.ungraded && !item.caution).flatMap(item => {
    const parent = parents.find(group => group.sourceKey === item.key);
    const weight = parent ? parent.weight : item.weightValue;
    return weight !== undefined && weight > 0 ? [{ key: item.key, name: parent?.displayName || item.name, weight }] : [];
  });
}
// Counted top-level items whose weight was cleared as unsourced and not supplied by a correction.
function unsourcedWeightRows(assessments: Assessment[], parents: ParentAssessment[]) {
  return assessments.filter(item => !item.parent && !item.bonus && !item.ungraded && !item.caution).flatMap(item => {
    const parent = parents.find(group => group.sourceKey === item.key);
    const unsourced = parent ? parent.weightUnsourced && parent.weight === undefined : item.unsourced?.includes('weight') && item.weightValue === undefined;
    return unsourced ? [{ key: item.key, name: parent?.displayName || item.name }] : [];
  });
}
const identifiedWeight = (assessments: Assessment[], parents: ParentAssessment[]) => weightRows(assessments, parents).reduce((sum, item) => sum + item.weight, 0);
function WeightBreakdown({ assessments, parents, zh }: { assessments: Assessment[]; parents: ParentAssessment[]; zh: boolean }) {
  const rows = weightRows(assessments, parents);
  const total = rows.reduce((sum, item) => sum + item.weight, 0);
  let used = 0;
  return <section className="weight-breakdown"><h2>{zh ? '分数占比' : 'Assessment weights'}</h2><div className="weight-bar-row"><div className="weight-bar" role="img" aria-label={`${zh ? '已识别课程占比' : 'Identified weight'} ${total}/100`}>
    {rows.map((item, index) => { const width = Math.max(0, Math.min(item.weight, 100 - used)); used += item.weight; return <span key={item.key} className={`weight-segment weight-color-${index % 6}`} style={{ width: `${width}%`, '--i': index } as CSSProperties} title={`${item.name}: ${item.weight}%`} />; })}
    </div><strong>{Number(total.toFixed(2))}/100</strong></div><div className="weight-legend">{rows.map((item, index) => <span key={item.key}><i className={`weight-color-${index % 6}`} />{item.name} {item.weight}%</span>)}
      {unsourcedWeightRows(assessments, parents).map(item => <span key={item.key} className="unsourced-row"><i aria-hidden="true" />{item.name} —<Unsourced zh={zh} /></span>)}</div></section>;
}

export function LocalPlanning({ language, refreshVersion, courseId, onCourse, onBack, onCourses, onAsk, syncIssues }: { language: Language; refreshVersion: number; courseId?: string; onCourse: (id: string) => void; onBack: () => void; onCourses?: (courses: SidebarCourse[]) => void; onAsk?: (courseId: string, prompt?: string) => void; syncIssues: { id: string; status: string; reason: string }[] }) {
  const zh = language === 'zh';
  const [courses, setCourses] = useState<CourseData[]>([]);
  const [error, setError] = useState('');
  const [work, setWork] = useState<Work[]>(readWork);
  const [corrections, setCorrections] = useState<Record<string, Correction>>(() => readStore<Correction>(correctionKey));
  const [manual, setManual] = useState<Record<string, Assessment[]>>(() => readStore<Assessment[]>(manualKey));
  const [order, setOrder] = useState<Record<string, string[]>>(() => readStore<string[]>(orderKey));
  const [adding, setAdding] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [availability, setAvailability] = useState<number[]>(readAvailability);
  const [editingHours, setEditingHours] = useState(false);
  const [week, setWeek] = useState(() => { const today = localDay(); return addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7)); });
  const [chosen, setChosen] = useState<Assessment>();
  const [chosenSiblings, setChosenSiblings] = useState<string[]>();
  const kindName: Record<Kind, string> = zh ? { exam: '考试', quiz: '测验', assignment: '作业', presentation: '展示', participation: '参与', hurdle: 'Hurdle', ungraded: '不计分', unknown: '其他' } : { exam: 'Exam', quiz: 'Quiz', assignment: 'Assignment', presentation: 'Presentation', participation: 'Participation', hurdle: 'Hurdle', ungraded: 'Ungraded', unknown: 'Other' };
  const groupName: Record<Kind, string> = zh ? { exam: '考试', quiz: '测验', assignment: '作业', presentation: '展示', participation: '参与', hurdle: 'Hurdle', ungraded: '其他项目', unknown: '其他' } : { exam: 'Exams', quiz: 'Quizzes', assignment: 'Assignments', presentation: 'Presentations', participation: 'Participation', hurdle: 'Hurdles', ungraded: 'Other items', unknown: 'Other' };
  // A score reads as a percentage when its maximum is known; the points stay in the drawer.
  const scoreText = (score: number, outOf?: number) => outOf ? `${Number((score / outOf * 100).toFixed(1))}%` : `${Number(score.toFixed(2))}`;
  const dueDate = (due: string): Date | undefined => { if (!due) return undefined; const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T12:00:00Z` : due); return Number.isNaN(date.getTime()) ? undefined : date; };
  const shortDue = (due: string) => { const date = dueDate(due); return !due ? '—' : !date ? due : new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', timeZone: 'Australia/Melbourne' }).format(date); };
  const longDue = (due: string) => { const date = dueDate(due); if (!due) return zh ? '未知' : 'Unknown'; if (!date) return due;
    return new Intl.DateTimeFormat(language, /^\d{4}-\d{2}-\d{2}$/.test(due) ? { dateStyle: 'medium', timeZone: 'Australia/Melbourne' } : { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Melbourne' }).format(date); };
  const [mode, setMode] = useState<'plan' | 'month'>('plan');
  const [courseTab, setCourseTab] = useState<'assessments' | 'revision'>('assessments');
  const [saveError, setSaveError] = useState(false);
  // Corrections of migrated courses are saved to `.local/corrections/` (decisions #294, #295); the rest stay in localStorage.
  const [correctionsNotice, setCorrectionsNotice] = useState<'' | 'save' | 'refreshed' | 'unavailable'>('');
  const latest = useRef<Stores>({ corrections, manual, order });
  const localCourses = useRef(new Set<string>());
  const revisions = useRef<Record<string, number>>({});
  const confirmed = useRef<Record<string, CourseSlice>>({});
  const sending = useRef(new Map<string, Promise<void>>());
  const [notes, setNotes] = useState<RevisionNote[]>();
  const [notesError, setNotesError] = useState(false);
  // A response for a course the owner has already left is dropped, so one course never shows another's notes.
  const notesFor = useRef<string | undefined>(undefined);
  notesFor.current = courseTab === 'revision' ? courseId : undefined;
  async function loadNotes(id: string) {
    try {
      const response = await fetch(`/api/local/revision-notes?courseId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const data = (await response.json()) as { notes: RevisionNote[] };
      if (notesFor.current === id) { setNotes(data.notes); setNotesError(false); }
    } catch { if (notesFor.current === id) { setNotes([]); setNotesError(true); } }
  }
  useEffect(() => { setNotes(undefined); if (courseId && courseTab === 'revision') void loadNotes(courseId); }, [courseId, courseTab]);
  async function removeNote(note: RevisionNote) {
    if (!window.confirm(zh ? `删除复习笔记「${note.title || '笔记'}」？` : `Delete the revision note "${note.title || 'Note'}"?`)) return;
    try { const response = await fetch(`/api/local/revision-notes/${note.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }); if (!response.ok && response.status !== 404) throw new Error('failed'); }
    catch { setNotesError(true); }
    if (courseId) void loadNotes(courseId);
  }
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const response = await fetch('/api/local/course-reports', { cache: 'no-store' });
        if (!response.ok) throw new Error('unavailable');
        const data: { courses: Course[]; reports: { id: string; report: unknown }[] } = await response.json();
        let ids: string[] = [];
        try { const selected: unknown = JSON.parse(localStorage.getItem('coursework.selected-course-ids') ?? '[]'); if (Array.isArray(selected)) ids = selected.filter((id): id is string => typeof id === 'string'); } catch { /* No saved selection. */ }
        if (!live) return;
        // Contract v2 (decision #278): move local keys to the new assessment IDs once, before anything reads them.
        const migrations = data.reports.flatMap(item => { const parsed = CourseDocumentSchema.safeParse(item.report);
          return parsed.success && parsed.data.version === 2 && parsed.data.course.id === item.id ? [{ courseId: item.id, legacyIds: parsed.data.legacyIds }] : []; });
        const migrated = migrateStoredKeys(localStorage, migrations);
        if (migrated.changed) { setCorrections(readStore<Correction>(correctionKey)); setManual(readStore<Assessment[]>(manualKey)); setOrder(readStore<string[]>(orderKey)); setWork(readWork()); }
        if (migrated.failed) setSaveError(true);
        await loadCorrections();
        if (!live) return;
        setCourses(data.courses.filter(course => ids.includes(course.id)).map(course => normalize(course, data.reports.find(item => item.id === course.id)?.report))); setError('');
      } catch { if (live) setError(zh ? '无法读取本地课程数据，请先同步课程。' : 'Could not load local course data. Sync courses first.'); }
    }
    void load(); return () => { live = false; };
  }, [refreshVersion, zh]);
  // One-time import of each course's browser data, then the `.local/` views; courses whose import has not succeeded keep
  // using localStorage. The browser copy is never deleted (decision #294).
  async function loadCorrections() {
    for (const { courseId: id, slice } of migrationPlan(localStorage).imports) {
      try {
        const response = await fetch(`/api/local/corrections/${id}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(slice) });
        const body: unknown = response.ok ? await response.json() : null;
        if (body && typeof (body as { imported?: unknown }).imported === 'boolean') markMigrated(localStorage, id);
      } catch { /* Retried on the next load; the course keeps using localStorage. */ }
    }
    const plan = migrationPlan(localStorage);
    localCourses.current = new Set(plan.local);
    let next: Stores = { corrections: {}, manual: {}, order: {} };
    const stored: Stores = { corrections: readStore<Correction>(correctionKey), manual: readStore<Assessment[]>(manualKey), order: readStore<string[]>(orderKey) };
    for (const id of plan.local) next = withSlice(next, id, sliceOf(stored, id));
    revisions.current = {}; confirmed.current = {};
    let notice: typeof correctionsNotice = '';
    try {
      const response = await fetch('/api/local/corrections', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const data = (await response.json()) as { courses: Record<string, CorrectionsView | { error: string }> };
      for (const [id, view] of Object.entries(data.courses)) {
        if (localCourses.current.has(id)) continue;
        if ('error' in view) { notice = 'unavailable'; continue; }
        revisions.current[id] = view.revision; confirmed.current[id] = viewSlice(view);
        next = withSlice(next, id, viewSlice(view));
      }
    } catch { notice = 'unavailable'; }
    latest.current = next; setCorrections(next.corrections); setManual(next.manual); setOrder(next.order);
    setCorrectionsNotice(notice);
  }
  const original = courses.find(item => item.course.id === courseId);
  // Owner corrections, grouping and grading inputs are shared by the course page and the course rail rings.
  const withCorrections = (original: CourseData) => ({ ...original, assessments: [...original.assessments, ...(Array.isArray(manual[original.course.id]) ? manual[original.course.id] : [])].map(item => {
    const change = record(corrections[item.key]); const overrideWeight = number(change.weight);
    const validKind = ['exam', 'quiz', 'assignment', 'presentation', 'participation', 'hurdle', 'ungraded', 'unknown'].includes(String(change.kind)) ? change.kind as Kind : item.kind;
    return { ...item, kind: validKind, ...correctedSources(item, change), ...(typeof change.name === 'string' && change.name ? { name: change.name } : {}),
      ...(change.weight === null ? { weightValue: undefined, weight: '', sourceZero: false } : overrideWeight !== undefined && overrideWeight >= 0 && overrideWeight <= 100 ? { weightValue: overrideWeight, weight: `${overrideWeight}%`, sourceZero: overrideWeight === 0 } : {}),
      ...(change.score === null ? { score: undefined } : number(change.score) !== undefined ? { score: number(change.score) } : {}),
      ...(change.outOf === null ? { outOf: undefined } : number(change.outOf) !== undefined ? { outOf: number(change.outOf) } : {}),
      ...(typeof change.parent === 'string' ? { parent: change.parent } : {}), ...(typeof change.status === 'string' ? { status: change.status } : {}),
      ...(typeof change.nature === 'string' ? { bonus: change.nature === 'bonus', caution: change.nature === 'alternative', ungraded: change.nature === 'ungraded' } : typeof change.bonus === 'boolean' ? { bonus: change.bonus } : {}), ...(typeof change.rule === 'string' ? { rule: change.rule } : {}),
      ...(typeof change.link === 'string' ? { link: url(change.link) } : {}),
      ...(change.due === null ? { due: '' } : typeof change.due === 'string' ? { due: change.due } : {}) };
  }) });
  const visibleItems = (course: CourseData) => course.assessments.filter(item => !corrections[item.key]?.mergeInto && !corrections[item.key]?.hidden && !(item.parent && corrections[item.parent]?.hidden));
  const groupParents = (course: CourseData, items: Assessment[]) => assessmentParents(course, items).map(parent => {
    const change = corrections[`${course.course.id}:group:${parent.name}`];
    return change ? { ...parent, displayName: change.name || parent.displayName || parent.name, kind: change.kind ?? parent.kind, scoringRule: change.scoring ?? parent.scoringRule, weight: change.weight === null ? undefined : change.weight ?? parent.weight,
      score: change.score === null ? undefined : change.score ?? parent.score, outOf: change.outOf === null ? undefined : change.outOf ?? parent.outOf, status: change.status ?? parent.status, due: change.due === null ? undefined : change.due ?? parent.due,
      weightUnsourced: parent.weightUnsourced && typeof change.weight !== 'number', weightQuote: change.weight !== undefined && change.weight !== parent.weight ? undefined : parent.weightQuote } : parent;
  });
  const gradingInputs = (items: Assessment[], groups: ParentAssessment[]) => ({
    assessments: items.filter(item => {
      const source = item.parent ? items.find(parent => parent.key === item.parent) : undefined;
      return !item.caution && !(source && (source.bonus || source.caution || source.ungraded || source.kind === 'ungraded' || source.sourceZero));
    }),
    parents: groups.filter(parent => {
      const source = items.find(item => item.key === parent.sourceKey);
      return source && !source.bonus && !source.caution && !source.ungraded && source.kind !== 'ungraded' && !source.sourceZero;
    }),
  });
  const gradedWeight = (original: CourseData): number | undefined => {
    if (!original.available) return undefined;
    const course = withCorrections(original), items = visibleItems(course), inputs = gradingInputs(items, groupParents(course, items));
    return calculateGrades(inputs.assessments, inputs.parents).weight;
  };
  useEffect(() => { onCourses?.(courses.map(item => ({ id: item.course.id, code: item.course.subjectCode, name: item.course.name, graded: gradedWeight(item) }))); }, [courses, corrections, manual]);
  const selected = original && withCorrections(original);
  const primaryItems = selected ? visibleItems(selected) : [];
  const parents = selected ? groupParents(selected, primaryItems) : [];
  function commit(next: Stores) { latest.current = next; setCorrections(next.corrections); setManual(next.manual); setOrder(next.order); }
  // Updates the page at once; courses not yet migrated are written to localStorage, the others are sent to the server.
  function persist(next: Stores): boolean {
    const changed = changedCourses(latest.current, next);
    for (const id of changed.filter(id => localCourses.current.has(id))) if (!writeCourseSlice(localStorage, id, sliceOf(next, id))) { setSaveError(true); return false; }
    commit(next); setSaveError(false);
    for (const id of changed.filter(id => !localCourses.current.has(id))) {
      const run = (sending.current.get(id) ?? Promise.resolve()).then(() => send(id));
      sending.current.set(id, run);
    }
    return true;
  }
  // One request per course at a time, so a later edit carries the revision returned by the earlier one (decision #295).
  async function send(id: string) {
    const slice = sliceOf(latest.current, id), sent = JSON.stringify(slice);
    if (sent === JSON.stringify(confirmed.current[id] ?? { corrections: {}, manual: [], order: [] })) return;
    const adopt = (view: CorrectionsView, replace: boolean) => {
      revisions.current[id] = view.revision; confirmed.current[id] = viewSlice(view);
      if (replace) commit(withSlice(latest.current, id, viewSlice(view)));
    };
    try {
      const response = await fetch(`/api/local/corrections/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: revisions.current[id] ?? 0, ...slice }) });
      const body = await response.json().catch(() => null) as (CorrectionsView & { current?: CorrectionsView }) | null;
      if (response.ok && body && typeof body.revision === 'number') {
        // Take the server's normalised copy unless a newer edit is already waiting to be sent.
        adopt(body, JSON.stringify(sliceOf(latest.current, id)) === sent);
        setCorrectionsNotice(notice => notice === 'save' ? '' : notice);
        return;
      }
      if (response.status === 409 && body?.current) { adopt(body.current, true); setCorrectionsNotice('refreshed'); return; }
      throw new Error('save failed');
    } catch {
      commit(withSlice(latest.current, id, confirmed.current[id] ?? { corrections: {}, manual: [], order: [] }));
      setCorrectionsNotice('save');
    }
  }
  function saveCorrections(next: Record<string, Correction>): boolean { return persist({ ...latest.current, corrections: next }); }
  function saveManual(next: Record<string, Assessment[]>): boolean { return persist({ ...latest.current, manual: next }); }
  function move(key: string, siblings: string[], direction: number) {
    if (!courseId) return; const index = siblings.indexOf(key); const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= siblings.length) return;
    const reordered = [...siblings]; [reordered[index], reordered[destination]] = [reordered[destination]!, reordered[index]!];
    const existing = Array.isArray(order[courseId]) ? order[courseId] : [];
    const next = { ...order, [courseId]: [...existing.filter(id => !reordered.includes(id)), ...reordered] };
    persist({ ...latest.current, order: next });
  }
  function sorted<T>(items: T[], key: (item: T) => string): T[] {
    const ranks = courseId && Array.isArray(order[courseId]) ? order[courseId] : [];
    return [...items].sort((a, b) => { const x = ranks.indexOf(key(a)), y = ranks.indexOf(key(b)); return (x < 0 ? Infinity : x) - (y < 0 ? Infinity : y); });
  }
  const inScope = (item: Work) => item.courseId === '' || courses.some(course => course.course.id === item.courseId);
  const codeOfWork = (item: Work) => item.courseId === '' ? (zh ? '校外' : 'Personal') : item.courseCode;
  function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget); const title = String(data.get('title') ?? '').trim(); const due = String(data.get('due') ?? ''); const minutes = Number(data.get('minutes'));
    const course = courses.find(item => item.course.id === String(data.get('course') ?? ''));
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(minutes) || minutes <= 0 || minutes > 100000) return;
    if (saveWork([...work, { key: `task:${crypto.randomUUID()}`, courseId: course?.course.id ?? '', courseCode: course?.course.subjectCode ?? '', title, due, minutes }])) setAddingTask(false);
  }
  // Decision #237: the schedule is recomputed from tasks, spent time and availability; nothing about it is stored.
  const today = localDay();
  const plan = useMemo(() => schedulePlan(work.filter(inScope), availability, today), [work, courses, availability, today]);
  function saveWork(next: Work[]): boolean { try { localStorage.setItem(workKey, JSON.stringify(next)); setWork(next); setSaveError(false); return true; } catch { setSaveError(true); return false; } }
  function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !chosen) return;
    const data = new FormData(event.currentTarget); const due = String(data.get('due') ?? ''); const minutes = Number(data.get('minutes'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(minutes) || minutes <= 0 || minutes > 100000) return;
    // Re-planning changes the deadline and estimate only; recorded time and the done state carry over.
    const existing = work.find(item => item.key === chosen.key);
    if (saveWork([...work.filter(item => item.key !== chosen.key), { key: chosen.key, courseId: selected.course.id, courseCode: selected.course.subjectCode, title: chosen.name, due, minutes, spent: existing?.spent, done: existing?.done }])) setChosen(undefined);
  }
  // Assessment rows rise in with a short stagger when a course (or its list tab) opens, not on later edits.
  const assessmentList = useRef<HTMLDivElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const tabIndicator = useRef<HTMLSpanElement>(null);
  const listKey = selected && courseTab === 'assessments' ? `${selected.course.id}` : '';
  useLayoutEffect(() => {
    if (!listKey || reducedMotion()) return;
    assessmentList.current?.querySelectorAll(':scope > .kind-block > *, :scope > .no-marks').forEach((row, index) => {
      row.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: durations.medium, delay: Math.min(index * 25, 300), easing: easeOut, fill: 'backwards' });
    });
  }, [listKey]);
  useSlidingIndicator(tabList, tabIndicator, '[aria-selected="true"]', 'x', [courseTab, courseId, !!selected]);
  // The drawer slides out before it unmounts.
  const [drawerClosing, setDrawerClosing] = useState(false);
  const drawerTimer = useRef<number | undefined>(undefined);
  const cancelDrawerClose = () => { window.clearTimeout(drawerTimer.current); drawerTimer.current = undefined; };
  useEffect(() => cancelDrawerClose, []);
  const openDrawer = (item: Assessment, siblings: string[] | undefined) => { cancelDrawerClose(); setDrawerClosing(false); setChosen(item); setChosenSiblings(siblings); };
  const closeDrawer = () => {
    if (drawerTimer.current !== undefined) return;
    const finish = () => { drawerTimer.current = undefined; setChosen(undefined); setChosenSiblings(undefined); setDrawerClosing(false); };
    if (reducedMotion()) finish(); else { setDrawerClosing(true); drawerTimer.current = window.setTimeout(finish, durations.short + 30); }
  };
  if (courseId) return <div className="course-page">
    <button className="crumb" onClick={onBack}>← {zh ? '计划' : 'Plan'}</button>
    {error && <p className="needs">{error}</p>}
    {selected ? <>
      <div className="chead"><h1>{selected.course.subjectCode}</h1><span className="muted">{selected.course.name}</span><small>{selected.course.term}</small>
        {onAsk && <button className="small ask-agent" onClick={() => onAsk(selected.course.id)}>{zh ? '问 Agent' : 'Ask Agent'}</button>}</div>
      {!selected.available && <p className="needs">{zh ? '这门课尚无可用的同步结果。' : 'No sync result is available for this course yet.'}</p>}
      {syncIssues.filter(item => item.id === selected.course.id && item.status === 'failed').map(item => <p className="needs" key={item.id}>{zh ? '最近一次同步未完成，正在显示已保存的课程信息。' : 'The latest sync failed. Showing saved course information.'}</p>)}
      {selected.available && <div className="course-summary card">
        <ScoreOverview {...gradingInputs(primaryItems, parents)} identified={identifiedWeight(primaryItems, parents)} zh={zh} animateKey={selected.course.id} />
        <WeightBreakdown assessments={primaryItems} parents={parents} zh={zh} />
      </div>}
      <div className="tabs" role="tablist" ref={tabList}><span className="tab-indicator" ref={tabIndicator} aria-hidden="true" /><button role="tab" aria-selected={courseTab === 'assessments'} onClick={() => setCourseTab('assessments')}>{zh ? '考核' : 'Assessments'}</button><button role="tab" aria-selected={courseTab === 'revision'} onClick={() => setCourseTab('revision')}>{zh ? '复习' : 'Revision'}</button></div>
      {courseTab === 'assessments' ? <div className="assessment-list" ref={assessmentList}>
        <div className="list-tools"><button className="small" onClick={() => setAdding(value => !value)}>{adding ? (zh ? '取消' : 'Cancel') : (zh ? '新增考核' : 'Add assessment')}</button></div>
        {adding && <form className="local-confirm" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const name = String(data.get('name') ?? '').trim(); if (!name) return;
          const kind = String(data.get('kind') ?? 'unknown') as Kind; const weightText = String(data.get('weight') ?? '').trim(); const weight = weightText ? Number(weightText) : undefined;
          if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 100)) return;
          const scoreText = String(data.get('score') ?? '').trim(); const maxText = String(data.get('outOf') ?? '').trim(); const score = scoreText ? Number(scoreText) : undefined; const outOf = maxText ? Number(maxText) : undefined;
          if ((score !== undefined && (!Number.isFinite(score) || score < 0)) || (outOf !== undefined && (!Number.isFinite(outOf) || outOf < 0)) || (score !== undefined && outOf !== undefined && score > outOf)) return;
          const item: Assessment = { key: `${selected.course.id}:manual:${crypto.randomUUID()}`, name, kind, due: String(data.get('due') ?? ''), weight: weight === undefined ? '' : `${weight}%`, weightValue: weight, sourceZero: weight === 0, score, outOf, group: '', parent: String(data.get('parent') ?? '').trim(), status: '', link: url(data.get('link')), sources: [], hurdle: kind === 'hurdle', ungraded: data.get('nature') === 'ungraded', bonus: data.get('nature') === 'bonus', caution: data.get('nature') === 'alternative' };
          if (saveManual({ ...manual, [selected.course.id]: [...(manual[selected.course.id] ?? []), item] })) setAdding(false);
        }}><label>{zh ? '名称' : 'Name'}<input name="name" required /></label><label>{zh ? '类型' : 'Type'}<select name="kind"><option value="assignment">{zh ? '作业' : 'Assignment'}</option><option value="quiz">Quiz</option><option value="exam">Test</option><option value="presentation">{zh ? '展示' : 'Presentation'}</option><option value="participation">{zh ? '参与' : 'Participation'}</option><option value="hurdle">Hurdle</option></select></label><label>{zh ? '性质' : 'Nature'}<select name="nature"><option value="regular">{zh ? '普通考核' : 'Regular'}</option><option value="bonus">{zh ? '加分' : 'Bonus'}</option><option value="ungraded">{zh ? '不计分' : 'Ungraded'}</option><option value="alternative">{zh ? '替代考试' : 'Alternative'}</option></select></label><label>{zh ? '占比 %' : 'Weight %'}<input type="number" name="weight" min="0" max="100" step="any" /></label><label>{zh ? '得分' : 'Score'}<input type="number" name="score" min="0" step="any" /></label><label>{zh ? '满分' : 'Out of'}<input type="number" name="outOf" min="0" step="any" /></label><label>{zh ? '截止日期' : 'Due date'}<input type="date" name="due" /></label><label>{zh ? '归属' : 'Parent'}<select name="parent"><option value="">{zh ? '无' : 'None'}</option>{primaryItems.filter(item => !item.parent).map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label><label>{zh ? '链接' : 'Link'}<input type="url" name="link" /></label><button type="submit">{zh ? '保存' : 'Save'}</button></form>}
        {!selected.assessments.length && <p className="muted">{zh ? '暂未获取考核项目。' : 'No assessments found yet.'}</p>}
        {(() => {
          const kinds: Kind[] = ['quiz', 'assignment', 'exam', 'presentation', 'participation', 'hurdle', 'unknown', 'ungraded'];
          const visible = primaryItems;
          const childKeys = new Set(parents.flatMap(parent => [...parent.children.map(item => item.key), ...(parent.sourceKey ? [parent.sourceKey] : [])]));
          // One row per assessment, as in the 10-15 prototype: name and type, weight, score (or due date), status. Details open in the drawer.
          const row = (item: Assessment, siblings: string[]) => <button key={item.key} className="arow" onClick={() => openDrawer(item, siblings)}>
            <span className="aname">{item.name}{item.kind !== 'unknown' && item.kind !== 'ungraded' && <span className={`kind ${item.kind}`}>{kindName[item.kind]}</span>}{item.bonus && <span className="kind">{zh ? '加分' : 'Bonus'}</span>}{work.some(entry => entry.key === item.key) && <span className="planned">{zh ? '已排期' : 'Planned'}</span>}</span>
            <span className="num">{item.bonus ? (item.outOf !== undefined ? `≤ ${item.outOf} ${zh ? '分' : 'pts'}` : '—') : item.sourceZero ? '0%' : item.weight || '—'}{item.unsourced?.includes('weight') && <Unsourced zh={zh} />}</span>
            <span className="num muted">{item.score !== undefined ? scoreText(item.score, item.outOf) : shortDue(item.due)}</span>
            <span className="muted">{statusLabel(corrections[item.key]?.status || item.status || (item.score !== undefined ? 'graded' : 'unknown'), zh)}</span></button>;
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
          // A parent with child items folds in place; the chevron and the item count say that it opens.
          const parentRow = (entry: { key: string; parent?: ParentAssessment }, siblingKeys: string[]) => { const parent = entry.parent!; const grade = parentGrade(parent); const children = sorted(parent.children, item => item.key); const childOrder = children.map(item => item.key);
            return <details className="assessment-parent" key={entry.key}><summary className="arow">
              <span className="aname"><i className="chevron" aria-hidden="true" />{parent.displayName || parent.name}{parent.kind && parent.kind !== 'unknown' && parent.kind !== 'ungraded' && <span className={`kind ${parent.kind}`}>{kindName[parent.kind]}</span>}<small className="count">{parent.children.length} {zh ? '项' : 'items'}</small></span>
              <span className="num">{parent.weight === undefined ? '—' : `${parent.weight}%`}{parent.weightUnsourced && <Unsourced zh={zh} />}</span>
              <span className="num muted">{grade ? scoreText(grade.score, grade.outOf) : shortDue(parent.due ?? '')}</span>
              <span className="muted">{statusLabel(parent.status || (grade ? 'graded' : 'unknown'), zh)}</span></summary>
              <div className="assessment-children">
                {children.map(item => row(item, childOrder))}
                <div className="parent-actions">
                  <button className="small ghost" onClick={() => { openDrawer({ key: entry.key, name: parent.displayName || parent.name, due: parent.due || '', weight: parent.weight === undefined ? '' : `${parent.weight}%`, sourceZero: false, kind: 'assignment', group: parent.name, status: parent.status || '', link: '', sources: [], parent: '', caution: false, hurdle: false, unsourced: parent.weightUnsourced ? ['weight'] : [], weightQuote: parent.weightQuote }, undefined); }}>{zh ? '安排整个作业' : 'Plan assignment'}</button>
                  <button className="small ghost" type="button" disabled={siblingKeys.indexOf(entry.key) <= 0} onClick={() => move(entry.key, siblingKeys, -1)}>{zh ? '上移' : 'Move up'}</button>
                  <button className="small ghost" type="button" disabled={siblingKeys.indexOf(entry.key) >= siblingKeys.length - 1} onClick={() => move(entry.key, siblingKeys, 1)}>{zh ? '下移' : 'Move down'}</button>
                  <button className="small ghost" onClick={() => saveCorrections({ ...corrections, [parent.sourceKey!]: { ...corrections[parent.sourceKey!], hidden: true } })}>{zh ? '移除' : 'Remove'}</button>
                </div>
                <details className="assessment-edit"><summary>{zh ? '编辑父考核' : 'Edit parent'}</summary><form className="local-confirm" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const name = String(data.get('name') ?? '').trim(); if (!name) return;
                  const w = String(data.get('weight') ?? '').trim(), n = String(data.get('score') ?? '').trim(), m = String(data.get('outOf') ?? '').trim(); const weight = w ? Number(w) : null, score = n ? Number(n) : null, outOf = m ? Number(m) : null;
                  if ((weight !== null && (!Number.isFinite(weight) || weight < 0 || weight > 100)) || (score !== null && (!Number.isFinite(score) || score < 0)) || (outOf !== null && (!Number.isFinite(outOf) || outOf < 0)) || (score !== null && outOf !== null && score > outOf)) return;
                  saveCorrections({ ...corrections, [parent.sourceKey!]: { ...corrections[parent.sourceKey!], nature: String(data.get('nature')) as Correction['nature'] }, [entry.key]: { ...corrections[entry.key], name, kind: String(data.get('kind')) as Kind, scoring: String(data.get('scoring')) as 'none' | 'points' | 'weighted', weight, score, outOf, due: String(data.get('due') ?? '') || null, status: String(data.get('status') ?? '').trim() } }); }}>
                  <label>{zh ? '名称' : 'Name'}<input name="name" required defaultValue={parent.displayName || parent.name} /></label><label>{zh ? '类型' : 'Type'}<select name="kind" defaultValue={parent.kind ?? 'assignment'}>{(['quiz', 'assignment', 'exam', 'presentation', 'participation', 'hurdle', 'unknown'] as Kind[]).map(value => <option key={value} value={value}>{groupName[value]}</option>)}</select></label><label>{zh ? '性质' : 'Nature'}<select name="nature" defaultValue={(() => { const source = visible.find(item => item.key === parent.sourceKey); return source?.bonus ? 'bonus' : source?.caution ? 'alternative' : source?.ungraded ? 'ungraded' : 'regular'; })()}><option value="regular">{zh ? '普通考核' : 'Regular'}</option><option value="bonus">{zh ? '加分' : 'Bonus'}</option><option value="ungraded">{zh ? '不计分' : 'Ungraded'}</option><option value="alternative">{zh ? '替代考试' : 'Alternative'}</option></select></label><label>{zh ? '占比 %' : 'Weight %'}<input type="number" min="0" max="100" step="any" name="weight" defaultValue={parent.weight} /></label><label>{zh ? '子项计分方式' : 'Child scoring'}<select name="scoring" defaultValue={parent.scoringRule}><option value="none">{zh ? '不自动汇总' : 'No aggregation'}</option><option value="points">{zh ? '按分值' : 'By points'}</option><option value="weighted">{zh ? '按各项权重' : 'By weights'}</option></select></label><label>{zh ? '得分' : 'Score'}<input type="number" min="0" step="any" name="score" defaultValue={parent.score} /></label><label>{zh ? '满分' : 'Out of'}<input type="number" min="0" step="any" name="outOf" defaultValue={parent.outOf} /></label><label>{zh ? '日期' : 'Due date'}<input type="date" name="due" defaultValue={dateInput(parent.due)} /></label><label>{zh ? '状态' : 'Status'}<input name="status" defaultValue={parent.status} /></label><button type="submit">{zh ? '保存' : 'Save'}</button></form></details>
              </div></details>; };
          const entries = (kind: Kind) => { const items = kind === 'ungraded' ? foldedItems : groupedItem(kind); const combined: { key: string; item?: Assessment; parent?: ParentAssessment }[] = [
            ...parents.filter(parent => kind === 'ungraded' ? foldedParent(parent) : !foldedParent(parent) && (parent.kind ?? 'assignment') === kind).map(parent => ({ key: `${selected.course.id}:group:${parent.name}`, parent })), ...items.map(item => ({ key: item.key, item })) ];
            return sorted(combined, entry => entry.key); };
          const render = (ordered: { key: string; item?: Assessment; parent?: ParentAssessment }[]) => { const siblingKeys = ordered.map(entry => entry.key); return ordered.map(entry => entry.item ? row(entry.item, siblingKeys) : parentRow(entry, siblingKeys)); };
          const folded = entries('ungraded');
          return <>
            {kinds.filter(kind => kind !== 'ungraded').map(kind => { const ordered = entries(kind); return ordered.length ? <div className="kind-block" key={kind} role="group" aria-label={groupName[kind]}>{render(ordered)}</div> : null; })}
            {folded.length > 0 && <details className="no-marks"><summary><i className="chevron" aria-hidden="true" />{zh ? '不计分及其他' : 'Ungraded and other'} ({folded.length})</summary>{render(folded)}</details>}
            {selected.assessments.some(item => corrections[item.key]?.hidden) && <details className="no-marks"><summary><i className="chevron" aria-hidden="true" />{zh ? '已移除' : 'Removed'} ({selected.assessments.filter(item => corrections[item.key]?.hidden).length})</summary>{selected.assessments.filter(item => corrections[item.key]?.hidden).map(item => <div className="local-group" key={item.key}><span>{item.name}</span><button className="small" onClick={() => saveCorrections({ ...corrections, [item.key]: { ...corrections[item.key], hidden: false } })}>{zh ? '恢复' : 'Restore'}</button></div>)}</details>}
          </>;
        })()}

      </div> : (() => {
        // Revision (decision #236): exams from the corrected course data, preset prompts to the agent, and saved notes.
        const exams = primaryItems.filter(item => item.kind === 'exam').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
        const code = selected.course.subjectCode;
        const examText = exams.length ? (zh ? `（${exams.map(item => item.name).join('、')}）` : ` (${exams.map(item => item.name).join(', ')})`) : '';
        const prompts = zh ? [
          { label: '让 Agent 带我复习', prompt: `请带我复习 ${code} 的考试${examText}：先列出要复习的要点，再一次问我一个问题，检查我是否掌握。` },
          { label: '出 10 道练习题', prompt: `为 ${code} 的考试${examText}出 10 道练习题，由易到难，每题后面附答案和简短解析。` },
          { label: '整理复习笔记', prompt: `为 ${code} 的考试${examText}整理一份考前复习笔记：核心概念、常见题型和易错点。` },
        ] : [
          { label: 'Revise with the agent', prompt: `Help me revise for the ${code} exam${examText}: list the key points first, then quiz me one question at a time.` },
          { label: '10 practice questions', prompt: `Write 10 practice questions for the ${code} exam${examText}, easiest first, each followed by the answer and a short explanation.` },
          { label: 'Revision notes', prompt: `Write revision notes for the ${code} exam${examText}: core concepts, common question types and common mistakes.` },
        ];
        return <section className="revision">
          <h2>{zh ? '考试' : 'Exams'}</h2>
          {exams.length ? <div className="revision-exams">{exams.map(item => <div className="field" key={item.key}><span className="k">{item.name}{item.caution && <small className="muted"> · {zh ? '替代考试' : 'Alternative'}</small>}</span>
            <span>{longDue(item.due)} · {item.sourceZero ? '0%' : item.weight || (zh ? '权重未知' : 'weight unknown')}{item.unsourced?.includes('weight') && <Unsourced zh={zh} />}
              {item.rule ? <small className="muted block">{item.rule}</small> : item.unsourced?.includes('rule') && <small className="muted block">{zh ? '规则未知' : 'Rule unknown'}</small>}
              {item.unsourced?.includes('rule') && <Unsourced zh={zh} />}</span></div>)}</div>
            : <p className="muted">{zh ? '这门课还没有识别到考试。' : 'No exam has been identified for this course.'}</p>}
          {onAsk && <div className="revision-actions">{prompts.map(item => <button key={item.label} className="small" onClick={() => onAsk(selected.course.id, item.prompt)} title={zh ? '打开对话页并发送，会使用模型额度' : 'Opens the Agent page and sends; uses model credit'}>{item.label}</button>)}</div>}
          <h2>{zh ? '复习笔记' : 'Revision notes'}</h2>
          {notesError && <p className="muted">{zh ? '无法读取复习笔记（仅在本地开发服务器中可用）。' : 'Could not load revision notes (dev server only).'}</p>}
          {notes?.length === 0 && !notesError && <p className="muted">{zh ? '还没有笔记。在对话页里，单门课对话的回复下方点「存到复习」即可保存到这里。' : 'No notes yet. In a single-course chat, use "Save to revision" under a reply.'}</p>}
          {notes?.map(note => <details className="revision-note" key={note.id}><summary><i className="chevron" aria-hidden="true" /><span>{note.title || (zh ? '笔记' : 'Note')}</span>
            <small className="muted">{new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(note.savedAt))}</small></summary>
            <div className="revision-note-body"><RichText text={note.content} /><button type="button" className="link-button muted" onClick={() => void removeNote(note)}>{zh ? '删除' : 'Delete'}</button></div></details>)}
        {!!selected.materials.length && <><h2>{zh ? '课程资料' : 'Materials'}</h2><ul className="linked">{selected.materials.map((item, index) => { const link = url(item['原始链接'] ?? item['链接']); const name = text(item['名称']) || '资料'; return <li key={index}>{link ? <a href={link} target="_blank" rel="noreferrer">{name}</a> : name}</li>; })}</ul></>}</section>; })()}
      {chosen && (() => {
        // Show the live values: the drawer stays open while the owner edits this assessment.
        const item = primaryItems.find(candidate => candidate.key === chosen.key) ?? chosen;
        const all = selected.assessments, visible = primaryItems, siblings = chosenSiblings;
        const close = closeDrawer;
        return <div className={`local-drawer-overlay${drawerClosing ? ' closing' : ''}`} role="presentation" onClick={event => { if (event.target === event.currentTarget) close(); }}><section className="local-drawer" role="dialog" aria-modal="true" aria-label={item.name}>
        <div className="dialog-heading"><div><small>{selected.course.subjectCode}</small><h2>{item.name}</h2></div><button className="ghost" onClick={close}>{zh ? '关闭' : 'Close'}</button></div>
        <div className="field"><span className="k">{zh ? '截止' : 'Due'}</span><span>{longDue(item.due)}</span></div>
        <div className="field"><span className="k">{zh ? '权重' : 'Weight'}</span><span>{item.sourceZero ? '0%' : item.weight || '—'}{item.unsourced?.includes('weight') && <Unsourced zh={zh} />}
          {item.weightQuote && <q className="source-quote" title={zh ? '同步时核对过的原文' : 'Source text checked during sync'}>{item.weightQuote}</q>}</span></div>
        {siblings && <div className="field"><span className="k">{zh ? '类型' : 'Type'}</span><span>{kindName[item.kind] ?? '—'}{item.bonus ? ` · ${zh ? '加分' : 'Bonus'}` : item.caution ? ` · ${zh ? '替代考试' : 'Alternative'}` : item.ungraded ? ` · ${zh ? '不计分' : 'Ungraded'}` : ''}</span></div>}
        <div className="field"><span className="k">{zh ? '分数' : 'Score'}</span><span>{item.score === undefined ? '—' : `${item.score}${item.outOf !== undefined ? ` / ${item.outOf}` : ''}${item.outOf ? ` · ${scoreText(item.score, item.outOf)}` : ''}`}</span></div>
        {siblings && <div className="field"><span className="k">{zh ? '状态' : 'Status'}</span><span>{statusLabel(corrections[item.key]?.status || item.status || (item.score !== undefined ? 'graded' : 'unknown'), zh)}</span></div>}
        {item.rule ? <p className="drawer-note">{item.rule}{item.ruleQuote && <q className="source-quote" title={zh ? '同步时核对过的原文' : 'Source text checked during sync'}>{item.ruleQuote}</q>}</p>
          : item.unsourced?.includes('rule') && <p className="drawer-note">{zh ? '规则未知' : 'Rule unknown'}<Unsourced zh={zh} /></p>}
        {(item.link || item.sources.length > 0) && <p className="drawer-links">{item.link && !item.sources.some(source => source.link === item.link) && <><a href={item.link} target="_blank" rel="noreferrer">{zh ? '我的链接' : 'My link'}</a>{item.sources.length > 0 && ' · '}</>}{item.sources.map((source, index) => <span key={`${source.link}-${index}`}>{index > 0 && ' · '}<a href={source.link} target="_blank" rel="noreferrer">{source.platform.toLowerCase() === 'ed' ? 'Ed' : source.platform.toLowerCase() === 'canvas' ? 'Canvas' : source.platform.toLowerCase() === 'handbook' ? 'Handbook' : (zh ? '来源' : 'Source')}</a></span>)}</p>}
        {all.filter(other => corrections[other.key]?.mergeInto === item.key).map(other => <div key={other.key} className="local-group"><span>{zh ? '已合并来源' : 'Merged source'}: {other.name} {other.link && <a href={other.link} target="_blank" rel="noreferrer">{zh ? '查看' : 'View'}</a>}</span><button className="small" onClick={() => { const next = { ...corrections }; const change = { ...next[other.key] }; delete change.mergeInto; next[other.key] = change; saveCorrections(next); }}>{zh ? '撤销合并' : 'Undo merge'}</button></div>)}
        <h3>{zh ? '安排学习' : 'Plan study'}</h3>
        <form className="plan-form" key={item.key} onSubmit={schedule}><label>{zh ? '截止日期' : 'Due date'}<input name="due" type="date" required defaultValue={work.find(entry => entry.key === item.key)?.due ?? corrections[item.key]?.due ?? (/^\d{4}-\d{2}-\d{2}/.test(item.due) ? item.due.slice(0, 10) : undefined)} /></label><label>{zh ? '预计学习分钟数' : 'Estimated minutes'}<input name="minutes" type="number" min="1" max="100000" required defaultValue={work.find(entry => entry.key === item.key)?.minutes} /></label><button className="primary" type="submit">{zh ? '保存并排期' : 'Save and plan'}</button></form>
        {siblings && <>
          <h3>{zh ? '修正' : 'Corrections'}</h3>
          <details className="assessment-edit"><summary>{zh ? '编辑这项考核' : 'Edit this assessment'}</summary><form className="local-confirm" key={`edit-${item.key}`} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const rawWeight = String(data.get('weight') ?? '').trim(); const newWeight = rawWeight === '' ? undefined : Number(rawWeight); if (newWeight !== undefined && (!Number.isFinite(newWeight) || newWeight < 0 || newWeight > 100)) return;
            const name = String(data.get('name') ?? '').trim(); if (!name) return;
            const scoreText = String(data.get('score') ?? '').trim(), maxText = String(data.get('outOf') ?? '').trim(); const score = scoreText ? Number(scoreText) : null, outOf = maxText ? Number(maxText) : null;
            if ((score !== null && (!Number.isFinite(score) || score < 0)) || (outOf !== null && (!Number.isFinite(outOf) || outOf < 0)) || (score !== null && outOf !== null && score > outOf)) return;
            const next: Correction = { ...corrections[item.key], name, kind: String(data.get('kind')) as Kind, nature: String(data.get('nature')) as Correction['nature'], rule: String(data.get('rule') ?? '').trim(), weight: newWeight ?? null, score, outOf, due: String(data.get('due') ?? '') || null, parent: String(data.get('parent') ?? '').trim(), status: String(data.get('status') ?? '').trim(), link: String(data.get('link') ?? '').trim() };
            saveCorrections({ ...corrections, [item.key]: next }); }}>
            <label>{zh ? '名称' : 'Name'}<input name="name" required defaultValue={item.name} /></label>
            <label>{zh ? '类型' : 'Type'}<select name="kind" defaultValue={item.kind}>{(['quiz', 'assignment', 'exam', 'presentation', 'participation', 'hurdle', 'unknown'] as Kind[]).map(kind => <option value={kind} key={kind}>{groupName[kind]}</option>)}</select></label>
            <label>{zh ? '性质' : 'Nature'}<select name="nature" defaultValue={item.bonus ? 'bonus' : item.caution ? 'alternative' : item.ungraded || item.kind === 'ungraded' ? 'ungraded' : 'regular'}><option value="regular">{zh ? '普通考核' : 'Regular'}</option><option value="bonus">{zh ? '加分' : 'Bonus'}</option><option value="ungraded">{zh ? '不计分' : 'Ungraded'}</option><option value="alternative">{zh ? '替代考试' : 'Alternative'}</option></select></label><label>{zh ? '规则' : 'Rule'}<input name="rule" defaultValue={item.rule ?? ''} /></label>
            <label>{zh ? '单项占比 %' : 'Item weight %'}<input name="weight" type="number" min="0" max="100" step="any" defaultValue={item.weightValue} /></label>
            <label>{zh ? '得分' : 'Score'}<input name="score" type="number" min="0" step="any" defaultValue={item.score} /></label><label>{zh ? '满分' : 'Out of'}<input name="outOf" type="number" min="0" step="any" defaultValue={item.outOf} /></label>
            <label>{zh ? '截止时间' : 'Due'}<input name="due" defaultValue={item.due} placeholder="YYYY-MM-DD" /></label><label>{zh ? '归属' : 'Parent'}<select name="parent" defaultValue={item.parent}><option value="">{zh ? '无' : 'None'}</option>{visible.filter(candidate => candidate.key !== item.key && !candidate.parent && !visible.some(child => child.parent === item.key)).map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.name}</option>)}</select></label><label>{zh ? '状态' : 'Status'}<input name="status" defaultValue={item.status} /></label><label>{zh ? '链接' : 'Link'}<input type="url" name="link" defaultValue={item.link} /></label><button type="submit">{zh ? '保存' : 'Save'}</button>
          </form></details>
          <details className="assessment-edit"><summary>{zh ? '和另一项合并' : 'Merge with another'}</summary><div className="local-merge"><label>{zh ? '如果是同一个考核，合并到' : 'If this is the same assessment, merge into'}<select defaultValue="" onChange={event => { const target = event.target.value; if (!target) return; saveCorrections({ ...corrections, [item.key]: { ...corrections[item.key], mergeInto: target } }); close(); }}><option value="">{zh ? '选择考核' : 'Choose assessment'}</option>{visible.filter(other => other.key !== item.key && !all.some(child => corrections[child.key]?.mergeInto === item.key || child.parent === item.key)).map(other => <option value={other.key} key={other.key}>{other.name}</option>)}</select></label><small>{zh ? '来源保留，可撤销。已有排期不会自动移除。' : 'Sources remain and merges can be undone. Existing plans are not removed.'}</small></div></details>
          <div className="drawer-actions">
            <button className="small" type="button" disabled={siblings.indexOf(item.key) <= 0} onClick={() => move(item.key, siblings, -1)}>{zh ? '上移' : 'Move up'}</button>
            <button className="small" type="button" disabled={siblings.indexOf(item.key) >= siblings.length - 1} onClick={() => move(item.key, siblings, 1)}>{zh ? '下移' : 'Move down'}</button>
            <button className="small" onClick={() => { saveCorrections({ ...corrections, [item.key]: { ...corrections[item.key], hidden: true } }); close(); }}>{zh ? '从列表移除' : 'Remove from list'}</button>
          </div>
        </>}
      </section></div>; })()}

    </> : <p>{zh ? '课程不可用或未选中。' : 'Course unavailable or not selected.'}</p>}
    {saveError && <p role="alert">{zh ? '保存失败，请检查浏览器存储。' : 'Could not save; check browser storage.'}</p>}
    {correctionsNotice && <p role="alert">{correctionsNotice === 'refreshed' ? (zh ? '修正已在别处更新，已刷新；请重新编辑' : 'Corrections were updated elsewhere and have been refreshed; please edit again')
      : correctionsNotice === 'save' ? (zh ? '修正保存失败，已恢复为上次保存的内容；请确认本地服务在运行后重试。' : 'Could not save the corrections; the last saved version is shown. Check that the local server is running and try again.')
      : (zh ? '无法读取本地修正文件（.local/corrections），部分修正暂未显示。' : 'Could not read the local corrections (.local/corrections); some corrections are not shown.')}</p>}
  </div>;
  // Monday-first weekday names; 2026-01-05 is a Monday.
  const weekdayName = (index: number) => new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${addDays('2026-01-05', index)}T12:00:00Z`));
  const dayName = (day: string) => new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  const shortDate = (day: string) => new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
  const currentMonth = week.slice(0, 7);
  const first = `${currentMonth}-01`;
  const monthStart = addDays(first, -((new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7));
  // Deadlines on the calendar: synced and manual assessments with the owner's corrections, then tasks not already shown.
  const dueDay = (due: string): string | undefined => { if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return due; const date = dueDate(due); return date ? localDay(date) : undefined; };
  const covers = (task: Work, courseId: string, key: string) => task.courseId === courseId && (task.key === key || task.key === `${courseId}:group:${key}`);
  // A parent's own date, status and weight edits are stored under its group key, so they are laid over its source item.
  // `graded` mirrors the grading inputs: weighted, and not under a bonus, alternative, ungraded or 0% parent.
  const notCounted = (item: Assessment) => item.bonus || item.caution || item.ungraded || item.kind === 'ungraded' || item.sourceZero;
  const assessmentDeadlines = courses.flatMap(original => {
    if (!original.available) return [];
    const course = withCorrections(original), items = visibleItems(course), groups = groupParents(course, items);
    return items.flatMap(raw => {
      const group = groups.find(entry => entry.sourceKey === raw.key);
      const item = group ? { ...raw, due: group.due ?? '', status: group.status ?? raw.status, weightValue: group.weight } : raw;
      const parent = item.parent ? items.find(entry => entry.key === item.parent) : undefined;
      const parentGroup = parent ? groups.find(entry => entry.sourceKey === parent.key) : undefined;
      // A group entry carries the owner's weight edit, including a cleared weight; only items without one use the synced value.
      const parentWeight = parentGroup ? parentGroup.weight : parent?.weightValue;
      const graded = !item.caution && !item.ungraded && item.kind !== 'ungraded' && !(parent && notCounted(parent))
        && ((item.weightValue ?? 0) > 0 || item.bonus === true || (parentWeight ?? 0) > 0);
      const day = dueDay(item.due);
      return day ? [{ item, day, graded, courseId: course.course.id, code: course.course.subjectCode }] : [];
    });
  });
  const tasks = work.filter(inScope);
  const workByKey = new Map(tasks.map(item => [item.key, item]));
  type Deadline = { key: string; day: string; courseId: string; label: string; done: boolean };
  const deadlines: Deadline[] = [
    ...assessmentDeadlines.map(({ item, day, courseId, code }) => ({ key: item.key, day, courseId, label: `${code} · ${item.name}`, done: ['submitted', 'graded'].includes(item.status) || item.score !== undefined })),
    ...tasks.filter(task => !assessmentDeadlines.some(entry => covers(task, entry.courseId, entry.item.key))).map(task => ({ key: task.key, day: task.due, courseId: task.courseId, label: `${codeOfWork(task)} · ${task.title}`, done: task.done === true })),
  ];
  const deadlinesOn = (day: string) => deadlines.filter(entry => entry.day === day);
  const deadlineButton = (entry: Deadline, prefix: boolean) => { const label = `${prefix ? `${zh ? '截止' : 'Due'} · ` : ''}${entry.label}`;
    return entry.courseId ? <button type="button" className={`due${entry.done ? ' done' : ''}`} key={entry.key} onClick={() => onCourse(entry.courseId)}>{label}</button>
      : <span className={`due${entry.done ? ' done' : ''}`} key={entry.key}>{label}</span>; };
  // Needs you: overflow and overdue tasks, failed syncs, and weighted assessments due within 7 days with no task.
  const weekEnd = addDays(today, 6);
  const codeOf = (id: string) => courses.find(item => item.course.id === id)?.course.subjectCode ?? id;
  const needs = [
    ...plan.overflow.flatMap(entry => { const task = workByKey.get(entry.key); if (!task) return [];
      return [{ key: `plan:${entry.key}`, courseId: task.courseId, text: entry.overdue
        ? (entry.minutes > 0 ? (zh ? `已过截止 · ${codeOfWork(task)} · ${task.title}：还剩 ${entry.minutes} 分钟` : `Overdue · ${codeOfWork(task)} · ${task.title}: ${entry.minutes} min left`)
          : (zh ? `已过截止 · ${codeOfWork(task)} · ${task.title}：预计时间已用完，还没标完成` : `Overdue · ${codeOfWork(task)} · ${task.title}: estimate used up, not marked done`))
        : (zh ? `排不下 · ${codeOfWork(task)} · ${task.title}：${shortDate(task.due)} 截止前还差 ${entry.minutes} 分钟` : `Does not fit · ${codeOfWork(task)} · ${task.title}: ${entry.minutes} min short before ${shortDate(task.due)}`) }]; }),
    ...syncIssues.filter(item => item.status === 'failed').map(item => ({ key: `sync:${item.id}`, courseId: item.id, text: zh ? `${codeOf(item.id)} 最近一次同步未完成` : `${codeOf(item.id)}: the latest sync failed` })),
    ...assessmentDeadlines.filter(({ item, day, courseId, graded }) => graded && day >= today && day <= weekEnd && item.score === undefined
      && !['submitted', 'graded'].includes(item.status)
      && !tasks.some(task => covers(task, courseId, item.key) || (item.parent !== '' && covers(task, courseId, item.parent))))
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(({ item, day, courseId, code }) => ({ key: `soon:${item.key}`, courseId, text: zh ? `${shortDate(day)} 截止 · ${code} · ${item.name}：还没有安排` : `Due ${shortDate(day)} · ${code} · ${item.name}: not planned` })),
  ];
  function updateTask(key: string, change: Partial<Work>) { saveWork(work.map(item => item.key === key ? { ...item, ...change } : item)); }
  function saveAvailability(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const next = parseAvailability(Array.from({ length: 7 }, (_, index) => { const raw = String(data.get(`day${index}`) ?? '').trim(); return raw === '' ? Number.NaN : Number(raw); }));
    try { localStorage.setItem(availabilityKey, JSON.stringify(next)); setSaveError(false); } catch { setSaveError(true); }
    setAvailability(next); setEditingHours(false);
  }
  const shift = (direction: number) => {
    if (mode === 'plan') setWeek(addDays(week, direction * 7));
    else { const d = new Date(`${first}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + direction); setWeek(d.toISOString().slice(0, 10)); }
  };
  return <>
    {error && <p className="needs">{error}</p>}
    <div className="week-layout"><div className="week-main">
      <div className="week-toolbar"><div className="week-nav" role="group" aria-label={zh ? '周切换' : 'Navigate weeks'}>
        <button onClick={() => shift(-1)}>‹</button><button onClick={() => setWeek(addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7)))}>{zh ? '今天' : 'Today'}</button><button onClick={() => shift(1)}>›</button><span className="range">{mode === 'plan' ? `${shortDate(week)} – ${shortDate(addDays(week, 6))}` : currentMonth}</span></div>
        <div className="week-actions"><span className="muted">{zh ? '学期' : 'Term'}: {courses[0]?.course.term || '—'}</span><div className="seg" role="group" aria-label={zh ? '视图' : 'View'}><button aria-pressed={mode === 'plan'} onClick={() => { setWeek(addDays(week, -((new Date(`${week}T12:00:00Z`).getUTCDay() + 6) % 7))); setMode('plan'); }}>{zh ? '周视图' : 'Week'}</button><button aria-pressed={mode === 'month'} onClick={() => setMode('month')}>{zh ? '月历' : 'Month'}</button></div><button aria-expanded={editingHours} onClick={() => setEditingHours(value => !value)}>{zh ? '每天可用时间' : 'Daily hours'}</button><button aria-expanded={addingTask} onClick={() => setAddingTask(value => !value)}>{addingTask ? (zh ? '取消' : 'Cancel') : (zh ? '添加任务' : 'Add task')}</button></div></div>
      {needs.length > 0 && <section className="needs" aria-label={zh ? '需要你处理' : 'Needs you'}><h2>{zh ? '需要你处理' : 'Needs you'}</h2>
        {needs.map(entry => entry.courseId
          ? <button type="button" className="needs-line ghost" key={entry.key} onClick={() => onCourse(entry.courseId)}><i className="signal" aria-hidden="true" /><span>{entry.text}</span><span className="needs-line-go">›</span></button>
          : <div className="needs-line" key={entry.key}><i className="signal" aria-hidden="true" /><span>{entry.text}</span></div>)}</section>}
      {editingHours && <form className="local-confirm hours-form" onSubmit={saveAvailability}>
        {Array.from({ length: 7 }, (_, index) => <label key={index}>{weekdayName(index)}<input name={`day${index}`} type="number" min="0" max="1440" step="5" defaultValue={availability[index]} /></label>)}
        <small className="muted">{zh ? '每天可用于学习的分钟数；改动后计划立即重排。' : 'Minutes available for study each day; the plan updates at once.'}</small>
        <button type="submit" className="primary">{zh ? '保存' : 'Save'}</button></form>}
      {addingTask && <form className="local-confirm task-form" onSubmit={addTask}>
        <label>{zh ? '任务' : 'Task'}<input name="title" required maxLength={200} placeholder={zh ? '例如：投递实习申请' : 'e.g. Internship application'} /></label>
        <label>{zh ? '截止日期' : 'Deadline'}<input name="due" type="date" required defaultValue={today} /></label>
        <label>{zh ? '预计分钟' : 'Estimate (min)'}<input name="minutes" type="number" min="1" max="100000" required defaultValue={60} /></label>
        <label>{zh ? '课程' : 'Course'}<select name="course" defaultValue=""><option value="">{zh ? '无（校外任务）' : 'None (personal)'}</option>{courses.map(item => <option key={item.course.id} value={item.course.id}>{item.course.subjectCode}</option>)}</select></label>
        <button type="submit" className="primary">{zh ? '添加' : 'Add'}</button></form>}
      {mode === 'plan' ? <div className="local-week-grid">{Array.from({ length: 7 }, (_, index) => {
        const day = addDays(week, index); const entries = (plan.days[day] ?? []).flatMap(block => { const task = workByKey.get(block.key); return task ? [{ work: task, minutes: block.minutes }] : []; }); const due = deadlinesOn(day);
        return <section key={day} style={{ '--i': index } as CSSProperties} className={`local-week-day${day === today ? ' today' : ''}${day < today ? ' past' : ''}`}>
          <div className="local-week-heading"><b>{dayName(day)}</b></div>
          <div className="local-week-body"><div className="day-deadlines">{due.map(entry => deadlineButton(entry, true))}</div>
          <div className="day-items">{entries.length ? entries.map(entry => { const body = <><span className="tm">{entry.minutes} min</span><span className="tt">{entry.work.title}</span><span className="cr">{codeOfWork(entry.work)}</span></>;
            return entry.work.courseId ? <button className="blk" key={entry.work.key} onClick={() => onCourse(entry.work.courseId)}>{body}</button> : <div className="blk" key={entry.work.key}>{body}</div>; }) : <span className="muted empty-day">{zh ? '无计划' : 'No plan'}</span>}</div>
          </div>
        </section>; })}</div>
        : <div className="card month" role="grid"><div className="month-row" role="row">{Array.from({ length: 7 }, (_, i) => <div className="dow" key={i}>{weekdayName(i)}</div>)}</div>{Array.from({ length: 6 }, (_, row) => <div className="month-row" role="row" key={row}>{Array.from({ length: 7 }, (_, col) => { const day = addDays(monthStart, row * 7 + col); return <div role="gridcell" className={`cell${day.slice(0, 7) === currentMonth ? '' : ' out'}${day === today ? ' today' : ''}`} key={day}><button className="num" onClick={() => { setWeek(addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7))); setMode('plan'); }}>{Number(day.slice(8))}</button>{deadlinesOn(day).map(entry => deadlineButton(entry, false))}</div>; })}</div>)}</div>}
      {tasks.length > 0 && <details className="task-list"><summary><i className="chevron" aria-hidden="true" />{zh ? '任务与用时' : 'Tasks and time'} ({tasks.length})</summary>
        {[...tasks].sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due)).map(item => { const spent = item.spent ?? 0; const diff = item.minutes ? Math.round((spent - item.minutes) / item.minutes * 100) : 0;
          return <div className={`task-row${item.done ? ' done' : ''}`} key={item.key}>
            <span className="task-name">{codeOfWork(item)} · {item.title}<small className="muted block">{zh ? `截止 ${shortDate(item.due)} · 预计 ${item.minutes} 分钟` : `Due ${shortDate(item.due)} · estimate ${item.minutes} min`}{item.done && ` · ${zh ? '实际' : 'actual'} ${spent} ${zh ? '分钟' : 'min'} (${diff > 0 ? '+' : ''}${diff}%)`}</small></span>
            <span className="task-controls"><label className="inline">{zh ? '已用' : 'Spent'}<input key={`${item.key}:${spent}`} type="number" min="0" max="100000" step="5" defaultValue={item.spent ?? ''} aria-label={zh ? `${item.title} 已用分钟` : `${item.title} minutes spent`}
              onBlur={event => { const input = event.currentTarget; const raw = input.value.trim(); const value = raw === '' ? undefined : Math.round(Number(raw));
                // A number input reports '' for text it cannot read, so badInput keeps the stored value instead of clearing it.
                if (!input.validity.badInput && (value === undefined || (Number.isFinite(value) && value >= 0 && value <= 100000))) { if (value !== item.spent) updateTask(item.key, { spent: value }); } else input.value = String(item.spent ?? ''); }} /></label>
            <label className="inline"><input type="checkbox" checked={item.done === true} onChange={event => updateTask(item.key, { done: event.currentTarget.checked })} />{zh ? '完成' : 'Done'}</label>
            <button className="small ghost" onClick={() => saveWork(work.filter(row => row.key !== item.key))}>{zh ? '移除' : 'Remove'}</button></span></div>; })}</details>}
      {saveError && <p role="alert">{zh ? '保存失败，请检查浏览器存储。' : 'Could not save; check browser storage.'}</p>}
    {correctionsNotice && <p role="alert">{correctionsNotice === 'refreshed' ? (zh ? '修正已在别处更新，已刷新；请重新编辑' : 'Corrections were updated elsewhere and have been refreshed; please edit again')
      : correctionsNotice === 'save' ? (zh ? '修正保存失败，已恢复为上次保存的内容；请确认本地服务在运行后重试。' : 'Could not save the corrections; the last saved version is shown. Check that the local server is running and try again.')
      : (zh ? '无法读取本地修正文件（.local/corrections），部分修正暂未显示。' : 'Could not read the local corrections (.local/corrections); some corrections are not shown.')}</p>}
    </div></div>
  </>;
}
