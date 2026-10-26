import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { GradeBand, GradeNeed } from '../../src/domain/grade.js';
import type { Client } from './client.js';
import type { AgentPreset } from './chat.js';
import type { Copy, Language } from './i18n.js';
import { agentEntries, arcPath, assessmentGroups, canJudge, fromCanvasApi, isNoMarks, isRemainder, policyView, valueLabel, courseFigures, displayStatus, levelView, minutesFrom, originOf, ownerValue, presetIds, ringSegments, sourceLink,
  type EditableField, type Field, type LevelView, type Policy, type WorkLevel } from './course.js';
import { CourseStore, type AssessmentItem, type CourseState } from './course-store.js';

type Props = { courseId: string; client: Client; t: Copy; language: Language; timeZone?: string; openAgent: (preset: AgentPreset) => void; onBack: () => void };
type Citation = Field['citations'][number];
const bands: GradeBand[] = ['H1', 'H2A', 'H2B', 'H3', 'P'];
const levels: WorkLevel[] = [0, 1, 2];
function errorText(code: string, t: Copy) { return code === 'OWNER_SESSION_EXPIRED' ? t.session : `${t.error} (${code})`; }

export function CoursePage({ courseId, client, t, language, timeZone, openAgent, onBack }: Props) {
  const store = useMemo(() => new CourseStore(client, courseId), [client, courseId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [tab, setTab] = useState<'assessments' | 'revision'>('assessments');
  const [open, setOpen] = useState<string>();
  const c = t.coursePage;
  useEffect(() => { void store.load(); }, [store]);
  const date = (value?: string) => value ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value)) : undefined;
  const number = (value: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
  const day = (value: string) => new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', timeZone }).format(new Date(value));
  // Labels (#171): an even split is marked derived; an unknown value shows when it was last checked.
  const value = (item: AssessmentItem, field: 'weight' | 'due') => {
    const label = valueLabel(item, field);
    if (label.kind === 'none') return c.none;
    if (label.kind === 'unknown') return <span className="unknown">{label.checkedAt ? c.unknownChecked.join(day(label.checkedAt)) : t.unknown}</span>;
    const shown = field === 'due' ? date(item.due) : `${number(item.weight!)}%`;
    return label.kind === 'derived' ? <span title={c.evenSplit}>≈ {shown}<small className="derived">{c.evenSplit}</small></span> : shown;
  };
  const rows = (items: AssessmentItem[]) => items.map(item => isRemainder(item) ? <div key={item.id} className="arow remainder" title={c.remainderHelp}>
    <span className="aname">{item.name}{item.kind && <span className={`kind ${item.kind}`}>{c.kinds[item.kind]}</span>}</span>
    <span className="muted">{c.notPublished}</span>
    <span className="num">{value(item, 'weight')}</span>
    <span className="num">{c.none}</span><span className="muted">{c.notPublished}</span><span>{c.none}</span>
  </div> : <button key={item.id} className="arow" onClick={() => { setOpen(item.id); void store.openAssessment(item.id); }}>
    <span className="aname">{item.name}{item.kind && <span className={`kind ${item.kind}`}>{c.kinds[item.kind]}</span>}</span>
    <span className="muted">{value(item, 'due')}</span>
    <span className="num">{value(item, 'weight')}</span>
    <span className="num points">{item.score === undefined ? c.none : `${item.platform?.pointsEarned !== undefined && item.platform.pointsPossible !== undefined
      ? `${number(item.platform.pointsEarned)}/${number(item.platform.pointsPossible)} · ` : ''}${number(item.score)}%`}</span>
    <span>{c.statuses[displayStatus(item)]}</span>
    <span><Level view={levelView(item, state.autonomy)} t={t} /></span>
  </button>);
  const policy: Policy | undefined = state.autonomy?.policy ?? undefined;
  const failed = (['autonomy', 'assessments', 'plan', 'revision', 'notes', 'stats'] as const).filter(key => state.errors[key]);
  if (state.errors.course) return <section className="card"><button className="crumb" onClick={onBack}>{c.back}</button><p>{state.errors.course === 'NOT_FOUND' ? c.notFound : errorText(state.errors.course, t)}</p></section>;
  if (!state.course) return <p role="status">{t.loading}</p>;
  const course = state.course;
  const selected = state.assessments?.find(item => item.id === open);
  return <div className="course-page">
    <button className="crumb" onClick={onBack}>{c.back}</button>
    <div className="chead"><h1>{course.code}</h1><span className="muted">{course.name}</span><small>{course.term}</small></div>
    {failed.length > 0 && <p role="status">{c.partial} {failed.map(key => state.errors[key]).join(', ')}</p>}
    {(!state.complete || !course.assessmentsComplete) && state.assessments && <p className="muted">{t.incomplete}</p>}
    {state.assessments && <ScoreCard course={course} items={state.assessments} t={t} />}
    <Header store={store} state={state} policy={policy} t={t} />
    <div className="tabs" role="tablist">{(['assessments', 'revision'] as const).map(item =>
      <button key={item} role="tab" id={`tab-${item}`} aria-controls={`panel-${item}`} aria-selected={tab === item} onClick={() => setTab(item)}>{c[item]}</button>)}</div>
    <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {tab === 'assessments' ? !state.assessments ? <p role="status">{state.errors.assessments ? errorText(state.errors.assessments, t) : t.loading}</p>
        : !state.assessments.length ? <p className="muted">{c.noAssessments}</p>
        : <div className="assessment-list">
          <div className="arow head" aria-hidden="true"><span>{c.name}</span><span>{c.due}</span><span className="num">{c.weight}</span><span className="num">{c.scoreCol}</span><span>{c.status}</span><span>{c.level}</span></div>
          {assessmentGroups(state.assessments.filter(item => !isNoMarks(item))).map((group, index, all) => <div className="agroup" role="group" key={group.key ?? `loose-${index}`} aria-label={group.name ?? c.otherGroup}>
            {(group.key !== undefined || all.length > 1) && <div className="ghead"><b>{group.name ?? c.otherGroup}</b>
              {group.key !== undefined && <span className="muted">{group.weight === undefined ? <span className="unknown">{t.unknown}</span> : `${number(group.weight)}%`}
                {' · '}{group.earned === undefined ? <span className="unknown">{c.earnedUnknown}</span> : <>{number(group.earned)} {c.groupEarned}</>}</span>}</div>}
            {rows(group.items)}
          </div>)}
          {state.assessments.some(isNoMarks) && <details className="no-marks">
            <summary>{c.noMarks} ({state.assessments.filter(isNoMarks).length})</summary>
            {assessmentGroups(state.assessments.filter(isNoMarks)).map((group, index) =>
              <div key={group.key ?? `loose-${index}`}>{rows(group.items)}</div>)}
          </details>}
        </div>
        : <Revision store={store} state={state} t={t} date={date} onPreset={id => openAgent({ id, courseId })} />}
    </section>
    {selected && <Drawer key={selected.id} store={store} state={state} item={selected} policy={policy} t={t} date={date} timeZone={timeZone}
      onClose={() => setOpen(undefined)} onPreset={id => openAgent({ id, courseId, assessmentId: selected.id })} />}
  </div>;
}

function Level({ view, t }: { view: LevelView; t: Copy }) {
  const c = t.coursePage;
  return view.kind === 'none' ? <span aria-label={c.none}>{c.none}</span>
    : view.kind === 'locked' ? <span className="pill lock" title={c.lockedHelp}>{c.locked}{view.origin && <span className="srcm"> · {c.policyOrigins[view.origin]}</span>}</span>
    : view.kind === 'unknown' ? <span className="unknown">{c.notReadable}</span>
    : <span className="pill">L{view.level}</span>;
}

function needText(need: GradeNeed, t: Copy) {
  const c = t.coursePage;
  if (need.status === 'score') return `${need.value.toFixed(1)}%${need.setByHurdle ? ` (${c.hurdle})` : ''}`;
  return need.status === 'unavailable' ? c[need.reason] : c[need.status];
}
function ScoreCard({ course, items, t }: { course: NonNullable<CourseState['course']>; items: AssessmentItem[]; t: Copy }) {
  const c = t.coursePage;
  const [band, setBand] = useState<GradeBand>('H1');
  const grooveId = useId();
  const figures = courseFigures(course, items, band);
  const segments = ringSegments(items);
  const unavailable = figures.need.status === 'unavailable';
  return <section className="card score" aria-label={c.score}>
    <svg className="donut" viewBox="0 0 170 170" role="img" aria-label={`${c.score}: ${figures.earned.toFixed(1)} ${c.earned}`}>
      <defs><filter id={grooveId} x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="1" result="blur" />
        <feOffset in="blur" dy="1.5" result="offset" />
        <feComposite in="SourceAlpha" in2="offset" operator="out" result="inner" />
        <feFlood floodColor="#000" floodOpacity="0.45" />
        <feComposite in2="inner" operator="in" />
        <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode /></feMerge>
      </filter></defs>
      <circle className="track" cx="85" cy="85" r="70" filter={`url(#${grooveId})`} />
      {segments.map((segment, index) => {
        // Gaps separate assessments, not the earned and lost parts of one assessment.
        const first = segments[index - 1]?.assessmentId !== segment.assessmentId;
        const last = segments[index + 1]?.assessmentId !== segment.assessmentId;
        const start = segment.start + (first ? 1.2 : 0), end = segment.end - (last ? 1.2 : 0);
        return end > start && <path key={`${segment.assessmentId}-${segment.style}`} className={segment.style === 'earned' ? 'earned' : 'not-earned'} d={arcPath(70, start, end)} />;
      })}
      <text x="85" y="90" className="total">{figures.earned.toFixed(1)}</text>
      <text x="85" y="110" className="caption">{c.earned}</text>
    </svg>
    <div>
      <div className="facts">
        <div><div className="v">{figures.currentAverage === null ? c.none : `${figures.currentAverage.toFixed(1)}%`}</div><div className="muted">{c.average}</div></div>
        <div><div className="v">{figures.gradedWeight}%</div><div className="muted">{c.progress}</div></div>
        <div><div className={unavailable ? 'v small' : 'v'}>{needText(figures.need, t)}</div>
          <label className="inline muted">{c.need} · {c.target}<select value={band} onChange={event => setBand(event.target.value as GradeBand)}>{bands.map(value => <option key={value}>{value}</option>)}</select></label></div>
      </div>
      <div className="key">{([['earned', c.kEarned], ['not-earned', c.kNotEarned]] as const).map(([style, label]) =>
        <span key={style}><i className={style} />{label}</span>)}</div>
    </div>
  </section>;
}

function Header({ store, state, policy, t }: { store: CourseStore; state: CourseState; policy?: Policy; t: Copy }) {
  const c = t.coursePage;
  // One policy field (#180): the owner's value wins over the agent-read one; the read value and its quote stay visible.
  const view = state.course ? policyView(state.course, state.autonomy) : {};
  const busy = !!state.saving || !store.client.hasSession();
  return <section className="policy">
    <label className="inline">{c.policy}
      <select value={policy ?? ''} disabled={busy} onChange={event => void store.setPolicy(event.target.value ? event.target.value as Policy : null)}>
        <option value="">{c.policyNone}</option>{(['allowed', 'prohibited', 'owner-attested'] as const).map(value => <option key={value} value={value}>{c[value]}</option>)}
      </select>{view.origin && <span className="srcm">· {c.policyOrigins[view.origin]}</span>}</label>
    {view.read && (view.origin !== 'agent' || view.quote) && <span className="policy-read">{c.policyRead}{t.colon}{c[view.read]}{view.quote && <> · <q>{view.quote}</q></>}</span>}
    {policy === 'prohibited' ? <span className="pill lock" title={c.lockedHelp}>{c.locked}</span> : <>
      <label className="inline">{c.defaultLevel}
        <select value={state.autonomy?.defaultLevel ?? ''} disabled={busy || !state.autonomy} onChange={event => void store.setDefault(Number(event.target.value) as WorkLevel)}>
          {!state.autonomy && <option value="" disabled>{c.notReadable}</option>}
          {levels.map(level => <option key={level} value={level}>{c.levelNames[level]}</option>)}
        </select></label>
    </>}
    {policy === 'prohibited' && <p className="muted help">{c.lockedHelp}</p>}
    {state.errors.write && <p role="status" className="error">{errorText(state.errors.write, t)}</p>}
  </section>;
}

/** Origin marker; agent values open their citations with confirm and "use my value". */
function Marker({ field, via, store, state, t, children }: { field?: Field; via?: string; store: CourseStore; state: CourseState; t: Copy; children?: (close: () => void) => ReactNode }) {
  const c = t.coursePage;
  const [open, setOpen] = useState(false);
  const origin = originOf(field);
  if (!origin) return null;
  if (origin !== 'agent') return <span className="srcm">· {fromCanvasApi(via) ? c.fromCanvasApi : c.origins[origin]}</span>;
  return <>
    <button className="srcm link" aria-expanded={open} title={c.originHelp} onClick={() => setOpen(!open)}>· {c.origins.agent} ⓘ</button>
    {open && <div className="cite-panel">
      <Quotes citations={field!.citations} store={store} state={state} t={t} />
      {field!.verdicts.length > 0 && <p className="muted">{field!.verdicts.at(-1)!.verdict === 'correct' ? c.confirmed : c.replaced}</p>}
      {canJudge(field) && children?.(() => setOpen(false))}
    </div>}
  </>;
}
function Quotes({ citations, store, state, t }: { citations: Citation[]; store: CourseStore; state: CourseState; t: Copy }) {
  const c = t.coursePage;
  useEffect(() => { for (const citation of citations) void store.source(citation.sourceItemId); }, [citations, store]);
  if (!citations.length) return <p className="muted">{c.sourceMissing}</p>;
  return <>{citations.map((citation, index) => {
    const source = state.sources[citation.sourceItemId];
    return <blockquote className="cite" key={`${citation.sourceItemId}-${index}`}><span className="visually-hidden">{c.quote}: </span>“{citation.quote}”
      <div className="src">{source ? <>{source.provenance === 'ed' ? 'Ed' : source.provenance === 'canvas' ? 'Canvas' : source.provenance} · {citation.locator}{' · '}
        {sourceLink(source.url) ? <a href={sourceLink(source.url)} target="_blank" rel="noreferrer noopener">{c.openSource}</a> : c.noLink}
        {source.copiedBy === 'agent' && <span className="copied" title={c.copiedHelp}>{' · '}{c.copiedByAgent}</span>}</>
        : state.errors.source ? c.sourceMissing : t.loading}</div></blockquote>;
  })}</>;
}
function Citations({ citations, store, state, t }: { citations: Citation[]; store: CourseStore; state: CourseState; t: Copy }) {
  const [open, setOpen] = useState(false);
  return <><button className="srcm link" aria-expanded={open} title={t.coursePage.originHelp} onClick={() => setOpen(!open)}>ⓘ</button>
    {open && <div className="cite-panel"><Quotes citations={citations} store={store} state={state} t={t} /></div>}</>;
}

function Drawer({ store, state, item, policy, t, date, timeZone, onClose, onPreset }: { store: CourseStore; state: CourseState; item: AssessmentItem; policy?: Policy; t: Copy; timeZone?: string;
  date: (value?: string) => string | undefined; onClose: () => void; onPreset: (id: string) => void }) {
  const c = t.coursePage;
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState<string>();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const detail = state.details[item.id];
  const fields = detail?.fields ?? item.fields ?? {};
  const work = state.work?.[item.id];
  const entries = agentEntries(item, policy);
  const view = levelView(item, state.autonomy);
  const entry = state.autonomy?.assessments.find(row => row.assessmentId === item.id);
  const recorded = state.recorded[item.id];
  const busy = !!state.saving || !store.client.hasSession();
  const display = (name: EditableField, value: unknown) => value === null || value === undefined ? <span className="unknown">{t.unknown}</span>
    : name === 'weight' || name === 'hurdleMin' ? `${String(value)}%` : name === 'kind' ? c.kinds[value as keyof typeof c.kinds] ?? String(value)
    : name === 'isFinal' ? value ? c.yes : c.no : name === 'due' ? date(String(value)) : String(value);
  async function submit(event: FormEvent<HTMLFormElement>, run: (value: string) => Promise<boolean>) {
    event.preventDefault(); setMessage(undefined);
    const form = event.currentTarget;
    try { if (await run(String(new FormData(form).get('value') ?? ''))) { setMessage(c.saved); form.reset(); } }
    catch { setMessage(c.invalid); }
  }
  const row = (name: EditableField) => {
    const field = fields[name];
    return <div className="field" key={name}><span className="k">{c[name]}</span><span>{display(name, field?.value)}</span>
      <Marker field={field} via={item.readState?.[name]?.via} store={store} state={state} t={t}>{close => <div className="verdicts">
        <button disabled={busy} onClick={() => void store.confirm('assessment', item.id, name, field!.annotationId!).then(ok => ok && close())}>{c.confirmValue}</button>
        <form onSubmit={event => void submit(event, value => store.replace('assessment', item.id, name, ownerValue(name, value, timeZone), field!.annotationId!))}>
          {name === 'kind' ? <select name="value" aria-label={c.useMine}>{(['quiz', 'participation', 'assignment', 'presentation', 'exam', 'ungraded'] as const).map(kind => <option key={kind} value={kind}>{c.kinds[kind]}</option>)}</select>
            : name === 'isFinal' ? <select name="value" aria-label={c.useMine}><option value="true">{c.yes}</option><option value="false">{c.no}</option></select>
            : <input name="value" aria-label={c.useMine} required type={name === 'due' ? 'datetime-local' : name === 'name' ? 'text' : 'number'} min="0" max="100" step={name === 'due' ? 60 : 'any'} />}
          <button type="submit" disabled={busy}>{c.useMine}</button></form></div>}</Marker></div>;
  };
  return <dialog ref={dialog} className="drawer" aria-labelledby="drawer-title" onClose={onClose}>
    <div className="dialog-heading"><div><small>{state.course?.code}</small><h2 id="drawer-title">{item.name}</h2></div><button onClick={() => dialog.current?.close()}>{t.close}</button></div>
    {state.errors.detail && <p role="status">{errorText(state.errors.detail, t)}</p>}
    {(['due', 'weight', 'kind', 'hurdleMin', 'isFinal'] as const).map(row)}
    {item.unlockAt && <div className="field"><span className="k">{c.unlockAt}</span><span>{date(item.unlockAt)}</span></div>}
    <div className="field"><span className="k">{c.scoreCol}</span><span>{item.score === undefined ? c.none : `${item.score}%`}</span>{item.score !== undefined && <span className="srcm">· {fromCanvasApi(item.readState?.score?.via) ? c.fromCanvasApi : c.origins.platform}</span>}</div>
    <div className="field"><span className="k">{c.status}</span><span>{c.statuses[displayStatus(item)]}</span><span className="srcm">· {fromCanvasApi(item.readState?.status?.via) ? c.fromCanvasApi : c.origins.platform}</span></div>
    {item.kind !== 'exam' && <div className="field"><span className="k">{c.level}</span><Level view={view} t={t} />
      {view.kind !== 'locked' && policy !== 'prohibited' && <select aria-label={c.level} disabled={busy || !entry} value={!entry ? '' : entry.override === null ? 'default' : String(entry.override)}
        onChange={event => void store.setOverride(item.id, event.target.value === 'default' ? null : Number(event.target.value) as WorkLevel)}>
        {!entry && <option value="" disabled>{c.notReadable}</option>}
        <option value="default">{c.follow}</option>{levels.map(level => <option key={level} value={level}>{c.levelNames[level]}</option>)}</select>}</div>}
    <h3>{c.savedFiles}</h3>
    {!item.savedFiles?.length ? <p className="muted">{c.noSavedFiles}</p> : <ul className="saved-files">{item.savedFiles.map(file =>
      <li key={file.id}><button className="link" disabled={busy} onClick={() => void store.openFile(file.id)}>{file.name}</button>
        <small className="muted"> · {c.savedOn}{date(file.savedAt)}</small>
        {file.updated && <span className="pill updated">{c.updatedMarker}</span>}
        {!file.current && <span className="muted"> · {c.supersededMarker}</span>}</li>)}</ul>}
    <h3>{c.estimate}</h3>
    {state.errors.plan ? <p className="muted">{errorText(state.errors.plan, t)}</p> : !state.work ? <p role="status">{t.loading}</p> : !work ? <p className="muted">{c.notPlanned}</p> : <>
      <div className="field"><span className="k">{c.estimate}</span><span>{work.estimateMinutes === undefined ? <span className="unknown">{c.unestimated}</span> : `${work.estimateMinutes} ${c.minutes}`}</span>
        {work.estimateOrigin && <span className="srcm">· {c.origins[work.estimateOrigin]}</span>}</div>
      {work.agentEstimate && <p className="muted">{c.origins.agent}: {work.agentEstimate.minutes} {c.minutes}{work.agentEstimate.reason && <> · {c.reason}: {work.agentEstimate.reason}</>}</p>}
      <form className="inline-form" onSubmit={event => void submit(event, value => store.setEstimate(item.id, minutesFrom(value)))}>
        <label>{c.setEstimate}<input name="value" type="number" min="1" step="1" required /></label><button type="submit" disabled={busy}>{c.save}</button></form>
    </>}
    {item.kind !== 'exam' && <>
      <div className="field"><span className="k">{c.actual}</span><span>{work ? `${work.actualMinutes} ${c.minutes}` : <span className="unknown">{c.actualUnreadable}</span>}
        {!work && recorded !== undefined && <small> · {recorded} {c.minutes} {c.recordedNow}</small>}</span><span /></div>
      <form className="inline-form" onSubmit={event => void submit(event, value => store.recordTime(item.id, minutesFrom(value)))}>
        <label>{c.addTime}<input name="value" type="number" min="1" step="1" required /></label><button type="submit" disabled={busy}>{c.record}</button></form>
    </>}
    {message && <p role="status">{message}</p>}
    {state.errors.write && <p role="status" className="error">{errorText(state.errors.write, t)}</p>}
    <h3>{c.linked}</h3>
    {!detail ? <p role="status">{t.loading}</p> : !detail.links.length && !state.tasks[item.id]?.length ? <p className="muted">{c.noLinked}</p> : <ul className="linked">
      {detail.links.map(link => <LinkedItem key={link.sourceItemId} id={link.sourceItemId} store={store} state={state} t={t} />)}
      {state.tasks[item.id]?.map(task => <li key={task.id}>{task.title} <small>{c.tasks}: {task.steps.filter(step => step.done).length}/{task.steps.length} {c.done}</small></li>)}
    </ul>}
    {(entries.start || entries.complete || entries.explain) && <div className="preset-row">
      {entries.start && <button className="primary" onClick={() => onPreset(presetIds.start)}>{c.start}</button>}
      {entries.complete && <button className={entries.start ? undefined : 'primary'} onClick={() => onPreset(presetIds.complete)}>{c.complete}</button>}
      {entries.explain && <button onClick={() => onPreset(presetIds.explain)}>{c.explain}</button>}</div>}
  </dialog>;
}
function LinkedItem({ id, store, state, t }: { id: string; store: CourseStore; state: CourseState; t: Copy }) {
  useEffect(() => { void store.source(id); }, [id, store]);
  const source = state.sources[id];
  const platform = source?.provenance === 'ed' ? 'Ed' : source?.provenance === 'canvas' ? 'Canvas' : source?.provenance;
  return <li>{source ? <>{platform} · {source.locator} {sourceLink(source.url) && <a href={sourceLink(source.url)} target="_blank" rel="noreferrer noopener">{t.coursePage.openSource}</a>}</> : state.errors.source ? t.coursePage.sourceMissing : t.loading}</li>;
}

function Revision({ store, state, t, date, onPreset }: { store: CourseStore; state: CourseState; t: Copy; date: (value?: string) => string | undefined; onPreset: (id: string) => void }) {
  const c = t.coursePage;
  const stats = state.stats;
  return <div className="revision">
    <div className="field"><span className="k">{c.examTime}</span><span>{state.errors.revision ? errorText(state.errors.revision, t) : !state.revision ? t.loading
      : date(state.revision.examTime) ?? <span className="unknown">{t.unknown}</span>}</span><span /></div>
    <h3>{c.scope}</h3>
    {!state.revision ? null : !state.revision.examScope ? <p className="muted">{c.noScope}</p> : <ul className="topics">
      {state.revision.examScope.topics.map((topic, index) => <li key={index}>{topic.text} <Citations citations={topic.citations} store={store} state={state} t={t} /></li>)}</ul>}
    <h3>{c.notes}</h3>
    {state.errors.notes ? <p>{errorText(state.errors.notes, t)}</p> : !state.notes ? <p role="status">{t.loading}</p> : !state.notes.length ? <p className="muted">{c.noNotes}</p>
      : <ul className="topics">{state.notes.flatMap(record => record.type === 'exam-scope' ? [] : record.claims.map((claim, index) =>
        <li key={`${record.id}-${index}`}>{claim.text} {record.week !== undefined && <small>{c.week[0]}{record.week}{c.week[1]}</small>} <Citations citations={claim.citations} store={store} state={state} t={t} /></li>))}</ul>}
    <div className="revgo">
      <div><b>{c.practice}</b> {state.errors.stats ? errorText(state.errors.stats, t) : !stats ? t.loading : !stats.questions ? c.noPractice
        : <span className="muted">{stats.questions} {c.questions} · {c.attempted} {stats.attempted} · {c.correct} {stats.correct} · {c.incorrect} {stats.incorrect}</span>}</div>
      <button className="primary" onClick={() => onPreset(presetIds.tutor)}>{c.tutor}</button>
      <button disabled={!stats?.incorrect} onClick={() => onPreset(presetIds.wrong)}>{c.wrong}</button>
    </div>
  </div>;
}
