import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { Copy, Language } from './i18n.js';
import type { WeekStore, ManualFields } from './weekStore.js';
import { addDays, courseSummaries, deadlinesByDate, localDate, localTime, mondayOf, monthGrid, weekModel, zonedIso, type DeadlineEntry, type Need, type PlannedItem, type Task, type WorkRow } from './week.js';

const hours = (minutes: number) => `${Math.round(minutes / 6) / 10}`;
function errorText(code: string, t: Copy) { return code === 'OWNER_SESSION_EXPIRED' ? t.session : `${t.error} (${code})`; }
function scrollTo(id: string) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

export function NeedsYou({ needs, t, onStatus, onAgent }: { needs: Need[]; t: Copy; onStatus: () => void; onAgent: () => void }) {
  if (!needs.length) return null;
  return <section className="needs" aria-labelledby="needs-title"><h2 id="needs-title">{t.needs}</h2>{needs.map(item => {
    const site = 'site' in item ? item.site === 'ed' ? 'Ed' : 'Canvas' : '';
    const [text, action, run] = item.kind === 'confirm' ? [`${t.confirmPending}: ${item.summary}`, t.openAgent, onAgent]
      : item.kind === 'signin' ? [`${site} · ${t.signin}`, t.status, onStatus]
      : item.kind === 'sync' ? [`${site} · ${t.syncFailed}`, t.status, onStatus]
      : item.kind === 'overflow' ? [`${item.courseCode ? `${item.courseCode} · ` : ''}${item.title} · ${t.overflowMissing} ${hours(item.minutes)} ${t.h}`, t.show, () => scrollTo('overflow')]
      : [`${item.count} ${t.unestimatedCount}`, t.show, () => scrollTo('unestimated')];
    const key = item.kind === 'confirm' ? item.id : item.kind === 'overflow' ? item.workId : 'site' in item ? `${item.kind}-${item.site}` : item.kind;
    return <div className="attention-row" key={`${item.kind}-${key}`}><span>{text}</span><button onClick={run}>{action}</button></div>;
  })}</section>;
}

function Modal({ title, close, onClose, children }: { title: string; close: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} onClose={onClose} aria-labelledby="week-dialog-title">
    <div className="dialog-heading"><h2 id="week-dialog-title">{title}</h2><button onClick={() => ref.current?.close()}>{close}</button></div>{children}
  </dialog>;
}

