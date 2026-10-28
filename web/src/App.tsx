import { useEffect, useRef, useState } from 'react';
import { en, zh, type Language, type Theme } from './i18n.js';
import { LocalCourseSelect } from './LocalCourseSelect.js';
import { LocalPlanning, type SidebarCourse } from './LocalPlanning.js';

type Panel = 'status' | 'settings';
type CourseRun = { running: boolean; courses: { id: string; code: string; status: string; reason: string; phase?: string; file?: string }[]; error: string | null };
type TokenUsage = { input: number | null; output: number | null; cached: number | null; reasoning: number | null };
type SyncUsage = { type: string; runId: string; at: string; course: string; courses: { code: string; status: string }[]; model: string; status: string; durationMs: number | null; coordinator: TokenUsage | null; subagents: TokenUsage | null; recovered: boolean };
type SyncBatch = { id: string; at: string; durationMs: number | null; ended: boolean; legacy: boolean; recovered: boolean; selected: { code: string; status: string }[]; courses: SyncUsage[] };
type SyncModal = 'discovery' | 'select' | 'starting' | 'syncing' | 'stopping' | 'finished';
/** Navigation state for the three pages of the shell. */
export type View = { page: 'week' } | { page: 'agent' } | { page: 'course'; courseId: string };
function preference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function remember(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Preferences remain usable in memory. */ } }
function selectionExists(): boolean { try { return localStorage.getItem('coursework.selected-course-ids') !== null; } catch { return false; } }
export function App() {
  const [language, setLanguage] = useState<Language>(() => preference('coursework.language') === 'en' ? 'en' : 'zh');
  const [theme, setTheme] = useState<Theme>(() => { const value = preference('coursework.theme'); return value === 'system' || value === 'dark' ? value : 'light'; });
  const [avatarImage, setAvatarImage] = useState(() => preference('coursework.avatar') ?? '');
  const [avatarError, setAvatarError] = useState('');
  const [syncUsage, setSyncUsage] = useState<SyncUsage[]>();
  const [usageError, setUsageError] = useState(false);
  const [view, setView] = useState<View>({ page: 'week' });
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<Panel>();
  const [localSyncing, setLocalSyncing] = useState(false);
  const [localSyncError, setLocalSyncError] = useState('');
  const [courseRefresh, setCourseRefresh] = useState(0);
  const [coursePanelOpen, setCoursePanelOpen] = useState(() => !selectionExists());
  const [savedNotice, setSavedNotice] = useState(0);
  const [sidebarCourses, setSidebarCourses] = useState<SidebarCourse[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [localSyncWarning, setLocalSyncWarning] = useState('');
  const [courseRun, setCourseRun] = useState<CourseRun>();
  const [courseRunError, setCourseRunError] = useState('');
  const [syncModal, setSyncModal] = useState<SyncModal>();
  const syncDialog = useRef<HTMLDialogElement>(null);
  const selectDialog = useRef<HTMLDialogElement>(null);
  const cancelledDiscovery = useRef(false);
  const cancelDuringStart = useRef(false);
  const resultSignature = useRef('');
  const dialog = useRef<HTMLDialogElement>(null);
  const avatar = useRef<HTMLButtonElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const t = language === 'zh' ? zh : en;
  const running = localSyncing || courseRun?.running;
  useEffect(() => { document.documentElement.dataset.theme = theme; remember('coursework.theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; remember('coursework.language', language); }, [language]);
  useEffect(() => { if (panel) dialog.current?.showModal(); }, [panel]);
  // Page change fades the content in (design prototype motion) without remounting the page state.
  const mainRef = useRef<HTMLElement>(null);
  const pageKey = view.page === 'course' ? `course:${view.courseId}` : view.page;
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    mainRef.current?.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 350, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }, [pageKey]);
  useEffect(() => { const element = selectDialog.current; if (!element) return; if (coursePanelOpen && !element.open) element.showModal(); else if (!coursePanelOpen && element.open) element.close(); }, [coursePanelOpen]);
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
  const go = (next: View) => { setView(next); setNavOpen(false); };
  const isZh = language === 'zh';
  const title = view.page === 'agent' ? t.agent : (isZh ? '本周' : 'This week');
  const syncButton = <button disabled={!!running} onClick={() => void syncCourses()} aria-busy={!!running}>{running ? t.syncing : t.sync}</button>;
  const syncBatches = groupSyncUsage(syncUsage ?? []);
  return <div className="shell">
    <aside className={`sidebar${navOpen ? ' open' : ''}`}>
      <div className="sidebar-top">
        <span className="brand"><Mark />coursework</span>
        <span className="sidebar-page">{view.page === 'course' ? sidebarCourses.find(course => course.id === view.courseId)?.code ?? '' : title}</span>
        <button className="nav-toggle ghost" aria-expanded={navOpen} aria-controls="sidebar-body" onClick={() => setNavOpen(!navOpen)}>{navOpen ? t.close : (isZh ? '菜单' : 'Menu')}</button>
      </div>
      <div className="sidebar-body" id="sidebar-body">
        <nav className="nav" aria-label="coursework">
          <button className="nav-item" aria-current={view.page === 'week' ? 'page' : undefined} onClick={() => go({ page: 'week' })}>{isZh ? '本周' : 'This week'}</button>
          <button className="nav-item" aria-current={view.page === 'agent' ? 'page' : undefined} onClick={() => go({ page: 'agent' })}>{t.agent}</button>
        </nav>
        <div className="nav-group">
          <h2 className="nav-label">{t.courses}</h2>
          {sidebarCourses.length ? sidebarCourses.map(course => <button key={course.id} className="nav-item course-item" aria-current={view.page === 'course' && view.courseId === course.id ? 'page' : undefined}
            title={course.name} onClick={() => go({ page: 'course', courseId: course.id })}>
            <span className="course-code">{course.code}</span>
            <small className="course-graded" title={isZh ? '已出分占比' : 'Graded weight'}>{course.graded === undefined ? '—' : `${Number(course.graded.toFixed(1))}%`}</small>
            <small className="course-name">{course.name}</small>
          </button>) : <p className="muted nav-empty">{isZh ? '同步并选择课程后显示。' : 'Sync and select courses.'}</p>}
        </div>
        <div className="sidebar-foot">
          {syncButton}
          <div className="owner" ref={menuRoot} onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); avatar.current?.focus(); } }}>
            <button className="owner-button ghost" ref={avatar} aria-label={t.menu} aria-expanded={menu} aria-controls="owner-menu" onClick={() => setMenu(!menu)}>
              <span className="avatar" aria-hidden="true">{avatarImage ? <img src={avatarImage} alt="" /> : 'Y'}</span><span>{isZh ? '同步数据 · 设置' : 'Sync data · Settings'}</span></button>
            {menu && <div id="owner-menu" className="menu"><button onClick={() => { setNavOpen(false); open('status'); }}>{isZh ? '同步数据' : 'Sync data'}</button><button onClick={() => { setNavOpen(false); open('settings'); }}>{t.settings}</button></div>}
          </div>
        </div>
      </div>
    </aside>
    <main className="canvas" ref={mainRef}>
      {localSyncError && <p className="error-line" role="status" style={{ whiteSpace: 'pre-wrap' }}><i className="signal" aria-hidden="true" />{localSyncError}</p>}
      {localSyncWarning && <p className="error-line" role="status"><i className="signal" aria-hidden="true" />{localSyncWarning}</p>}
      {courseRunError && <p className="error-line" role="status"><i className="signal" aria-hidden="true" />{courseRunError}</p>}
      {view.page !== 'course' && <div className="page-heading"><h1>{title}</h1><button className="ghost" onClick={() => setCourseRefresh(value => value + 1)}>{t.refresh}</button></div>}
      {savedNotice > 0 && <div className="save-toast" role="status">{isZh ? '课程已经保存' : 'Courses saved'}</div>}
      {view.page === 'agent' ? <p className="muted">{t.agentComing}</p>
        : <LocalPlanning language={language} refreshVersion={courseRefresh} courseId={view.page === 'course' ? view.courseId : undefined} onCourses={setSidebarCourses}
          syncIssues={courseRun?.courses ?? []} onCourse={courseId => go({ page: 'course', courseId })} onBack={() => go({ page: 'week' })} />}
    </main>
    <dialog ref={selectDialog} className="select-dialog" aria-labelledby="select-title" onCancel={event => { event.preventDefault(); setCoursePanelOpen(false); }}>
      <div className="dialog-heading"><h2 id="select-title" tabIndex={-1} autoFocus>{isZh ? '修改选课' : 'Edit courses'}</h2><button className="ghost" onClick={() => setCoursePanelOpen(false)}>{t.close}</button></div>
      <p className="select-note"><i className="signal" aria-hidden="true" />{isZh ? '保存后会立即开始同步所选课程（会使用 Edge、Ed 和模型额度）。' : 'Saving starts a sync of the selected courses right away (uses Edge, Ed and model quota).'}</p>
      {coursePanelOpen && <LocalCourseSelect language={language} refreshVersion={courseRefresh} onSaved={ids => { setCoursePanelOpen(false); setSavedNotice(Date.now()); setCourseRefresh(value => value + 1); void startSelectedCourses(ids); }} />}
    </dialog>
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
      <div className="dialog-heading"><h2 id="panel-title" tabIndex={-1} autoFocus>{panel === 'status' ? (language === 'zh' ? '同步数据' : 'Sync data') : panel ? t[panel] : ''}</h2><button className="ghost" onClick={close}>{t.close}</button></div>
      {panel === 'status' && <>
        {usageError && <p className="error-line" role="status"><i className="signal" aria-hidden="true" />{language === 'zh' ? '无法读取同步记录。' : 'Could not read sync records.'}</p>}
        {!syncUsage && !usageError && <p className="muted">{t.loading}</p>}
        {syncUsage?.length === 0 && <p className="muted">{language === 'zh' ? '还没有同步记录。点侧栏的「立即同步」开始第一次同步。' : 'No syncs yet. Use Sync now in the sidebar to run the first one.'}</p>}
        {syncBatches.length > 0 && <><SyncLatest batch={syncBatches[0]!} language={language} onRefresh={() => void loadSyncUsage()} /><SyncHistory batches={syncBatches} language={language} /></>}
      </>}
      {panel === 'settings' && <>
        <section className="settings-row"><div><h3>{isZh ? '课程' : 'Courses'}</h3><p className="muted">{sidebarCourses.length ? (isZh ? `已选 ${sidebarCourses.length} 门：${sidebarCourses.map(course => course.code).join('、')}` : `${sidebarCourses.length} selected: ${sidebarCourses.map(course => course.code).join(', ')}`) : (isZh ? '还没有选课。' : 'No courses selected.')}</p></div>
          <button disabled={courseRun?.running} onClick={() => { close(); setCoursePanelOpen(true); }}>{isZh ? '修改选课' : 'Edit courses'}</button></section>
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
  </div>;
}

