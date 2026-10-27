import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Language } from './i18n.js';

type RecordValue = Record<string, unknown>;
type Course = { id: string; name: string; subjectCode: string; term?: string };
type Kind = 'exam' | 'quiz' | 'assignment' | 'presentation' | 'participation' | 'ungraded' | 'unknown';
type Assessment = { key: string; name: string; due: string; weight: string; weightValue?: number; sourceZero: boolean; kind: Kind; score?: number; outOf?: number; group: string; parent: string; status: string; link: string; sources: { platform: string; link: string }[]; caution: boolean; hurdle: boolean; edScore?: { score: number; outOf: number; url: string } };
type Correction = { kind?: Kind; weight?: number | null; due?: string | null; name?: string; score?: number | null; outOf?: number | null; parent?: string; status?: string; link?: string; mergeInto?: string };
type CourseData = { course: Course; assessments: Assessment[]; groups: RecordValue[]; materials: RecordValue[]; issues: RecordValue[]; available: boolean };
type ParentAssessment = { name: string; displayName?: string; kind?: Kind; weight?: number; children: Assessment[]; scoringRule: string; score?: number; outOf?: number; status?: string; due?: string };
type Work = { key: string; courseId: string; courseCode: string; title: string; due: string; minutes: number };
const workKey = 'coursework.local-planning.work.v1';
const capacityKey = 'coursework.local-planning.capacity.v1';
const correctionKey = 'coursework.local-planning.corrections.v1';
const manualKey = 'coursework.local-planning.assessments.v1';
const orderKey = 'coursework.local-planning.order.v1';
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
function zeroWeight(value: unknown): boolean {
  return value === 0 || (typeof value === 'string' && /^\s*0(?:\.0+)?\s*%?\s*$/.test(value));
}
function explicitPercent(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*(?:（[^）]*）)?\s*$/.exec(value);
  if (!match || /待核|冲突|不确定/.test(value)) return undefined;
  const result = Number(match[1]);
  return result >= 0 && result <= 100 ? result : undefined;
}
function statedPercent(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*%/.exec(value);
  if (!match) return undefined;
  const result = Number(match[1]);
  return result >= 0 && result <= 100 ? result : undefined;
}
function pointsValue(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(?:points?|分)\s*$/i.exec(value);
    if (match) return Number(match[1]);
  }
  return number(value);
}
function kindOf(value: string, name: string): Kind {
  const explicit = value.trim().toLowerCase();
  if (/^(不计分|ungraded|practice|survey)$/.test(explicit)) return 'ungraded';
  if (/\b(?:mid[ -]semester|matlab|final)\s+test\b|期中考试|期末考试/i.test(name)) return 'exam';
  if (/^(考试|exam|test)$/.test(explicit)) return 'exam';
  if (/^(测验|小测|quiz)$/.test(explicit)) return 'quiz';
  if (/^(作业|书面作业|论文|报告|项目|assignment|paper|report|project)$/.test(explicit)) return 'assignment';
  if (/^(展示|演讲|表演|presentation|performance|pre)$/.test(explicit)) return 'presentation';
  if (/^(参与|出勤|课堂参与|participation|attendance|hurdle)$/.test(explicit)) return 'participation';
  const nameHint = name.toLowerCase();
  if (/\b(?:practice|sample|survey|for feedback|token)\b|练习|调查|不计分/.test(nameHint)) return 'ungraded';
  if (/\b(?:exam|examination)\b|考试/.test(nameHint)) return 'exam';
  if (/\bquiz(?:zes)?\b|测验|小测/.test(nameHint)) return 'quiz';
  if (/\b(?:assignment|essay|report|project)\b|作业|论文|报告|项目/.test(nameHint)) return 'assignment';
  if (/\b(?:presentations?|performances?)\b|展示|表演/.test(nameHint)) return 'presentation';
  if (/\b(?:participation|attendance|hurdle)\b|参与|出勤/.test(nameHint)) return 'participation';
  return 'unknown';
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
function normalize(course: Course, value: unknown, edData: unknown): CourseData {
  const report = record(value);
  const sources = list(report['来源']);
  const overview = sources.map(source => text(source['关键原文'])).join(' ');
  const equalMatch = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+written assignments?\s+equally weighted\s+and worth a total of\s+(\d+(?:\.\d+)?)%/i.exec(overview);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const equalCount = equalMatch ? (words[equalMatch[1]!.toLowerCase()] ?? Number(equalMatch[1])) : undefined;
  const equalTotal = equalMatch ? Number(equalMatch[2]) : undefined;
  const rawGroups = report['考核分组'];
  const groups = Array.isArray(rawGroups) ? list(rawGroups) : list(record(rawGroups)['页面原始行'] ?? record(rawGroups)['分组']);
  const rawItems = [...list(report['考核项目']), ...list(report['练习与不计分条目'])];
  const assessments = rawItems.map((item, index): Assessment => {
    const name = text(item['名称']) || `未命名考核 ${index + 1}`;
    const sourceLinks = Array.isArray(item['来源']) ? item['来源'] : [];
    const itemSources = list(item['来源记录']).flatMap(source => { const link = url(source['链接']); return link ? [{ platform: text(source['平台']) || 'source', link }] : []; });
    const link = url(item['链接'] ?? item['原始链接'] ?? sourceLinks.find(value => typeof value === 'string' && /\/(?:assignments|quizzes)\//.test(value)) ?? itemSources[0]?.link);
    const caution = /\b(?:aea|special consideration|supplementary|deferred|alternative|replacement)\b|特殊|替代|补考|延期/i.test(`${name} ${text(item['类型'])}`);
    // Historic reports mix group and item weights; keep the group rule separate.
    const group = text(item['分组'] ?? item['评分组']);
    const groupMembers = rawItems.filter(other => text(other['分组'] ?? other['评分组']) === group && !zeroWeight(other['课程占比'] ?? other['权重']) && !/不计分|练习|sample|practice/i.test(`${text(other['分类'])} ${text(other['名称'])}`));
    const numericWeight = number(item['课程占比']);
    const sourceGroup = groups.find(row => text(row['名称'] ?? row['组名原文'] ?? row['组名']) === group);
    const sourceWeight = number(sourceGroup?.['课程占比'] ?? sourceGroup?.['权重']) ?? explicitPercent(sourceGroup?.['权重'] ?? sourceGroup?.['页面原文权重']);
    const singleGroupWeight = group && groupMembers.length === 1 && numericWeight !== undefined && numericWeight > 0 && sourceWeight === numericWeight ? numericWeight : undefined;
    const evidence = list(item['关键依据']).map(row => text(row['原文'])).join(' ');
    const participationMatch = /\((\d+(?:\.\d+)?)%\)\s*(?:continuous|participation)\s*:\s*(?:classroom\s+)?participation/i.exec(evidence);
    const participationWeight = kindOf(text(item['分类'] ?? item['类型']), name) === 'participation' && participationMatch ? Number(participationMatch[1]) : undefined;
    const directWeight = ['直接', '计算'].includes(text(item['占比依据'])) && numericWeight !== undefined && numericWeight >= 0 && numericWeight <= 100 ? numericWeight : undefined;
    const equalWeight = equalCount && equalTotal !== undefined && sourceWeight === equalTotal && groupMembers.length === equalCount && /written assignments?/i.test(group) ? equalTotal / equalCount : undefined;
    const weightValue = directWeight ?? explicitPercent(item['权重']) ?? participationWeight ?? equalWeight ?? singleGroupWeight;
    const sourceWeightValue = statedPercent(item['权重']);
    const weight = weightValue !== undefined ? `${weightValue}%${equalWeight !== undefined && weightValue === equalWeight ? ' · 平均推算' : ''}`
      : sourceWeightValue !== undefined ? `${sourceWeightValue}%` : '';
    const result = record(item['已出成绩'] ?? item['成绩']);
    const ed = record(record(edData)[name]);
    const edScore = number(ed.score); const edOutOf = number(ed.outOf); const edUrl = url(ed.url);
    const score = number(result['分数'] ?? result['得分'] ?? item['成绩']) ?? (edOutOf !== undefined && edOutOf > 0 ? edScore : undefined);
    const points = record(item['满分']);
    const outOf = number(result['分数'] ?? result['得分'] ?? item['成绩']) === undefined && edScore !== undefined && edOutOf !== undefined && edOutOf > 0
      ? edOutOf : pointsValue(result['满分'] ?? points['实际满分'] ?? item['满分']);
    return { key: `${course.id}:${link || `${index}:${name}`}`, name, due: text(item['截止时间']), weight, weightValue,
      sourceZero: zeroWeight(item['课程占比'] ?? item['权重']), kind: kindOf(text(item['分类'] ?? item['类型']), name),
      score, outOf, group, parent: text(item['父考核']), status: text(item['状态']), link, sources: itemSources, caution,
      ...(edScore !== undefined && edOutOf !== undefined && edUrl ? { edScore: { score: edScore, outOf: edOutOf, url: edUrl } } : {}),
      hurdle: /\bhurdle\b|门槛|必须.*(?:出勤|参加)|must attend/i.test(`${name} ${text(item['类型'])} ${text(item['备注'])}`) };
  });
  return { course, assessments, groups, materials: list(report['课程资料']), issues: list(report['未能获取']), available: !!value };
}

function assessmentParents(course: CourseData, visible: Assessment[]): ParentAssessment[] {
  const groupName = (group: RecordValue) => text(group['名称'] ?? group['组名原文'] ?? group['组名']);
  const groupWeight = (group: RecordValue) => group['课程占比'] ?? group['权重'] ?? group['页面原文权重'];
  const parents: ParentAssessment[] = [];
  const names = new Set([...course.groups.map(groupName).filter(name => /^(?:assignment|project|assessment|作业)\s+\S+$/i.test(name)), ...visible.map(item => item.parent).filter(Boolean)]);
  for (const name of names) {
    const group = course.groups.find(item => groupName(item) === name);
    const rawWeight = group ? groupWeight(group) : undefined;
    const weight = number(rawWeight) ?? explicitPercent(rawWeight);
    const children = visible.filter(item => !item.caution && (item.parent === name || (!item.parent && item.group === name)));
    if (children.length > 1) parents.push({ name, weight, children, scoringRule: text(group?.['计分规则']) });
  }
  return parents;
}
function parentGrade(parent: ParentAssessment): { score: number; outOf: number; earned: number } | undefined {
  if (parent.weight === undefined || parent.weight <= 0) return undefined;
  if (parent.score !== undefined && parent.outOf !== undefined && parent.outOf > 0 && parent.score >= 0 && parent.score <= parent.outOf) return { score: parent.score, outOf: parent.outOf, earned: parent.weight * parent.score / parent.outOf };
  if (/drop|lowest|highest|best of|丢弃|最低|最高/i.test(parent.scoringRule)) return undefined;
  const graded = parent.children.filter(item => !item.sourceZero && item.kind !== 'ungraded');
  if (!graded.length || graded.some(item => item.score === undefined || item.outOf === undefined || item.outOf <= 0 || item.score < 0 || item.score > item.outOf)) return undefined;
  const score = graded.reduce((sum, item) => sum + item.score!, 0);
  const outOf = graded.reduce((sum, item) => sum + item.outOf!, 0);
  const weighted = graded.filter(item => item.weightValue !== undefined);
  if (weighted.length && weighted.length !== graded.length) return undefined;
  if (weighted.length && Math.abs(weighted.reduce((sum, item) => sum + item.weightValue!, 0) - parent.weight) > 0.001) return undefined;
  const earned = weighted.length ? weighted.reduce((sum, item) => sum + item.weightValue! * item.score! / item.outOf!, 0) : parent.weight * score / outOf;
  return { score, outOf, earned };
}
function ScoreOverview({ assessments, parents, zh }: { assessments: Assessment[]; parents: ParentAssessment[]; zh: boolean }) {
  const [target, setTarget] = useState('H1');
  const completedParents = parents.flatMap(parent => { const grade = parentGrade(parent); return grade ? [{ parent, grade }] : []; });
  const countedChildren = new Set(completedParents.flatMap(item => item.parent.children.map(child => child.key)));
  const graded = assessments.filter(item => !countedChildren.has(item.key) && item.weightValue !== undefined && item.score !== undefined && item.outOf !== undefined && item.outOf > 0 && item.score >= 0 && item.score <= item.outOf && !item.caution && !item.sourceZero && item.kind !== 'ungraded');
  const weight = graded.reduce((sum, item) => sum + item.weightValue!, 0) + completedParents.reduce((sum, item) => sum + item.parent.weight!, 0);
  const earned = graded.reduce((sum, item) => sum + item.weightValue! * item.score! / item.outOf!, 0) + completedParents.reduce((sum, item) => sum + item.grade.earned, 0);
  const average = weight ? earned / weight * 100 : undefined;
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

function WeightBreakdown({ course, assessments, zh }: { course: CourseData; assessments: Assessment[]; zh: boolean }) {
  const components = course.groups.flatMap(group => {
    const name = text(group['名称'] ?? group['组名原文'] ?? group['组名']);
    const raw = group['课程占比'] ?? group['权重'] ?? group['页面原文权重'];
    const weight = number(raw) ?? explicitPercent(raw);
    return name && name !== '总计' && weight !== undefined && weight > 0 ? [{ name, weight }] : [];
  });
  const sum = components.reduce((total, item) => total + item.weight, 0);
  const rows = components.length && sum <= 100 ? components : assessments.flatMap(item => {
    const weight = item.weightValue ?? statedPercent(item.weight);
    return !item.caution && weight !== undefined && weight > 0
      ? [{ name: item.name, weight }] : [];
  });
  if (!rows.length) return null;
  return <section className="weight-breakdown"><h2>{zh ? '分数占比' : 'Assessment weights'}</h2><div className="weight-breakdown-list">{rows.map((item, index) => <div className="weight-breakdown-item" key={`${item.name}-${index}`}><span>{item.name.replace(/\s*-\s*Handbook\s+\d{4}$/i, '')}</span><strong>{item.weight}%</strong></div>)}</div></section>;
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
        const data: { courses: Course[]; reports: { id: string; report: unknown }[]; edScores?: Record<string, unknown> } = await response.json();
        let ids: string[] = [];
        try { const selected: unknown = JSON.parse(localStorage.getItem('coursework.selected-course-ids') ?? '[]'); if (Array.isArray(selected)) ids = selected.filter((id): id is string => typeof id === 'string'); } catch { /* No saved selection. */ }
        if (live) { setCourses(data.courses.filter(course => ids.includes(course.id)).map(course => normalize(course, data.reports.find(item => item.id === course.id)?.report, data.edScores?.[course.id]))); setError(''); }
      } catch { if (live) setError(zh ? '无法读取本地课程数据，请先同步课程。' : 'Could not load local course data. Sync courses first.'); }
    }
    void load(); return () => { live = false; };
  }, [refreshVersion, zh]);
  const original = courses.find(item => item.course.id === courseId);
  const selected = original && { ...original, assessments: [...original.assessments, ...(Array.isArray(manual[original.course.id]) ? manual[original.course.id] : [])].map(item => {
    const change = record(corrections[item.key]); const overrideWeight = number(change.weight);
    const validKind = ['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded', 'unknown'].includes(String(change.kind)) ? change.kind as Kind : item.kind;
    return { ...item, kind: validKind, ...(typeof change.name === 'string' && change.name ? { name: change.name } : {}),
      ...(change.weight === null ? { weightValue: undefined, weight: '', sourceZero: false } : overrideWeight !== undefined && overrideWeight >= 0 && overrideWeight <= 100 ? { weightValue: overrideWeight, weight: `${overrideWeight}%`, sourceZero: overrideWeight === 0 } : {}),
      ...(change.score === null ? { score: undefined } : number(change.score) !== undefined ? { score: number(change.score) } : {}),
      ...(change.outOf === null ? { outOf: undefined } : number(change.outOf) !== undefined ? { outOf: number(change.outOf) } : {}),
      ...(typeof change.parent === 'string' ? { parent: change.parent } : {}), ...(typeof change.status === 'string' ? { status: change.status } : {}),
      ...(typeof change.link === 'string' ? { link: url(change.link) } : {}),
      ...(change.due === null ? { due: '' } : typeof change.due === 'string' ? { due: change.due } : {}) };
  }) };
  const automaticDuplicates: Record<string, Assessment[]> = {};
  const primaryItems: Assessment[] = [];
  for (const item of selected?.assessments ?? []) {
    if (corrections[item.key]?.mergeInto) continue;
    const name = item.name.toLowerCase().replace(/\s+/g, ' ').trim();
    const match = primaryItems.find(previous => {
      if (item.caution || previous.caution || corrections[item.key] || corrections[previous.key]
        || work.some(entry => entry.key === item.key || entry.key === previous.key)) return false;
      if (item.score !== undefined && (previous.score === undefined || item.score !== previous.score || item.outOf !== previous.outOf)) return false;
      if (item.weightValue !== undefined && item.weightValue !== previous.weightValue) return false;
      if (item.due && (!previous.due || item.due !== previous.due)) return false;
      if (item.link && item.link === previous.link) return true;
      if (item.kind !== 'assignment' || previous.kind !== 'assignment' || !item.link || !previous.link
        || previous.name.toLowerCase().replace(/\s+/g, ' ').trim() !== name) return false;
      const platforms = [item.link, previous.link].map(link => link.includes('edstem.org') ? 'ed' : link.includes('canvas.lms.unimelb.edu.au') ? 'canvas' : 'other');
      if (!platforms.includes('ed') || !platforms.includes('canvas')) return false;
      return true;
    });
    if (match) (automaticDuplicates[match.key] ??= []).push(item); else primaryItems.push(item);
  }
  const parents = selected ? assessmentParents(selected, primaryItems).map(parent => {
    const change = corrections[`${selected.course.id}:group:${parent.name}`];
    return change ? { ...parent, displayName: change.name || parent.name, kind: change.kind, weight: change.weight === null ? undefined : change.weight ?? parent.weight,
      score: change.score ?? undefined, outOf: change.outOf ?? undefined, status: change.status, due: change.due ?? undefined } : parent;
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
      {selected.available && <ScoreOverview assessments={primaryItems.filter(item => !item.caution)} parents={parents} zh={zh} />}
      {selected.available && <WeightBreakdown course={selected} assessments={primaryItems} zh={zh} />}
      <div className="tabs" role="tablist"><button role="tab" aria-selected={courseTab === 'assessments'} onClick={() => setCourseTab('assessments')}>{zh ? '考核' : 'Assessments'}</button><button role="tab" aria-selected={courseTab === 'revision'} onClick={() => setCourseTab('revision')}>{zh ? '复习' : 'Revision'}</button></div>
      {courseTab === 'assessments' ? <div className="assessment-list">
        <button onClick={() => setAdding(value => !value)}>{adding ? (zh ? '取消' : 'Cancel') : (zh ? '新增考核' : 'Add assessment')}</button>
        {adding && <form className="local-confirm" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const name = String(data.get('name') ?? '').trim(); if (!name) return;
          const kind = String(data.get('kind') ?? 'unknown') as Kind; const weightText = String(data.get('weight') ?? '').trim(); const weight = weightText ? Number(weightText) : undefined;
          if (weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 100)) return;
          const scoreText = String(data.get('score') ?? '').trim(); const maxText = String(data.get('outOf') ?? '').trim(); const score = scoreText ? Number(scoreText) : undefined; const outOf = maxText ? Number(maxText) : undefined;
          if ((score !== undefined && (!Number.isFinite(score) || score < 0)) || (outOf !== undefined && (!Number.isFinite(outOf) || outOf <= 0)) || (score !== undefined && outOf !== undefined && score > outOf)) return;
          const item: Assessment = { key: `${selected.course.id}:manual:${crypto.randomUUID()}`, name, kind, due: String(data.get('due') ?? ''), weight: weight === undefined ? '' : `${weight}%`, weightValue: weight, sourceZero: weight === 0, score, outOf, group: '', parent: String(data.get('parent') ?? '').trim(), status: '', link: url(data.get('link')), sources: [], caution: false, hurdle: false };
          if (saveManual({ ...manual, [selected.course.id]: [...(manual[selected.course.id] ?? []), item] })) setAdding(false);
        }}><label>{zh ? '名称' : 'Name'}<input name="name" required /></label><label>{zh ? '类型' : 'Type'}<select name="kind"><option value="assignment">{zh ? '作业' : 'Assignment'}</option><option value="quiz">Quiz</option><option value="exam">Test</option><option value="presentation">{zh ? '展示' : 'Presentation'}</option><option value="participation">{zh ? '参与' : 'Participation'}</option><option value="ungraded">{zh ? '不计分' : 'Ungraded'}</option></select></label><label>{zh ? '占比 %' : 'Weight %'}<input type="number" name="weight" min="0" max="100" step="any" /></label><label>{zh ? '得分' : 'Score'}<input type="number" name="score" min="0" step="any" /></label><label>{zh ? '满分' : 'Out of'}<input type="number" name="outOf" min="0.01" step="any" /></label><label>{zh ? '截止日期' : 'Due date'}<input type="date" name="due" /></label><label>{zh ? '父考核名称' : 'Parent name'}<input name="parent" /></label><label>{zh ? '链接' : 'Link'}<input type="url" name="link" /></label><button type="submit">{zh ? '保存' : 'Save'}</button></form>}
        <div className="arow head" aria-hidden="true"><span>{zh ? '名称' : 'Name'}</span><span>{zh ? '截止' : 'Due'}</span><span className="num">{zh ? '权重' : 'Weight'}</span><span className="num">{zh ? '分数' : 'Score'}</span><span>{zh ? '状态' : 'Status'}</span><span>{zh ? '排期' : 'Plan'}</span></div>
        {!selected.assessments.length && <p className="muted">{zh ? '暂未获取考核项目。' : 'No assessments found yet.'}</p>}
        {(() => {
          const kinds: Kind[] = ['quiz', 'assignment', 'exam', 'presentation', 'participation', 'unknown'];
          const labels: Record<Kind, string> = zh ? { exam: '考试', quiz: '测验', assignment: '作业', presentation: '展示', participation: '参与', ungraded: '不计分', unknown: '其他' } : { exam: 'Exams', quiz: 'Quizzes', assignment: 'Assignments', presentation: 'Presentations', participation: 'Participation', ungraded: 'Ungraded', unknown: 'Other' };
          const groupName = (group: RecordValue) => text(group['名称'] ?? group['组名原文'] ?? group['组名']);
          const groupWeight = (group: RecordValue) => group['课程占比'] ?? group['权重'] ?? group['页面原文权重'];
          const all = selected.assessments;
          const visible = primaryItems;
          const childKeys = new Set(parents.flatMap(parent => parent.children.map(item => item.key)));
          const row = (item: Assessment, siblings: string[]) => <details key={item.key} className="assessment-entry"><summary className="arow">
            <span className="aname">{item.name}</span>
            <span className="muted">{item.due || (zh ? '未知' : 'Unknown')}</span><span className="num">{item.sourceZero ? '0%' : item.weight || '—'}</span>
            <span className="num points">{item.score !== undefined ? `${item.score}${item.outOf !== undefined ? ` / ${item.outOf}` : ''}` : item.edScore ? `Ed ${item.edScore.score} / ${item.edScore.outOf}` : '—'}</span>
            <span>{corrections[item.key]?.status || (item.score !== undefined ? (zh ? '已出分' : 'Graded') : '—')}</span><span>{work.some(entry => entry.key === item.key) ? (zh ? '已排期' : 'Planned') : '—'}</span></summary>
            <div className="assessment-expanded">
              <div className="assessment-order"><button type="button" disabled={siblings.indexOf(item.key) <= 0} onClick={() => move(item.key, siblings, -1)}>{zh ? '上移' : 'Move up'}</button><button type="button" disabled={siblings.indexOf(item.key) >= siblings.length - 1} onClick={() => move(item.key, siblings, 1)}>{zh ? '下移' : 'Move down'}</button></div>
              {item.edScore && <p><a href={item.edScore.url} target="_blank" rel="noreferrer">Ed Submissions Overall · {item.edScore.score} / {item.edScore.outOf}</a></p>}
              {(item.link || item.sources.length > 0) && <p>{item.sources.length ? item.sources.map((source, index) => <span key={`${source.link}-${index}`}>{index > 0 && ' · '}<a href={source.link} target="_blank" rel="noreferrer">{source.platform.toLowerCase() === 'ed' ? 'Ed' : source.platform.toLowerCase() === 'canvas' ? 'Canvas' : (zh ? '来源' : 'Source')}</a></span>) : <a href={item.link} target="_blank" rel="noreferrer">{zh ? '查看来源' : 'Source'}</a>}{(automaticDuplicates[item.key] ?? []).map(other => other.link && other.link !== item.link ? <span key={other.key}> · <a href={other.link} target="_blank" rel="noreferrer">{other.link.includes('edstem.org') ? 'Ed' : 'Canvas'}</a></span> : null)}</p>}
              {all.filter(other => corrections[other.key]?.mergeInto === item.key).map(other => <div key={other.key} className="local-group"><span>{zh ? '已合并来源' : 'Merged source'}: {other.name} {other.link && <a href={other.link} target="_blank" rel="noreferrer">{zh ? '查看' : 'View'}</a>}</span><button onClick={() => { const next = { ...corrections }; const change = { ...next[other.key] }; delete change.mergeInto; next[other.key] = change; saveCorrections(next); }}>{zh ? '撤销合并' : 'Undo merge'}</button></div>)}
              <details className="assessment-edit"><summary>{zh ? '编辑或合并' : 'Edit or merge'}</summary><form className="local-confirm" key={item.key} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const rawWeight = String(data.get('weight') ?? '').trim(); const newWeight = rawWeight === '' ? undefined : Number(rawWeight); if (newWeight !== undefined && (!Number.isFinite(newWeight) || newWeight < 0 || newWeight > 100)) return;
                const name = String(data.get('name') ?? '').trim(); if (!name) return;
                const scoreText = String(data.get('score') ?? '').trim(), maxText = String(data.get('outOf') ?? '').trim(); const score = scoreText ? Number(scoreText) : null, outOf = maxText ? Number(maxText) : null;
                if ((score !== null && (!Number.isFinite(score) || score < 0)) || (outOf !== null && (!Number.isFinite(outOf) || outOf <= 0)) || (score !== null && outOf !== null && score > outOf)) return;
                const next: Correction = { ...corrections[item.key], name, kind: String(data.get('kind')) as Kind, weight: newWeight ?? null, score, outOf, due: String(data.get('due') ?? '') || null, parent: String(data.get('parent') ?? '').trim(), status: String(data.get('status') ?? '').trim(), link: String(data.get('link') ?? '').trim() };
                saveCorrections({ ...corrections, [item.key]: next }); }}>
                <label>{zh ? '名称' : 'Name'}<input name="name" required defaultValue={item.name} /></label>
                <label>{zh ? '类型' : 'Type'}<select name="kind" defaultValue={item.kind}>{(['quiz', 'assignment', 'exam', 'presentation', 'participation', 'ungraded', 'unknown'] as Kind[]).map(kind => <option value={kind} key={kind}>{labels[kind]}</option>)}</select></label>
                <label>{zh ? '单项占比 %' : 'Item weight %'}<input name="weight" type="number" min="0" max="100" step="any" defaultValue={item.weightValue} /></label>
                <label>{zh ? '得分' : 'Score'}<input name="score" type="number" min="0" step="any" defaultValue={item.score} /></label><label>{zh ? '满分' : 'Out of'}<input name="outOf" type="number" min="0.01" step="any" defaultValue={item.outOf} /></label>
                <label>{zh ? '截止时间' : 'Due'}<input name="due" defaultValue={item.due} placeholder="YYYY-MM-DD" /></label><label>{zh ? '父考核名称' : 'Parent name'}<input name="parent" defaultValue={item.parent || item.group} /></label><label>{zh ? '状态' : 'Status'}<input name="status" defaultValue={corrections[item.key]?.status ?? ''} /></label><label>{zh ? '链接' : 'Link'}<input type="url" name="link" defaultValue={item.link} /></label><button type="submit">{zh ? '保存' : 'Save'}</button>
              </form>
              <div className="local-merge"><label>{zh ? '如果是同一个考核，合并到' : 'If this is the same assessment, merge into'}<select defaultValue="" onChange={event => { const target = event.target.value; if (!target) return; saveCorrections({ ...corrections, [item.key]: { ...corrections[item.key], mergeInto: target } }); }}><option value="">{zh ? '选择考核' : 'Choose assessment'}</option>{visible.filter(other => other.key !== item.key && !all.some(child => corrections[child.key]?.mergeInto === item.key)).map(other => <option value={other.key} key={other.key}>{other.name}</option>)}</select></label><small>{zh ? '来源保留，可撤销。已有排期不会自动移除。' : 'Sources remain and merges can be undone. Existing plans are not removed.'}</small></div>
              </details><button onClick={() => setChosen(item)}>{zh ? '安排学习' : 'Plan study'}</button>
            </div></details>;
          const scoredParticipation = (item: Assessment) => item.kind === 'participation' && !item.sourceZero && (item.weightValue ?? 0) > 0;
          const groupedItem = (kind: Kind) => visible.filter(item => !childKeys.has(item.key) && !item.caution && (kind === 'participation' && (item.hurdle || scoredParticipation(item)) || kind !== 'participation' && item.kind === kind && !item.hurdle && !item.sourceZero && item.kind !== 'ungraded'));
          const foldedItems = visible.filter(item => !childKeys.has(item.key) && (item.caution || !item.hurdle && (item.sourceZero || item.kind === 'ungraded' || item.kind === 'participation' && !scoredParticipation(item))));
          return <>
            {kinds.map(kind => { const items = groupedItem(kind); const combined: { key: string; item?: Assessment; parent?: ParentAssessment }[] = [
              ...parents.filter(parent => (parent.kind ?? 'assignment') === kind).map(parent => ({ key: `${selected.course.id}:group:${parent.name}`, parent })), ...items.map(item => ({ key: item.key, item })) ];
              const ordered = sorted(combined, entry => entry.key); if (!ordered.length) return null;
              const siblingKeys = ordered.map(entry => entry.key);
              const open = kind !== 'participation' || items.some(item => item.hurdle || scoredParticipation(item));
              return <details className="agroup category" key={kind} open={open || undefined}><summary className="ghead"><b>{labels[kind]}</b><small>{ordered.length}</small></summary>
                {ordered.map(entry => entry.item ? row(entry.item, siblingKeys) : (() => { const parent = entry.parent!; const grade = parentGrade(parent); const children = sorted(parent.children, item => item.key); const childOrder = children.map(item => item.key);
                  return <details className="assessment-parent" key={entry.key}><summary className="arow"><span className="aname"><strong>{parent.displayName || parent.name}</strong></span><span className="muted">{parent.due || `${parent.children.length} ${zh ? '个子项' : 'items'}`}</span><span className="num">{parent.weight === undefined ? '—' : `${parent.weight}%`}</span><span className="num">{grade ? `${Number(grade.score.toFixed(2))} / ${Number(grade.outOf.toFixed(2))}` : '—'}</span><span>{parent.status || (grade ? (zh ? '已出分' : 'Graded') : '—')}</span><span>—</span></summary>
                    <div className="assessment-children"><div className="assessment-order"><button type="button" disabled={siblingKeys.indexOf(entry.key) <= 0} onClick={() => move(entry.key, siblingKeys, -1)}>{zh ? '上移' : 'Move up'}</button><button type="button" disabled={siblingKeys.indexOf(entry.key) >= siblingKeys.length - 1} onClick={() => move(entry.key, siblingKeys, 1)}>{zh ? '下移' : 'Move down'}</button></div>
                    {children.map(item => row(item, childOrder))}
                    <details className="assessment-edit"><summary>{zh ? '编辑父考核' : 'Edit parent'}</summary><form className="local-confirm" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const name = String(data.get('name') ?? '').trim(); if (!name) return;
                      const w = String(data.get('weight') ?? '').trim(), n = String(data.get('score') ?? '').trim(), m = String(data.get('outOf') ?? '').trim(); const weight = w ? Number(w) : null, score = n ? Number(n) : null, outOf = m ? Number(m) : null;
                      if ((weight !== null && (!Number.isFinite(weight) || weight < 0 || weight > 100)) || (score !== null && (!Number.isFinite(score) || score < 0)) || (outOf !== null && (!Number.isFinite(outOf) || outOf <= 0)) || (score !== null && outOf !== null && score > outOf)) return;
                      saveCorrections({ ...corrections, [entry.key]: { ...corrections[entry.key], name, kind: String(data.get('kind')) as Kind, weight, score, outOf, due: String(data.get('due') ?? '') || null, status: String(data.get('status') ?? '').trim() } }); }}>
                      <label>{zh ? '名称' : 'Name'}<input name="name" required defaultValue={parent.displayName || parent.name} /></label><label>{zh ? '类型' : 'Type'}<select name="kind" defaultValue={parent.kind ?? 'assignment'}>{(['quiz', 'assignment', 'exam', 'presentation', 'participation', 'unknown'] as Kind[]).map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label><label>{zh ? '占比 %' : 'Weight %'}<input type="number" min="0" max="100" step="any" name="weight" defaultValue={parent.weight} /></label><label>{zh ? '得分' : 'Score'}<input type="number" min="0" step="any" name="score" defaultValue={parent.score} /></label><label>{zh ? '满分' : 'Out of'}<input type="number" min="0.01" step="any" name="outOf" defaultValue={parent.outOf} /></label><label>{zh ? '日期' : 'Due date'}<input type="date" name="due" defaultValue={parent.due} /></label><label>{zh ? '状态' : 'Status'}<input name="status" defaultValue={parent.status} /></label><button type="submit">{zh ? '保存' : 'Save'}</button></form></details>
                    <button onClick={() => setChosen({ key: entry.key, name: parent.displayName || parent.name, due: parent.due || '', weight: parent.weight === undefined ? '' : `${parent.weight}%`, sourceZero: false, kind: 'assignment', group: parent.name, status: parent.status || '', link: '', sources: [], parent: '', caution: false, hurdle: false })}>{zh ? '安排整个作业' : 'Plan assignment'}</button></div></details>;
                })())}
              </details>; })}
            {foldedItems.length > 0 && <details className="no-marks"><summary>{zh ? '其他项目' : 'Other items'} ({foldedItems.length})</summary>{(() => { const items = sorted(foldedItems, item => item.key); const keys = items.map(item => item.key); return items.map(item => row(item, keys)); })()}</details>}
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
