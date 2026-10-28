import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ShellStore, attention, emptyStore } from './shell.js';
import { en, zh, type Copy, type Language, type Theme } from './i18n.js';
import { WeekStore } from './weekStore.js';
import { needsYou, weekModel } from './week.js';
import { NeedsYou, WeekView } from './WeekView.js';
import { AgentPage } from './Agent.js';
import type { AgentPreset } from './chat.js';
import { CoursePage } from './CoursePage.js';
import { LocalCourseSelect } from './LocalCourseSelect.js';
import { LocalPlanning } from './LocalPlanning.js';

type Panel = 'status' | 'settings';
type CourseRun = { running: boolean; courses: { id: string; code: string; status: string; reason: string; phase?: string; file?: string }[]; error: string | null };
type TokenUsage = { input: number | null; output: number | null; cached: number | null; reasoning: number | null };
type SyncUsage = { type: string; runId: string; at: string; course: string; courses: { code: string; status: string }[]; model: string; status: string; durationMs: number | null; coordinator: TokenUsage | null; subagents: TokenUsage | null };
type SyncBatch = { id: string; at: string; durationMs: number | null; ended: boolean; legacy: boolean; selected: { code: string; status: string }[]; courses: SyncUsage[] };
type SyncModal = 'discovery' | 'select' | 'starting' | 'syncing' | 'stopping' | 'finished';
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
  const [avatarImage, setAvatarImage] = useState(() => preference('coursework.avatar') ?? '');
  const [avatarError, setAvatarError] = useState('');
  const [syncUsage, setSyncUsage] = useState<SyncUsage[]>();
  const [usageError, setUsageError] = useState(false);
  const [view, setView] = useState<View>(() => { const conversationId = new URLSearchParams(window.location.search).get('conversation'); return conversationId ? { page: 'agent', conversationId } : { page: 'week' }; });
  const [week] = useState(() => new WeekStore(store.client));
  const weekState = useSyncExternalStore(week.subscribe, week.getSnapshot);
  const openAgent = (preset?: AgentPreset) => setView({ page: 'agent', preset });
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<Panel>();
  const [localSyncing, setLocalSyncing] = useState(false);
  const [localSyncError, setLocalSyncError] = useState('');
  const [courseRefresh, setCourseRefresh] = useState(0);
  const [coursePanelOpen, setCoursePanelOpen] = useState(() => !selectionExists());
  const [savedNotice, setSavedNotice] = useState(0);
  const [localSyncWarning, setLocalSyncWarning] = useState('');
  const [courseRun, setCourseRun] = useState<CourseRun>();
  const [courseRunError, setCourseRunError] = useState('');
  const [syncModal, setSyncModal] = useState<SyncModal>();
  const syncDialog = useRef<HTMLDialogElement>(null);
  const cancelledDiscovery = useRef(false);
  const cancelDuringStart = useRef(false);
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
  useEffect(() => { const element = syncDialog.current; if (!element) return; if (syncModal && !element.open) element.showModal(); else if (!syncModal && element.open) element.close(); }, [syncModal]);
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
          && 'courses' in next && Array.isArray(next.courses)) { const run = next as CourseRun; setCourseRun(run); setSyncModal(current => run.running ? (current === 'stopping' ? current : 'syncing') : current === 'syncing' || current === 'stopping' ? 'finished' : current); }
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
  async function loadSyncUsage() {
    setUsageError(false);
    try {
      const response = await fetch('/api/local/sync-usage', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json() as { items: SyncUsage[] };
      if (!Array.isArray(data.items)) throw new Error('unavailable');
      setSyncUsage(data.items);
    } catch { setUsageError(true); }
  }
  function open(next: Panel) { setMenu(false); setPanel(next); if (next === 'status') void loadSyncUsage(); }
  function close() { dialog.current?.close(); setPanel(undefined); avatar.current?.focus(); }
  async function syncCourses() {
    if (running) return;
    cancelledDiscovery.current = false; setSyncModal('discovery'); setCourseRun(undefined); setLocalSyncing(true); setLocalSyncError(''); setLocalSyncWarning('');
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
      if (!cancelledDiscovery.current) { setSyncModal('select'); setCoursePanelOpen(false); }
      setView({ page: 'week' });
    } catch (error) { if (!cancelledDiscovery.current) setLocalSyncError(error instanceof Error ? error.message : t.error); setSyncModal('finished'); }
    finally { setLocalSyncing(false); }
  }
  async function startSelectedCourses(ids: string[]) {
    if (!ids.length) return;
    cancelDuringStart.current = false; setCourseRunError(''); setSyncModal('starting');
    try {
      const response = await fetch('/api/local/course-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!response.ok) throw new Error(response.status === 409
        ? (language === 'zh' ? '已有课程同步正在进行，选择已保存，但新同步尚未启动。' : 'A course sync is running. Selection saved, but a new sync was not started.')
        : (language === 'zh' ? '无法启动课程同步，选择已保存。' : 'Could not start course sync. Your selection was saved.'));
      const run = await response.json() as CourseRun; setCourseRun(run);
      if (cancelDuringStart.current) { const stopped = await fetch('/api/local/course-sync', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }); if (!stopped.ok) throw new Error(language === 'zh' ? '无法中止同步，请重试。' : 'Could not stop sync.'); setCourseRun(await stopped.json() as CourseRun); setSyncModal('stopping'); }
      else setSyncModal('syncing');
    } catch (error) { setCourseRunError(error instanceof Error ? error.message : t.error); setSyncModal('finished'); }
  }
  async function stopSync() {
    if (syncModal === 'select') { setSyncModal('finished'); return; }
    if (syncModal === 'starting') { cancelDuringStart.current = true; setSyncModal('stopping'); return; }
    const discovery = syncModal === 'discovery';
    if (discovery) cancelledDiscovery.current = true;
    setSyncModal('stopping');
    try {
      const response = await fetch(discovery ? '/api/local/sync-courses' : '/api/local/course-sync', { method: 'DELETE', headers: discovery ? undefined : { 'Content-Type': 'application/json' } });
      if (!response.ok) throw new Error(language === 'zh' ? '无法中止同步，请重试。' : 'Could not stop sync. Please retry.');
      if (discovery) setSyncModal('finished');
      else { const run = await response.json() as CourseRun; setCourseRun(run); if (!run.running) setSyncModal('finished'); }
    } catch (error) { setCourseRunError(error instanceof Error ? error.message : t.error); setSyncModal(discovery ? 'discovery' : 'syncing'); }
  }
  const syncButton = <button disabled={!!running} onClick={() => void syncCourses()} aria-busy={!!running}>{running ? t.syncing : t.sync}</button>;
  const syncBatches = groupSyncUsage(syncUsage ?? []);
  return <>
    <header>
      <span className="brand"><span className="brand-dot" />coursework</span>
      <nav aria-label="coursework">
        {(['week', 'agent'] as const).map(item => <button key={item} aria-current={view.page === item ? 'page' : undefined} onClick={() => item === 'agent' ? openAgent() : setView({ page: item })}>{t[item]}</button>)}
      </nav>
      <div className="header-actions">{syncButton}
        <div className="avatar-wrap" ref={menuRoot} onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); avatar.current?.focus(); } }}>
          <button className="avatar" ref={avatar} aria-label={t.menu} aria-expanded={menu} aria-controls="owner-menu" onClick={() => setMenu(!menu)}>{avatarImage ? <img src={avatarImage} alt="" /> : 'Y'}</button>
          {!!needs.length && <span className="badge" />}
          {menu && <div id="owner-menu" className="menu"><button onClick={() => open('status')}>{language === 'zh' ? '同步数据' : 'Sync data'}</button><button onClick={() => open('settings')}>{t.settings}</button></div>}
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
      {view.page === 'agent' && !store.client.hasSession() && <p className="needs" role="status">{t.session}</p>}
      {view.page === 'agent' && state.errors.action && <p role="status">{errorText(state.errors.action, t)}</p>}
      {view.page !== 'course' && <div className="page-heading"><h1>{t[view.page]}</h1><button onClick={() => { setCourseRefresh(value => value + 1); void refreshAll(); }}>{t.refresh}</button></div>}
      {view.page === 'agent' ? <AgentPage key={view.navigation} client={store.client} t={t} language={language} preset={view.preset} conversationId={view.conversationId} onPresetDone={() => setView({ page: 'agent' })} />
        : <LocalPlanning language={language} refreshVersion={courseRefresh} courseId={view.page === 'course' ? view.courseId : undefined}
          syncIssues={courseRun?.courses ?? []} onCourse={courseId => setView({ page: 'course', courseId })} onBack={() => setView({ page: 'week' })} />}
    </main>
    <dialog ref={syncDialog} className="sync-dialog" aria-labelledby="sync-title" onCancel={event => event.preventDefault()}>
      <h2 id="sync-title">{language === 'zh' ? (syncModal === 'finished' ? '同步结果' : '正在同步课程') : (syncModal === 'finished' ? 'Sync results' : 'Syncing courses')}</h2>
      {syncModal === 'select' ? <LocalCourseSelect language={language} refreshVersion={courseRefresh} onSaved={ids => { setSavedNotice(Date.now()); setCourseRefresh(value => value + 1); if (ids.length) void startSelectedCourses(ids); else setSyncModal('finished'); }} /> : <>
        {syncModal !== 'finished' && <><p>{language === 'zh' ? '同步中，请保持 Edge 和 coursework 页面打开。' : 'Syncing. Please keep Edge and the coursework page open.'}</p><div className="sync-indeterminate" role="progressbar" aria-label={language === 'zh' ? '同步进行中' : 'Sync in progress'}><span /></div></>}
        {syncModal === 'discovery' && <p>{language === 'zh' ? '正在获取课程列表…' : 'Fetching course list…'}</p>}
        {syncModal === 'starting' && <p>{language === 'zh' ? '正在启动课程同步…' : 'Starting course sync…'}</p>}
        {syncModal === 'stopping' && <p>{language === 'zh' ? '正在中止，请稍候…' : 'Stopping…'}</p>}
        {courseRun && courseRun.courses.length > 0 && <><p>{language === 'zh' ? '已处理' : 'Processed'} {courseRun.courses.filter(course => ['completed', 'partial', 'failed'].includes(course.status)).length} / {courseRun.courses.length}</p>{courseRun.courses.map(course => <div className="sync-course" key={course.id}><b>{course.code}</b><span>{({ pending: language === 'zh' ? '等待' : 'Waiting', running: course.phase === 'canvas' ? (language === 'zh' ? '获取 LMS 信息中' : 'Fetching LMS data') : course.phase === 'ed' ? (language === 'zh' ? '获取 Ed 信息中' : 'Fetching Ed data') : course.phase === 'waiting_analysis' ? (language === 'zh' ? '等待 Agent 分析' : 'Waiting for agent') : course.phase === 'handbook' ? (language === 'zh' ? '获取 Handbook 信息中' : 'Fetching Handbook data') : course.phase === 'analysis' ? (language === 'zh' ? 'Agent 分析中' : 'Agent analysing') : course.phase === 'saving' ? (language === 'zh' ? '校验与保存中' : 'Validating and saving') : (language === 'zh' ? '准备中' : 'Starting'), completed: language === 'zh' ? '已完成' : 'Completed', partial: language === 'zh' ? '部分完成' : 'Partial', failed: language === 'zh' ? '未完成' : 'Failed', cancelled: language === 'zh' ? '已中止' : 'Stopped' } as Record<string,string>)[course.status] ?? course.status}</span>{course.status === 'failed' && course.reason && <small>{course.reason}</small>}</div>)}</>}
        {(localSyncError || courseRunError || courseRun?.error) && <p role="alert">{localSyncError || courseRunError || courseRun?.error}</p>}
      </>}
      {syncModal === 'finished' ? <button onClick={() => setSyncModal(undefined)}>{language === 'zh' ? '关闭' : 'Close'}</button> : <button disabled={syncModal === 'stopping'} onClick={() => void stopSync()}>{language === 'zh' ? '中止同步' : 'Stop sync'}</button>}
    </dialog>
    <dialog ref={dialog} onCancel={close} onClose={() => { setPanel(undefined); avatar.current?.focus(); }} aria-labelledby="panel-title">
      <div className="dialog-heading"><h2 id="panel-title">{panel === 'status' ? (language === 'zh' ? '同步数据' : 'Sync data') : panel ? t[panel] : ''}</h2><button onClick={close}>{t.close}</button></div>
      {panel === 'status' && <>
        <button onClick={() => void loadSyncUsage()}>{t.refresh}</button>
        {usageError && <p role="status">{language === 'zh' ? '无法读取同步记录。' : 'Could not read sync records.'}</p>}
        {!syncUsage && !usageError && <p>{t.loading}</p>}
        {syncUsage?.length === 0 && <p className="muted">{language === 'zh' ? '暂无同步记录。' : 'No sync records yet.'}</p>}
        {syncBatches.length > 0 && <><p className="sync-usage-caption">{language === 'zh' ? '最近一次' : 'Latest sync'}</p><SyncBatchRow key={syncBatches[0]!.id} batch={syncBatches[0]!} language={language} initiallyOpen />{syncBatches.length > 1 && <details className="sync-usage-history"><summary>{language === 'zh' ? '历史记录' : 'History'}</summary><div className="sync-batch-list">{syncBatches.slice(1).map(batch => <SyncBatchRow key={batch.id} batch={batch} language={language} />)}</div></details>}</>}
      </>}
      {panel === 'settings' && <>
        <div className="avatar-settings"><span className="avatar-preview">{avatarImage ? <img src={avatarImage} alt="" /> : 'Y'}</span><div><label className="avatar-upload">{language === 'zh' ? '上传头像' : 'Upload photo'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return;
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setAvatarError(language === 'zh' ? '请选择不超过 2 MB 的 JPG、PNG 或 WebP 图片。' : 'Choose a JPG, PNG or WebP image up to 2 MB.'); return; }
          const reader = new FileReader(); reader.onerror = () => setAvatarError(language === 'zh' ? '图片读取失败。' : 'Could not read the image.');
          reader.onload = () => { if (typeof reader.result !== 'string') return; try { localStorage.setItem('coursework.avatar', reader.result); setAvatarImage(reader.result); setAvatarError(''); } catch { setAvatarError(language === 'zh' ? '头像保存失败，请检查浏览器存储。' : 'Could not save the photo in this browser.'); } };
          reader.readAsDataURL(file);
        }} /></label>{avatarImage && <button onClick={() => { try { localStorage.removeItem('coursework.avatar'); setAvatarImage(''); setAvatarError(''); } catch { setAvatarError(language === 'zh' ? '头像移除失败。' : 'Could not remove the photo.'); } }}>{language === 'zh' ? '移除' : 'Remove'}</button>}</div></div>
        {avatarError && <p role="alert">{avatarError}</p>}
        <div className="preferences"><label>{t.theme}<select value={theme} onChange={event => setTheme(event.target.value as Theme)}>{(['system', 'light', 'dark'] as const).map(value => <option key={value} value={value}>{t[value]}</option>)}</select></label>
          <label>{t.language}<select value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="en">English</option><option value="zh">中文</option></select></label></div>
      </>}
    </dialog>
  </>;
}

