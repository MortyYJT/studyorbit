import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ShellStore, attention, emptyStore, settingsFromForm, type Settings } from './shell.js';
import { en, zh, type Copy, type Language, type Theme } from './i18n.js';
import { WeekStore } from './weekStore.js';
import { needsYou, weekModel } from './week.js';
import { NeedsYou, WeekView } from './WeekView.js';
import { AgentPage } from './Agent.js';
import type { AgentPreset } from './chat.js';
import { MemoryPanel } from './MemoryPanel.js';
import { MetricsPanel } from './MetricsPanel.js';
import { CoursePage } from './CoursePage.js';
import { CourseSelect } from './CourseSelect.js';
import { LocalCourseSelect } from './LocalCourseSelect.js';
import { LocalPlanning } from './LocalPlanning.js';

type Panel = 'memory' | 'status' | 'audit' | 'settings' | 'metrics';
type CourseRun = { running: boolean; courses: { id: string; code: string; status: string; reason: string; file?: string }[]; error: string | null };
/** Navigation state; a preset is cleared once its conversation exists, so it is never sent twice. */
export type View = { page: 'week' } | { page: 'agent'; preset?: AgentPreset; conversationId?: string; navigation?: number } | { page: 'course'; courseId: string };
function preference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function remember(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Preferences remain usable in memory. */ } }
function selectionExists(): boolean { try { return localStorage.getItem('coursework.selected-course-ids') !== null; } catch { return false; } }
function errorText(code: string, t: Copy): string {
  return code === 'OWNER_SESSION_EXPIRED' ? t.session : code === 'AUTH_EXPIRED' ? t.auth : `${t.error} (${code})`;
}
export function App({ store }: { store: ShellStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [language, setLanguage] = useState<Language>(() => preference('coursework.language') === 'en' ? 'en' : 'zh');
  const [theme, setTheme] = useState<Theme>(() => { const value = preference('coursework.theme'); return value === 'system' || value === 'dark' ? value : 'light'; });
  const [view, setView] = useState<View>(() => { const conversationId = new URLSearchParams(window.location.search).get('conversation'); return conversationId ? { page: 'agent', conversationId } : { page: 'week' }; });
  const [week] = useState(() => new WeekStore(store.client));
  const weekState = useSyncExternalStore(week.subscribe, week.getSnapshot);
  const openAgent = (preset?: AgentPreset) => setView({ page: 'agent', preset });
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<Panel>();
  const [selecting, setSelecting] = useState(false);
  const [localSyncing, setLocalSyncing] = useState(false);
  const [localSyncError, setLocalSyncError] = useState('');
  const [courseRefresh, setCourseRefresh] = useState(0);
  const [coursePanelOpen, setCoursePanelOpen] = useState(() => !selectionExists());
  const [savedNotice, setSavedNotice] = useState(0);
  const [localSyncWarning, setLocalSyncWarning] = useState('');
  const [courseRun, setCourseRun] = useState<CourseRun>();
  const [courseRunError, setCourseRunError] = useState('');
  const conversationNavigation = useRef(0);
  const resultSignature = useRef('');
  const dialog = useRef<HTMLDialogElement>(null);
  const avatar = useRef<HTMLButtonElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const t = language === 'zh' ? zh : en;
  const rows = useMemo(() => weekModel({ plan: weekState.plan, courses: weekState.courses ?? [], assessments: [], tasks: weekState.tasks ?? [], monday: weekState.today ?? '1970-01-05', timeZone: weekState.timeZone }), [weekState]);
  const needs = needsYou({ attention: attention(state), overflow: rows.overflow, unestimated: rows.unestimated,
    conflicts: state.conflicts?.items ?? [], updates: state.updates?.items ?? [] });
  const refreshAll = () => Promise.all([store.refresh(), week.refresh()]);
  const running = localSyncing || state.syncing || state.sync?.running || courseRun?.running;
  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => { void refreshAll(); }, 30000);
    return () => window.clearInterval(timer);
  }, [store, week]);
  useEffect(() => { document.documentElement.dataset.theme = theme; remember('coursework.theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; remember('coursework.language', language); }, [language]);
  useEffect(() => { if (panel) dialog.current?.showModal(); }, [panel]);
  useEffect(() => {
    if (!savedNotice) return;
    const timer = window.setTimeout(() => setSavedNotice(0), 3000);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);
  useEffect(() => {
    let stopped = false;
    async function refreshRun() {
      try {
        const response = await fetch('/api/local/course-sync', { cache: 'no-store' });
        if (!response.ok) return;
        const next: unknown = await response.json();
        if (!stopped && next && typeof next === 'object' && 'running' in next && typeof next.running === 'boolean'
          && 'courses' in next && Array.isArray(next.courses)) setCourseRun(next as CourseRun);
      } catch { /* A later refresh can recover without hiding previous status. */ }
    }
    void refreshRun();
    const timer = window.setInterval(() => void refreshRun(), 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const signature = JSON.stringify(courseRun?.courses.map(course => [course.id, course.status, course.file]) ?? []);
    if (signature !== resultSignature.current) { resultSignature.current = signature; setCourseRefresh(value => value + 1); }
  }, [courseRun]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  function open(next: Panel) { setMenu(false); setPanel(next); if (next === 'audit') void store.loadAudit(); }
  function close() { dialog.current?.close(); setPanel(undefined); avatar.current?.focus(); }
  async function syncCourses() {
    if (running) return;
    setLocalSyncing(true); setLocalSyncError(''); setLocalSyncWarning('');
    try {
      const response = await fetch('/api/local/sync-courses', { method: 'POST' });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => undefined);
        const detail = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '';
        throw new Error(detail || (response.status === 409 ? (language === 'zh' ? '同步正在进行中。' : 'A sync is already running.') : t.error));
      }
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('ok' in data) || data.ok !== true) throw new Error(t.error);
      if ('warning' in data && typeof data.warning === 'string') setLocalSyncWarning(data.warning);
      setCourseRefresh(value => value + 1);
      setCoursePanelOpen(true);
      setView({ page: 'week' });
    } catch (error) { setLocalSyncError(error instanceof Error ? error.message : t.error); }
    finally { setLocalSyncing(false); }
  }
  async function startSelectedCourses(ids: string[]) {
    if (!ids.length) return;
    setCourseRunError('');
    try {
      const response = await fetch('/api/local/course-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!response.ok) throw new Error(response.status === 409
        ? (language === 'zh' ? '已有课程同步正在进行，选择已保存，但新同步尚未启动。' : 'A course sync is running. Selection saved, but a new sync was not started.')
        : (language === 'zh' ? '无法启动课程同步，选择已保存。' : 'Could not start course sync. Your selection was saved.'));
      setCourseRun(await response.json() as CourseRun);
    } catch (error) { setCourseRunError(error instanceof Error ? error.message : t.error); }
  }
  const syncButton = <button disabled={!!running} onClick={() => void syncCourses()} aria-busy={!!running}>{running ? t.syncing : t.sync}</button>;
  function date(value?: string) { return value ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: state.planning?.settings?.timeZone }).format(new Date(value)) : t.never; }
  return <>
    <header>
      <span className="brand"><span className="brand-dot" />coursework</span>
      <nav aria-label="coursework">
        {(['week', 'agent'] as const).map(item => <button key={item} aria-current={view.page === item ? 'page' : undefined} onClick={() => item === 'agent' ? openAgent() : setView({ page: item })}>{t[item]}</button>)}
      </nav>
      <div className="header-actions">{syncButton}
        <div className="avatar-wrap" ref={menuRoot} onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); avatar.current?.focus(); } }}>
          <button className="avatar" ref={avatar} aria-label={t.menu} aria-expanded={menu} aria-controls="owner-menu" onClick={() => setMenu(!menu)}>Y</button>
          {!!needs.length && <span className="badge" />}
          {menu && <div id="owner-menu" className="menu">{(['status', 'metrics', 'memory', 'audit', 'settings'] as const).map(item => <button key={item} onClick={() => open(item)}>{t[item]}</button>)}</div>}
        </div>
      </div>
    </header>
    <main>
      {localSyncError && <p className="needs" role="status" style={{ whiteSpace: 'pre-wrap' }}>{localSyncError}</p>}
      {localSyncWarning && <p className="needs" role="status">{localSyncWarning}</p>}
      {courseRunError && <p className="needs" role="status">{courseRunError}</p>}
      {view.page === 'week' && (coursePanelOpen
        ? <LocalCourseSelect language={language} refreshVersion={courseRefresh} onSaved={ids => { setCoursePanelOpen(false); setSavedNotice(Date.now()); setCourseRefresh(value => value + 1); void startSelectedCourses(ids); }} />
        : <button className="edit-courses" disabled={courseRun?.running} onClick={() => setCoursePanelOpen(true)}>{language === 'zh' ? '修改选课' : 'Edit courses'}</button>)}
      {savedNotice > 0 && <div className="save-toast" role="status">{language === 'zh' ? '课程已经保存' : 'Courses saved'}</div>}
      {view.page === 'week' && courseRun?.running && courseRun.courses.length > 0 && <section className="card course-sync-status" aria-live="polite">
        <h2>{language === 'zh' ? (courseRun.running ? '正在同步课程' : '课程同步结果') : (courseRun.running ? 'Syncing courses' : 'Course sync results')}</h2>
        {courseRun.courses.map(course => <div className="attention-row" key={course.id}>
          <span><b>{course.code}</b> · {({ pending: language === 'zh' ? '等待' : 'Waiting', running: language === 'zh' ? '读取中' : 'Reading',
            completed: language === 'zh' ? '已完成' : 'Completed', partial: language === 'zh' ? '部分完成' : 'Partial', failed: language === 'zh' ? '未完成' : 'Failed' } as Record<string, string>)[course.status] ?? course.status}
            {course.reason && <small> · {course.reason}</small>}{course.file && <small> · {course.file}</small>}</span>
        </div>)}
        {courseRun.error && <p role="status">{courseRun.error}</p>}
      </section>}
      {view.page === 'agent' && !store.client.hasSession() && <p className="needs" role="status">{t.session}</p>}
      {view.page === 'agent' && state.errors.action && <p role="status">{errorText(state.errors.action, t)}</p>}
      {view.page === 'agent' && <NeedsYou needs={needs} t={t} onStatus={() => open('status')} onSelect={() => setSelecting(true)}
        onCourse={courseId => setView({ page: 'course', courseId })}
        onResolve={(conflictId, choice) => void store.resolveConflict(conflictId, choice)}
        onOpenUpdate={savedFileId => void store.openUpdate(savedFileId)} />}
      {view.page !== 'course' && <div className="page-heading"><h1>{t[view.page]}</h1><button onClick={() => { setCourseRefresh(value => value + 1); void refreshAll(); }}>{t.refresh}</button></div>}
      {view.page === 'agent' ? <AgentPage key={view.navigation} client={store.client} t={t} language={language} preset={view.preset} conversationId={view.conversationId} onPresetDone={() => setView({ page: 'agent' })} />
        : <LocalPlanning language={language} refreshVersion={courseRefresh} courseId={view.page === 'course' ? view.courseId : undefined}
          syncIssues={courseRun?.courses ?? []} onCourse={courseId => setView({ page: 'course', courseId })} onBack={() => setView({ page: 'week' })} />}
    </main>
    {selecting && <CourseSelect store={store} t={t} onClose={() => { setSelecting(false); void week.refresh(); }} />}
    <dialog ref={dialog} onCancel={close} onClose={() => { setPanel(undefined); avatar.current?.focus(); }} aria-labelledby="panel-title">
      <div className="dialog-heading"><h2 id="panel-title">{panel ? t[panel] : ''}</h2><button onClick={close}>{t.close}</button></div>
      {panel === 'status' && <><button onClick={() => void store.refresh()}>{t.refresh}</button>
        {(['canvas', 'ed'] as const).map(site => <section className="provider" key={site}><h3>{site === 'ed' ? 'Ed' : 'Canvas'}</h3>
          <dl><dt>{t.syncNeeds.lastRun}</dt><dd>{state.errors.sync ? t.unavailable : !state.sync?.lastRun ? t.never
              : state.sync.blocked.includes(site) ? <b>{t.syncNeeds.blocked}</b> : t.syncNeeds.outcomes[state.sync.lastRun.outcome]}</dd></dl>
          {state.sync?.blocked.includes(site) && <p className="muted">{t.syncNeeds.blockedHelp.join(site === 'ed' ? 'Ed' : 'Canvas')}</p>}
        </section>)}
        {state.sync && <section className="provider"><h3>{t.syncNeeds.lastRun}</h3>
          {state.sync.running && <p role="status">{t.syncNeeds.running}</p>}
          {!state.sync.lastRun ? <p className="muted">{t.never}</p> : <dl>
            <dt>{t.syncNeeds.outcome}</dt><dd>{t.syncNeeds.outcomes[state.sync.lastRun.outcome]}</dd>
            <dt>{t.syncNeeds.ended}</dt><dd>{date(state.sync.lastRun.endedAt)}</dd>
            <dt>{t.syncNeeds.turns} · {t.syncNeeds.steps}</dt><dd>{state.sync.lastRun.turns} · {state.sync.lastRun.steps}</dd>
            <dt>{t.syncNeeds.blocked}</dt><dd>{state.sync.blocked.length ? state.sync.blocked.map(site => site === 'ed' ? 'Ed' : 'Canvas').join(', ') : t.syncNeeds.none}</dd>
          </dl>}
          <div className="row-heading"><h3>{t.syncNeeds.selected}</h3><button disabled={!store.client.hasSession()} onClick={() => { close(); setSelecting(true); }}>{t.syncNeeds.choose}</button></div>
          {!state.sync.courses.length ? <p className="muted">{t.syncNeeds.noSelected}</p> : <dl>{state.sync.courses.flatMap(course => [
            <dt key={`${course.key}-t`}>{course.code}{course.name ? ` · ${course.name}` : ''}</dt>,
            <dd key={`${course.key}-d`}>{course.storedAt ? date(course.storedAt) : t.syncNeeds.notStored}</dd>])}</dl>}
        </section>}
        {state.errors.sync && <p role="status">{t.error}</p>}
      </>}
      {panel === 'memory' && <MemoryPanel client={store.client} t={t} language={language} courses={state.courses?.items ?? []} timeZone={state.planning?.settings?.timeZone}
        onConversation={conversationId => { close(); setView({ page: 'agent', conversationId, navigation: ++conversationNavigation.current }); }} />}
      {panel === 'metrics' && <MetricsPanel client={store.client} t={t} language={language} timeZone={state.planning?.settings?.timeZone} />}
      {panel === 'audit' && <><button disabled={state.auditLoading} onClick={() => void store.loadAudit()}>{t.refresh}</button>
        {state.errors.audit && <p role="status">{errorText(state.errors.audit, t)}</p>}
        {!state.audit && !state.errors.audit && <p>{t.loading}</p>}
        {state.audit && <>{!state.audit.coverage.complete && <p>{t.incomplete}</p>}{!state.audit.items.length && <p>{t.noAudit}</p>}
          <div className="audit-list">{state.audit.items.map((row, index) => <article key={`${row.id}-${index}`}><strong>{row.command}</strong><dl>
            <dt>{t.time}</dt><dd>{date(row.at)}</dd><dt>{t.phase}</dt><dd>{row.phase}</dd><dt>{t.outcome}</dt><dd>{row.code} {row.outcome} {row.reason}</dd>
            {(row.courseId || row.assessmentId) && <><dt>{t.context}</dt><dd>{row.courseId} {row.assessmentId}</dd></>}
          </dl></article>)}</div>{state.audit.nextCursor && <button disabled={state.auditLoading} onClick={() => void store.loadAudit(true)}>{t.more}</button>}</>}
        {state.auditLoading && <p role="status">{t.loading}</p>}
      </>}
      {panel === 'settings' && <>
        <div className="preferences"><label>{t.theme}<select value={theme} onChange={event => setTheme(event.target.value as Theme)}>{(['system', 'light', 'dark'] as const).map(value => <option key={value} value={value}>{t[value]}</option>)}</select></label>
          <label>{t.language}<select value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="en">English</option><option value="zh">中文</option></select></label></div>
        {state.errors.planning ? <p>{t.settingsLoad}</p> : !state.planning ? <p>{t.loading}</p> : <SettingsForm key={JSON.stringify(state.planning.settings)} previous={state.planning.settings} store={store} t={t} />}
      </>}
    </dialog>
  </>;
}
function SettingsForm({ previous, store, t }: { previous?: Settings; store: ShellStore; t: Copy }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [message, setMessage] = useState<'invalid' | 'saved'>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(undefined);
    const data = new FormData(event.currentTarget);
    let settings: Settings;
    try { settings = settingsFromForm(previous, Array.from({ length: 7 }, (_, index) => String(data.get(`day${index}`))), String(data.get('timezone')), String(data.get('anchor') ?? ''), String(data.get('breaks') ?? '')); }
    catch { setMessage('invalid'); return; }
    if (await store.saveSettings(settings)) setMessage('saved');
  }
  return <form onSubmit={event => void submit(event)}>
    {!previous && <p className="muted">{t.settingsHelp}</p>}
    <fieldset><legend>{t.hours}</legend><div className="hours">{(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((day, index) => <label key={day}>{t[day]}<input name={`day${index}`} type="number" min="0" max="24" step="any" required defaultValue={previous ? previous.weekdayMinutes[index]! / 60 : ''} placeholder={t.unknown} /></label>)}</div></fieldset>
    <label>{t.timezone}<input name="timezone" required defaultValue={previous?.timeZone ?? ''} placeholder={t.unknown} /></label>
    {!previous && <><label>{t.anchor}<input name="anchor" type="date" required /></label><label>{t.breaks}<input name="breaks" /></label></>}
    <button type="submit" disabled={state.saving || !store.client.hasSession()}>{state.saving ? t.saving : t.save}</button>
    {message && <p role="status">{t[message]}</p>}
    {state.errors.action && <p role="status">{errorText(state.errors.action, t)}</p>}
  </form>;
}