type Dialog = { kind: 'item'; item: PlannedItem; date: string } | { kind: 'manual'; task?: Task } | undefined;
export function WeekView({ store, t, language, canWrite, settingsMissing, onOpenCourse, onOpenSettings }: {
  store: WeekStore; t: Copy; language: Language; canWrite: boolean; settingsMissing: boolean;
  onOpenCourse: (courseId: string) => void; onOpenSettings: () => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [focus, setFocus] = useState<string>();
  const [mode, setMode] = useState<'plan' | 'month'>('plan');
  const [dialog, setDialog] = useState<Dialog>();
  const today = state.today ?? localDate(new Date(), state.timeZone);
  const month = focus ?? today; const current = mondayOf(month);
  const zone = state.timeZone;
  const courses = useMemo(() => (state.courses ?? []).filter(course => course.term === state.term), [state.courses, state.term]);
  const tasks = useMemo(() => state.tasks ?? [], [state.tasks]); const assessments = useMemo(() => state.assessments ?? [], [state.assessments]);
  const model = useMemo(() => weekModel({ plan: state.plan, courses, assessments, tasks, monday: current, timeZone: zone }), [state.plan, courses, assessments, tasks, current, zone]);
  const deadlines = useMemo(() => deadlinesByDate({ plan: state.plan, courses, assessments, tasks, timeZone: zone }), [state.plan, courses, assessments, tasks, zone]);
  const summaries = useMemo(() => courseSummaries(courses, assessments, new Date(), state.plan), [courses, assessments, state.plan]);
  const dayName = (date: string, style: 'short' | 'long' = 'short') => new Intl.DateTimeFormat(language, { weekday: style, day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const shortDate = (date: string) => new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const dueText = (due?: string) => due ? new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(due)) : t.unknown;
  const shift = (direction: number) => setFocus(mode === 'plan' ? addDays(current, 7 * direction)
    : new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 + direction, 1, 12)).toISOString().slice(0, 10));
  const range = mode === 'plan' ? `${shortDate(current)} – ${shortDate(addDays(current, 6))}`
    : new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month.slice(0, 7)}-15T12:00:00Z`));
  const modules = [...courses.reduce((map, course) => map.set(course.moduleId, [...map.get(course.moduleId) ?? [], course.code]), new Map<string, string[]>())]
    .map(([id, codes]): [string, string] => [id, codes.join(' / ')]);
  const deadline = (entry: DeadlineEntry) => {
    const label = `${entry.kind === 'exam' ? `${t.exam} ${entry.time}` : entry.kind === 'all-day' ? t.allDay : `${t.due} ${entry.time}`} · ${entry.courseCode ? `${entry.courseCode} · ` : ''}${entry.title}`;
    const task = entry.manual ? tasks.find(item => item.id === entry.id) : undefined;
    return task ? <button key={entry.id} className={`due${entry.kind === 'all-day' ? ' all-day' : ''}`} onClick={() => setDialog({ kind: 'manual', task })}>{label}</button>
      : <span key={entry.id} className={`due${entry.done ? ' done' : ''}`} title={label}>{label}</span>;
  };
  const rows = (id: string, title: string, items: WorkRow[], empty: string, render: (item: WorkRow) => string) => <section className="plan-list" id={id} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{title}</h3>{items.length ? <ul>{items.map(item => <li key={item.workId}>{render(item)}</li>)}</ul> : <p className="muted">{empty}</p>}
  </section>;
  const planError = state.errors.plan;
  return <div className="week-layout">
    <div className="week-main">
      <div className="week-toolbar">
        <div className="week-nav" role="group" aria-label={t.weekNav}>
          <button onClick={() => shift(-1)} aria-label={mode === 'plan' ? t.prevWeek : t.prevMonth}>‹</button>
          <button onClick={() => setFocus(undefined)}>{t.today}</button>
          <button onClick={() => shift(1)} aria-label={mode === 'plan' ? t.nextWeek : t.nextMonth}>›</button>
          <span className="range" aria-live="polite">{range}</span>
        </div>
        <div className="week-actions">
          {state.term && <span className="muted">{t.term}: {state.term}</span>}
          <div className="seg" role="group" aria-label={t.viewMode}>{(['plan', 'month'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{t[value === 'plan' ? 'planView' : 'monthView']}</button>)}</div>
          <button disabled={!canWrite || !modules.length} title={!modules.length ? t.noModule : undefined} onClick={() => setDialog({ kind: 'manual' })}>{t.addTask}</button>
        </div>
      </div>
      {state.errors.action && <p role="status">{errorText(state.errors.action, t)}</p>}
      {planError && <p className="card notice" role="status">{planError === 'SOURCE_UNAVAILABLE' && settingsMissing ? <>{t.needSettings} <button onClick={onOpenSettings}>{t.settings}</button></> : errorText(planError, t)}</p>}
      {(state.errors.assessments || state.errors.tasks) && <p role="status">{t.error}</p>}
      {mode === 'month' ? <div className="card month" role="grid" aria-label={range}>
        <div className="month-row" role="row">{Array.from({ length: 7 }, (_, index) => <div key={index} className="dow" role="columnheader">{new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${addDays('2026-01-05', index)}T12:00:00Z`))}</div>)}</div>
        {monthGrid(month, deadlines).map(week => <div className="month-row" role="row" key={week[0]!.date}>{week.map(cell => <div role="gridcell" key={cell.date} className={`cell${cell.inMonth ? '' : ' out'}${cell.date === today ? ' today' : ''}`}>
          <button className="num" aria-label={`${dayName(cell.date, 'long')} ${shortDate(cell.date)}`} onClick={() => { setFocus(cell.date); setMode('plan'); }}>{+cell.date.slice(8)}</button>
          {cell.deadlines.map(deadline)}
        </div>)}</div>)}
      </div> : <div className="card week-card">
        <div className="week-grid">{model.days.map(day => <section key={day.date} className={`day${day.date === today ? ' today' : ''}${day.date < today ? ' past' : ''}`} aria-label={dayName(day.date, 'long')}>
          <div className="day-head"><b>{dayName(day.date)}</b><span className="hours-used">{hours(day.usedMinutes)} / {day.availableMinutes === undefined ? '—' : hours(day.availableMinutes)} {t.h}</span></div>
          <div className="day-deadlines" aria-label={t.deadlines}>{day.deadlines.map(deadline)}</div>
          <div className="day-items">{day.items.length ? day.items.map(item => <button key={item.workId} className={`blk${item.manual ? ' manual' : ''}`} onClick={() => setDialog({ kind: 'item', item, date: day.date })}>
            <span className="tm">{item.startTime ?? t.noTime} · {hours(item.minutes)} {t.h}</span><span className="tt">{item.title}</span>
            <span className="cr">{item.manual ? t.personal : item.courseCode ?? t.unknown}{item.actualMinutes ? ` · ${t.recorded} ${hours(item.actualMinutes)} ${t.h}` : ''}</span>
          </button>) : <span className="muted empty-day">{t.noPlan}</span>}</div>
        </section>)}</div>
        <div className="plan-lists">
          {rows('overflow', t.overflow, model.overflow, t.noneListed, item => `${item.courseCode ? `${item.courseCode} · ` : item.manual ? `${t.personal} · ` : ''}${item.title} · ${t.overflowMissing} ${hours(item.minutes ?? 0)} ${t.h} · ${t.due} ${dueText(item.due)}`)}
          {rows('unestimated', t.unestimated, model.unestimated, t.noneListed, item => `${item.courseCode ? `${item.courseCode} · ` : item.manual ? `${t.personal} · ` : ''}${item.title} · ${t.estimate} ${t.unknown} · ${t.due} ${dueText(item.due)}`)}
        </div>
      </div>}
    </div>
    <aside className="rail card" aria-labelledby="rail-title"><h2 id="rail-title">{t.courses}</h2>
      {summaries.length ? summaries.map(course => <button key={course.id} className="crs" onClick={() => onOpenCourse(course.id)}>
        <Ring fraction={course.gradedWeight / 100} unknown={course.unknownWeight} label={`${course.gradedWeight}% ${t.graded}${course.unknownWeight ? ` · ${t.weightUnknown}` : ''}`} />
        <span><b>{course.code}</b><small className="crs-name">{course.name}</small>
          {course.undatedExams.map(title => <small key={title} className="exam-unknown">{t.exam}: {title} · {t.examTimeUnknown}</small>)}
          <small>{t.next}: {course.next ? `${dueText(course.next.due)} · ${course.next.title}` : t.none}</small></span>
      </button>) : <p className="muted">{t.noCourses}</p>}
    </aside>
    {dialog?.kind === 'item' && <ItemDialog key={`${dialog.item.workId}-${dialog.date}`} store={store} t={t} item={dialog.item} date={dialog.date} canWrite={canWrite}
      task={dialog.item.manual ? tasks.find(task => task.id === dialog.item.workId) : undefined} onEdit={task => setDialog({ kind: 'manual', task })} onClose={() => setDialog(undefined)} />}
    {dialog?.kind === 'manual' && <ManualDialog store={store} t={t} task={dialog.task} modules={modules} timeZone={zone} canWrite={canWrite}
      estimate={dialog.task ? state.plan?.work.find(work => work.workId === dialog.task!.id)?.estimateMinutes : undefined} onClose={() => setDialog(undefined)} />}
  </div>;
}