function groupSyncUsage(rows: SyncUsage[]): SyncBatch[] {
  const batches = new Map<string, SyncBatch>();
  const legacy: SyncBatch[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.runId) {
      if (row.type === 'course' && row.course) legacy.push({ id: `legacy-${index}-${row.at}`, at: row.at, durationMs: row.durationMs, ended: true, legacy: true, selected: [{ code: row.course, status: row.status }], courses: [row] });
      continue;
    }
    const batch = batches.get(row.runId) ?? { id: row.runId, at: row.at, durationMs: null, ended: false, legacy: false, selected: [], courses: [] };
    if (row.type === 'batch_start') { batch.at = row.at; if (!batch.selected.length) batch.selected = row.courses; }
    else if (row.type === 'batch_end') { batch.ended = true; batch.durationMs = row.durationMs; batch.selected = row.courses; }
    else if (row.type === 'course' && row.course) batch.courses.push(row);
    batches.set(row.runId, batch);
  }
  return [...batches.values(), ...legacy].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

function usageTokens(row: SyncUsage | undefined): number | null {
  const usage = row?.coordinator;
  if (usage?.input == null || usage.output == null) return null;
  if (row?.subagents && (row.subagents.input == null || row.subagents.output == null)) return null;
  return usage.input + usage.output + (row?.subagents?.input ?? 0) + (row?.subagents?.output ?? 0);
}