/** Product mark: the segmented grade ring that the course page draws, at 18px. */
function Mark() {
  return <svg className="mark" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.5" strokeDasharray="9 1.2" /></svg>;
}

function groupSyncUsage(rows: SyncUsage[]): SyncBatch[] {
  const batches = new Map<string, SyncBatch>();
  const legacy: SyncBatch[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.runId) {
      if (row.type === 'course' && row.course) legacy.push({ id: `legacy-${index}-${row.at}`, at: row.at, durationMs: row.durationMs, ended: true, legacy: true, recovered: false, selected: [{ code: row.course, status: row.status }], courses: [row] });
      continue;
    }
    const batch = batches.get(row.runId) ?? { id: row.runId, at: row.at, durationMs: null, ended: false, legacy: false, recovered: row.recovered, selected: [], courses: [] };
    batch.recovered ||= row.recovered;
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

function batchSummary(batch: SyncBatch) {
  const selected = batch.selected.length ? batch.selected : batch.courses.map(row => ({ code: row.course, status: row.status }));
  const entries = selected.map(course => ({ ...course, row: batch.courses.find(item => item.course === course.code) }));
  const totals = entries.map(entry => usageTokens(entry.row));
  const tokenTotal = totals.length && totals.every(total => total !== null) ? totals.reduce<number>((sum, total) => sum + (total ?? 0), 0) : null;
  return { entries, tokenTotal };
}

/** "2 min 0 s" reads faster than "119.8 s"; recovered runs carry "about". */
function duration(ms: number | null, zh: boolean, approximate = false): string {
  if (ms === null) return '—';
  const total = Math.round(ms / 1000), minutes = Math.floor(total / 60), rest = total % 60;
  const text = minutes ? (zh ? `${minutes} 分 ${rest} 秒` : `${minutes} min ${rest} s`) : (zh ? `${(ms / 1000).toFixed(1)} 秒` : `${(ms / 1000).toFixed(1)} s`);
  return approximate ? (zh ? `约 ${text}` : `~${text}`) : text;
}
const statusNames: Record<string, [string, string]> = { completed: ['完成', 'Completed'], partial: ['部分完成', 'Partial'], failed: ['未完成', 'Failed'], cancelled: ['已中止', 'Stopped'] };
/** One result per run: a single course names its status; several courses count how many finished. */
function batchResult(batch: SyncBatch, zh: boolean): { text: string; problem: boolean } {
  const { entries } = batchSummary(batch);
  if (!batch.ended && !batch.legacy) return { text: zh ? '未结束' : 'Did not finish', problem: true };
  if (entries.length === 1) { const status = entries[0]!.status; return { text: statusNames[status]?.[zh ? 0 : 1] ?? status, problem: status === 'failed' || status === 'cancelled' }; }
  const done = entries.filter(entry => entry.status === 'completed').length, partial = entries.filter(entry => entry.status === 'partial').length;
  const failed = entries.length - done - partial;
  const parts = [zh ? `${done}/${entries.length} 门完成` : `${done} of ${entries.length} completed`];
  if (partial) parts.push(zh ? `${partial} 门部分完成` : `${partial} partial`);
  if (failed) parts.push(zh ? `${failed} 门未完成` : `${failed} failed`);
  return { text: parts.join(' · '), problem: failed > 0 };
}
function batchWhen(batch: SyncBatch, language: Language): string {
  return batch.at && !Number.isNaN(Date.parse(batch.at)) ? new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(batch.at)) : '—';
}
function batchCourses(batch: SyncBatch, zh: boolean): string {
  const { entries } = batchSummary(batch);
  return entries.length === 1 ? entries[0]!.code : entries.length <= 3 ? entries.map(entry => entry.code).join('、') : (zh ? `${entries.length} 门课` : `${entries.length} courses`);
}