function Ring({ fraction, unknown, label }: { fraction: number; unknown: boolean; label: string }) {
  const circumference = 2 * Math.PI * 18;
  return <svg className={`ring${unknown ? ' unknown' : ''}`} viewBox="0 0 44 44" role="img" aria-label={label}><title>{label}</title>
    <circle className="bg" cx="22" cy="22" r="18" /><circle className="fg" cx="22" cy="22" r="18" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, fraction)))} />
  </svg>;
}

function ItemDialog({ store, t, item, date, task, canWrite, onEdit, onClose }: { store: WeekStore; t: Copy; item: PlannedItem; date: string; task?: Task; canWrite: boolean; onEdit: (task: Task) => void; onClose: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [message, setMessage] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function run(action: () => Promise<boolean>, done: string) { setMessage(undefined); if (await action()) setMessage(done); }
  function start(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const time = String(new FormData(event.currentTarget).get('time')); if (time) void run(() => store.setStart(item.workId, date, time), t.saved); }
  function actual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const minutes = Number(new FormData(form).get('minutes'));
    if (Number.isInteger(minutes) && minutes > 0) void run(() => store.recordTime(item.workId, minutes), t.saved).then(() => form.reset()); else setMessage(t.invalidMinutes);
  }
  const disabled = !canWrite || state.busy;
  return <Modal title={item.title} close={t.close} onClose={onClose}>
    <p className="muted">{item.manual ? t.personal : item.courseCode ?? t.unknown} · {date} · {t.planned} {hours(item.minutes)} {t.h} · {t.estimate} {item.estimateMinutes === undefined ? t.unknown : `${hours(item.estimateMinutes)} ${t.h}`} · {t.recorded} {hours(item.actualMinutes)} {t.h}</p>
    <form className="inline-form" onSubmit={start}><label>{t.startTime}<input name="time" type="time" required defaultValue={item.startTime ?? ''} /></label>
      <button type="submit" disabled={disabled}>{t.setStart}</button>
      {item.startTime && <button type="button" disabled={disabled} onClick={() => void run(() => store.clearStart(item.workId, date), t.saved)}>{t.clearStart}</button>}</form>
    <form className="inline-form" onSubmit={actual}><label>{t.actualMinutes}<input name="minutes" type="number" min="1" step="1" required /></label><button type="submit" disabled={disabled}>{t.record}</button></form>
    {task && <div className="dialog-actions"><button disabled={disabled} onClick={() => onEdit(task)}>{t.editTask}</button>
      <button disabled={disabled} onClick={() => void run(() => store.completeManual(task.id), t.saved).then(onClose)}>{t.complete}</button>
      <button disabled={disabled} onClick={() => confirmDelete ? void store.deleteManual(task.id).then(ok => ok && onClose()) : setConfirmDelete(true)}>{confirmDelete ? t.confirmDelete : t.delete}</button></div>}
    {state.busy && <p role="status">{t.saving}</p>}
    {message && <p role="status">{message}</p>}
    {state.errors.action && <p role="status">{errorText(state.errors.action, t)}</p>}
  </Modal>;
}