function SyncBatchRow({ batch, language, initiallyOpen = false }: { batch: SyncBatch; language: Language; initiallyOpen?: boolean }) {
  const zh = language === 'zh';
  const when = batch.at && !Number.isNaN(Date.parse(batch.at)) ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(batch.at)) : '—';
  const selected = batch.selected.length ? batch.selected : batch.courses.map(row => ({ code: row.course, status: row.status }));
  const entries = selected.map(course => ({ ...course, row: batch.courses.find(item => item.course === course.code) }));
  const totals = entries.map(entry => usageTokens(entry.row));
  const tokenTotal = totals.length && totals.every(total => total !== null) ? totals.reduce<number>((sum, total) => sum + (total ?? 0), 0) : null;
  const seconds = (ms: number | null) => ms === null ? '—' : `${(ms / 1000).toFixed(1)} ${zh ? '秒' : 's'}`;
  return <details className="sync-batch" open={initiallyOpen || undefined}>
    <summary><span><strong>{when}</strong><small>{batch.legacy ? (zh ? '早期单课记录' : 'Earlier course record') : !batch.ended ? (zh ? '未完成' : 'Incomplete') : `${entries.length} ${zh ? '门课程' : 'courses'}`}</small></span><span>{seconds(batch.durationMs)}</span><span>{tokenTotal?.toLocaleString() ?? '—'} Token</span></summary>
    <div className="sync-batch-courses">{entries.map(({ code, status, row }, index) => <div className="sync-batch-course" key={`${code}-${index}`}><span>{code}{status === 'cancelled' ? (zh ? ' · 已中止' : ' · Stopped') : status === 'failed' ? (zh ? ' · 未完成' : ' · Failed') : ''}</span><span>{seconds(row?.durationMs ?? null)}</span><span>{usageTokens(row)?.toLocaleString() ?? '—'} Token</span></div>)}</div>
    {!batch.legacy && <p className="sync-batch-note">{zh ? '耗时从保存选课后开始计算。' : 'Duration starts after courses are selected.'}</p>}
  </details>;
}