/** The latest run as one sentence; every figure comes from the usage log and a missing one shows as a dash. */
function SyncLatest({ batch, language, onRefresh }: { batch: SyncBatch; language: Language; onRefresh: () => void }) {
  const zh = language === 'zh';
  const { tokenTotal } = batchSummary(batch);
  const result = batchResult(batch, zh);
  return <section className="sync-latest" aria-label={zh ? '最近一次同步' : 'Latest sync'}>
    <div className="row-heading"><span className="muted">{zh ? '最近一次同步' : 'Latest sync'}</span><button className="small ghost" onClick={onRefresh}>{zh ? '刷新' : 'Refresh'}</button></div>
    <p className="sync-latest-when">{batchWhen(batch, language)} · {batchCourses(batch, zh)}</p>
    <dl className="sync-latest-facts">
      <div><dt>{zh ? '结果' : 'Result'}</dt><dd>{result.problem && <i className="signal" aria-hidden="true" />}{result.text}</dd></div>
      <div><dt>{zh ? '用时' : 'Time'}</dt><dd>{duration(batch.durationMs, zh, batch.recovered)}</dd></div>
      <div><dt>Token</dt><dd>{tokenTotal?.toLocaleString() ?? '—'}</dd></div>
    </dl>
  </section>;
}

/** Every run as a row; a run with several courses opens to show each course. */
function SyncHistory({ batches, language }: { batches: SyncBatch[]; language: Language }) {
  const zh = language === 'zh';
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string>();
  const shown = all ? batches : batches.slice(0, 8);
  return <section className="sync-history" aria-label={zh ? '同步记录' : 'Sync history'}>
    <h3>{zh ? '同步记录' : 'Sync history'}</h3>
    <div className="sync-table" role="table">
      <div className="sync-tr sync-th" role="row"><span role="columnheader">{zh ? '时间' : 'When'}</span><span role="columnheader">{zh ? '课程' : 'Courses'}</span><span role="columnheader">{zh ? '结果' : 'Result'}</span><span role="columnheader" className="num">{zh ? '用时' : 'Time'}</span><span role="columnheader" className="num">Token</span></div>
      {shown.map(batch => {
        const { entries, tokenTotal } = batchSummary(batch);
        const result = batchResult(batch, zh);
        const many = entries.length > 1, expanded = open === batch.id;
        const cells = <><span>{many && <i className="chevron" aria-hidden="true" />}{batchWhen(batch, language)}</span><span>{batchCourses(batch, zh)}</span>
          <span>{result.problem && <i className="signal" aria-hidden="true" />}{result.text}</span><span className="num">{duration(batch.durationMs, zh, batch.recovered)}</span><span className="num">{tokenTotal?.toLocaleString() ?? '—'}</span></>;
        return <div key={batch.id} className={`sync-run${expanded ? ' open' : ''}`} role="rowgroup">
          {many ? <button className="sync-tr" role="row" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : batch.id)}>{cells}</button> : <div className="sync-tr" role="row">{cells}</div>}
          {many && expanded && entries.map(({ code, status, row }, index) => <div className="sync-tr sync-sub" role="row" key={`${code}-${index}`}>
            <span /><span>{code}</span><span>{(status === 'failed' || status === 'cancelled') && <i className="signal" aria-hidden="true" />}{statusNames[status]?.[zh ? 0 : 1] ?? status}</span>
            <span className="num">{duration(row?.durationMs ?? null, zh)}</span><span className="num">{usageTokens(row)?.toLocaleString() ?? '—'}</span></div>)}
        </div>;
      })}
    </div>
    {batches.length > 8 && <button className="small ghost sync-more" onClick={() => setAll(!all)}>{all ? (zh ? '收起' : 'Show fewer') : (zh ? `显示全部 ${batches.length} 条` : `Show all ${batches.length}`)}</button>}
    <p className="sync-note">{zh ? '用时从保存选课后开始算；带「约」的是从本机采集目录还原的记录。' : 'Time starts after courses are saved; "~" marks runs recovered from local folders.'}</p>
  </section>;
}