function ManualDialog({ store, t, task, modules, timeZone, estimate, canWrite, onClose }: { store: WeekStore; t: Copy; task?: Task; modules: [string, string][]; timeZone: string; estimate?: number; canWrite: boolean; onClose: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [allDay, setAllDay] = useState(!!task?.allDay);
  const [message, setMessage] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(undefined);
    const data = new FormData(event.currentTarget);
    const date = String(data.get('date') ?? ''); const time = String(data.get('time') ?? ''); const rawEstimate = String(data.get('estimate') ?? '').trim();
    const estimateMinutes = rawEstimate ? Number(rawEstimate) : undefined;
    if (estimateMinutes !== undefined && (!Number.isInteger(estimateMinutes) || estimateMinutes <= 0) || allDay && !date) { setMessage(t.invalidTask); return; }
    // A date without a time means the end of that local day; all-day tasks only carry their date.
    const fields: ManualFields = { title: String(data.get('title')).trim(), ...(date ? { due: zonedIso(date, allDay ? '12:00' : time || '23:59', timeZone) } : {}),
      ...(estimateMinutes !== undefined && !allDay ? { estimateMinutes } : {}), allDay };
    if (await (task ? store.editManual(task.id, fields) : store.createManual(String(data.get('module')), fields))) onClose();
  }
  return <Modal title={task ? t.editTask : t.addTask} close={t.close} onClose={onClose}>
    <form onSubmit={event => void submit(event)}>
      <label>{t.taskTitle}<input name="title" required maxLength={1024} defaultValue={task?.title ?? ''} /></label>
      {!task && <label>{t.module}<select name="module" required aria-describedby="module-help">{modules.map(([id, codes]) => <option key={id} value={id}>{codes}</option>)}</select>
        <small id="module-help">{t.moduleHelp}</small></label>}
      <label className="check"><input type="checkbox" checked={allDay} onChange={event => setAllDay(event.target.checked)} />{t.allDay}</label>
      <div className="field-pair"><label>{t.dueDate}<input name="date" type="date" required={allDay} defaultValue={task?.due ? localDate(task.due, timeZone) : ''} /></label>
        {!allDay && <label>{t.dueTime}<input name="time" type="time" defaultValue={task?.due && !task.allDay ? localTime(task.due, timeZone) : ''} /></label>}</div>
      {!allDay && <label>{t.estimateMinutes}<input name="estimate" type="number" min="1" step="1" defaultValue={estimate ?? ''} placeholder={t.unknown} /></label>}
      <div className="dialog-actions"><button type="submit" disabled={!canWrite || state.busy}>{state.busy ? t.saving : task ? t.save : t.create}</button>
        {task && <><button type="button" disabled={!canWrite || state.busy} onClick={() => void store.completeManual(task.id).then(ok => ok && onClose())}>{t.complete}</button>
          <button type="button" disabled={!canWrite || state.busy} onClick={() => confirmDelete ? void store.deleteManual(task.id).then(ok => ok && onClose()) : setConfirmDelete(true)}>{confirmDelete ? t.confirmDelete : t.delete}</button></>}</div>
      {message && <p role="status">{message}</p>}
      {state.errors.action && <p role="status">{errorText(state.errors.action, t)}</p>}
    </form>
  </Modal>;
}
