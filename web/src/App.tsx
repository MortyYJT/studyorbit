import { useEffect, useRef, useState } from 'react';
import { applyBackground, Backdrop, BackgroundSettingsSection, useBackgroundImage } from './BackgroundLayer.js';
import { backgroundStorageKey, parseBackground, type BackgroundMode, type BackgroundSettings } from './background.js';
import { en, zh, type Language, type Theme } from './i18n.js';
import { AgentChat, type AgentRequest } from './Agent.js';
import { createAgentRequest } from './agent-request.js';
import { LocalCourseSelect } from './LocalCourseSelect.js';
import { LocalPlanning, type SidebarCourse } from './LocalPlanning.js';
import { closeDialog, durations, easeOut, openDialog, reducedMotion, useSlidingIndicator, viewTransition } from './motion.js';
import { palettes, parsePalette, type Palette } from './palette.js';
import { fetchSourceSettings, SourceSettingsSection, type SourceSettingsReply } from './SourceSettings.js';
import type { LlmProvider, PublicLlmConfig } from '../../scripts/lib/llm-config.mjs';
import { translateReason } from '../../shared/sync-reasons.js';

type Panel = 'status' | 'settings';
type CourseRun = { running: boolean; courses: { id: string; code: string; status: string; reason: string; phase?: string; file?: string; stage?: string | null; reused?: boolean }[]; error: string | null; warnings?: string[]; jobId?: string | null; resumedFrom?: string | null; resumable?: boolean };
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
  const [palette, setPalette] = useState<Palette>(() => parsePalette(preference('coursework.palette')));
  const [background, setBackground] = useState<BackgroundSettings>(() => parseBackground(preference(backgroundStorageKey)));
  const { url: backgroundImage, setUrl: setBackgroundImage, loadFailed: backgroundLoadFailed, dismissLoadFailure } = useBackgroundImage();
  const [avatarImage, setAvatarImage] = useState(() => preference('coursework.avatar') ?? '');
  const [avatarError, setAvatarError] = useState('');
  const [syncUsage, setSyncUsage] = useState<SyncUsage[]>();
  const [usageError, setUsageError] = useState(false);
  const [view, setView] = useState<View>({ page: 'week' });
  const [agentRequest, setAgentRequest] = useState<AgentRequest>();
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
  // The institution's time zone from the source settings decides "today" and due days; the browser's until it loads.
  const [timeZone, setTimeZone] = useState(() => new Intl.DateTimeFormat().resolvedOptions().timeZone);
  // The name of the institution's framework source (the contract's `handbook` platform), or null without one.
  const [frameworkLabel, setFrameworkLabel] = useState<string | null>(null);
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
  useEffect(() => { document.documentElement.dataset.palette = palette; remember('coursework.palette', palette); }, [palette]);
  useEffect(() => { applyBackground(background); remember(backgroundStorageKey, JSON.stringify(background)); }, [background]);
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; remember('coursework.language', language); }, [language]);
  useEffect(() => { if (panel) openDialog(dialog.current); }, [panel]);
  function applySourceSettings(reply: SourceSettingsReply) {
    setTimeZone(reply.settings.timeZone);
    setFrameworkLabel(reply.available.institutions.find(item => item.id === reply.settings.institution)?.frameworkLabel ?? null);
  }
  // Read again whenever the course data reloads (after a sync, a course fetch or a settings save), so a failed read
  // does not keep the browser's zone for the whole session.
  useEffect(() => { let live = true; void fetchSourceSettings().then(reply => { if (live && reply) applySourceSettings(reply); }); return () => { live = false; }; }, [courseRefresh]);
  /** Saved source settings: a new time zone or institution changes the course pages, so they reload. */
  function sourceSettingsSaved(reply: SourceSettingsReply) { applySourceSettings(reply); setCourseRefresh(value => value + 1); }
  // Page changes run as a View Transition (see go); other view changes, or browsers without it, fade the canvas in.
  const mainRef = useRef<HTMLElement>(null);
  const viaTransition = useRef(false);
  const pageKey = view.page === 'course' ? `course:${view.courseId}` : view.page;
  useEffect(() => {
    if (viaTransition.current) { viaTransition.current = false; return; }
    if (reducedMotion()) return;
    mainRef.current?.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: durations.medium, easing: easeOut });
  }, [pageKey]);
  // One indicator slides between the current nav and course items instead of each item painting its own fill.
  const sidebarBody = useRef<HTMLDivElement>(null);
  const navIndicator = useRef<HTMLSpanElement>(null);
  useSlidingIndicator(sidebarBody, navIndicator, '.nav-item[aria-current="page"]', 'both', [pageKey, sidebarCourses, navOpen]);
  // Dialog content stays as it was while the dialog animates out.
  const [selectContent, setSelectContent] = useState(coursePanelOpen);
  const shownSyncModal = useRef<SyncModal>(syncModal);
  if (syncModal) shownSyncModal.current = syncModal;
  const modal = syncModal ?? shownSyncModal.current;
  useEffect(() => { const element = selectDialog.current; if (!element) return; if (coursePanelOpen) { setSelectContent(true); openDialog(element); } else closeDialog(element); }, [coursePanelOpen]);
  useEffect(() => { const element = syncDialog.current; if (!element) return; if (syncModal) openDialog(element); else closeDialog(element); }, [syncModal]);
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
  // The dialog's close event clears the panel, so its content stays while it animates out.
  function close() { closeDialog(dialog.current); }
  const changeTheme = (next: Theme) => viewTransition('theme', () => { document.documentElement.dataset.theme = next; setTheme(next); });
  const changePalette = (next: Palette) => viewTransition('theme', () => { document.documentElement.dataset.palette = next; setPalette(next); });
  const changeBackgroundMode = (mode: BackgroundMode) => viewTransition('theme', () => { const next = { ...background, mode }; applyBackground(next); setBackground(next); });
  async function syncCourses() {
    if (running) return;
    cancelledDiscovery.current = false; setSyncModal('discovery'); setCourseRun(undefined); setLocalSyncing(true); setLocalSyncError(''); setLocalSyncWarning('');
    try {
      const response = await fetch('/api/local/sync-courses', { method: 'POST' });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => undefined);
        const raw = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '';
        const detail = raw === 'SOURCE_SETTINGS_UNREADABLE' ? (language === 'zh' ? '无法读取「设置 → 数据来源」，请在设置里重新保存。' : 'Could not read Settings → Data sources. Save them again in Settings.') : raw;
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
      if (!response.ok) {
        const failure: unknown = await response.json().catch(() => undefined);
        const code = failure && typeof failure === 'object' && 'error' in failure && typeof failure.error === 'string' ? failure.error : '';
        throw new Error(code === 'COURSE_LIST_STALE' ? (language === 'zh' ? 'Canvas 地址已更改，请重新获取课程。选择已保存，同步没有启动。' : 'The Canvas address changed; fetch the courses again. Selection saved; the sync did not start.')
          : code === 'SOURCE_SETTINGS_UNREADABLE' ? (language === 'zh' ? '无法读取「设置 → 数据来源」，同步没有启动。请在设置里重新保存。' : 'Could not read Settings → Data sources; the sync did not start. Save them again in Settings.')
          : response.status === 409
          ? (language === 'zh' ? '已有课程同步正在进行，选择已保存，但新同步尚未启动。' : 'A course sync is running. Selection saved, but a new sync was not started.')
          : code === 'ANALYSIS_PROVIDER_INVALID' ? (language === 'zh' ? '环境变量 COURSE_ANALYSIS_PROVIDER 不是可识别的提供方，同步未启动。请在「设置 → 分析模型」里选择提供方并保存。选择已保存。' : 'COURSE_ANALYSIS_PROVIDER is not a known provider, so the sync did not start. Pick a provider in Settings → Analysis model. Your selection was saved.')
          : code.startsWith('ANALYSIS_') ? (language === 'zh' ? '分析模型还没配置好（缺少密钥或接口地址），请在「设置 → 分析模型」里检查。选择已保存。' : 'The analysis model is not configured (missing key or endpoint). Check Settings → Analysis model. Your selection was saved.')
          : (language === 'zh' ? '无法启动课程同步，选择已保存。' : 'Could not start course sync. Your selection was saved.'));
      }
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
  /** Continues the newest stopped sync from its checkpoints (POST /api/local/sync-jobs/<jobId>/resume). */
  async function resumeSync() {
    const jobId = courseRun?.jobId;
    if (running || !jobId) return;
    cancelDuringStart.current = false; setCourseRunError(''); setLocalSyncError(''); setSyncModal('starting');
    try {
      const response = await fetch(`/api/local/sync-jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) {
        const failure: unknown = await response.json().catch(() => undefined);
        const code = failure && typeof failure === 'object' && 'error' in failure && typeof failure.error === 'string' ? failure.error : '';
        throw new Error(code === 'RESUME_EXPIRED' ? (language === 'zh' ? '上次同步已超过 24 小时，采集的数据可能已过时，请重新同步。' : 'The last sync is more than 24 hours old; its collected data may be stale. Please sync again.')
          : code === 'SYNC_RUNNING' ? (language === 'zh' ? '已有课程同步正在进行。' : 'A course sync is already running.')
          : code === 'COURSE_LIST_STALE' ? (language === 'zh' ? 'Canvas 地址已更改，请重新获取课程后再同步。' : 'The Canvas address changed; fetch the courses again and sync.')
          : code === 'SOURCES_CHANGED' ? (language === 'zh' ? '数据来源设置已更改，无法继续上次同步，请重新同步。' : 'The data-source settings changed, so the last sync cannot be resumed. Please sync again.')
          : code === 'ALREADY_RESUMED' || code === 'NOT_RESUMABLE' ? (language === 'zh' ? '上次同步已经继续过或无需继续。' : 'The last sync was already resumed or has nothing left to do.')
          : code.startsWith('ANALYSIS_') ? (language === 'zh' ? '分析模型还没配置好，请在「设置 → 分析模型」里检查。' : 'The analysis model is not configured. Check Settings → Analysis model.')
          : (language === 'zh' ? '无法继续上次同步。' : 'Could not resume the last sync.'));
      }
      setCourseRun(await response.json() as CourseRun);
      // Stop pressed while the resume was starting: cancel the job it created, as for a new sync.
      if (cancelDuringStart.current) { const stopped = await fetch('/api/local/course-sync', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }); if (!stopped.ok) throw new Error(language === 'zh' ? '无法中止同步，请重试。' : 'Could not stop sync.'); setCourseRun(await stopped.json() as CourseRun); setSyncModal('stopping'); }
      else setSyncModal('syncing');
    } catch (error) { setCourseRunError(error instanceof Error ? error.message : t.error); setSyncModal('finished'); }
  }
  const go = (next: View) => {
    const key = next.page === 'course' ? `course:${next.courseId}` : next.page;
    if (key === pageKey) { setView(next); setNavOpen(false); return; }
    viaTransition.current = viewTransition('page', () => { setView(next); setNavOpen(false); });
  };
  const isZh = language === 'zh';
  const title = view.page === 'agent' ? t.agent : (isZh ? '本周' : 'This week');
  const syncButton = <button disabled={!!running} onClick={() => void syncCourses()} aria-busy={!!running}>{running ? t.syncing : t.sync}</button>;
  const resumeLabel = language === 'zh' ? '继续上次同步' : 'Resume last sync';
  const canResume = !running && !syncModal && courseRun?.resumable === true && !!courseRun.jobId;
  const syncBatches = groupSyncUsage(syncUsage ?? []);
  return <div className="shell">
    <Backdrop settings={background} image={backgroundImage} />
    <aside className={`sidebar${navOpen ? ' open' : ''}`}>
      <div className="sidebar-top">
        <span className="brand"><Mark />StudyOrbit</span>
        <span className="sidebar-page">{view.page === 'course' ? sidebarCourses.find(course => course.id === view.courseId)?.code ?? '' : title}</span>
        <button className="nav-toggle ghost" aria-expanded={navOpen} aria-controls="sidebar-body" onClick={() => setNavOpen(!navOpen)}>{navOpen ? t.close : (isZh ? '菜单' : 'Menu')}</button>
      </div>
      <div className="sidebar-body" id="sidebar-body" ref={sidebarBody}>
        <span className="nav-indicator" ref={navIndicator} aria-hidden="true" />
        <nav className="nav" aria-label="StudyOrbit">
          <button className="nav-item" aria-current={view.page === 'week' ? 'page' : undefined} onClick={() => go({ page: 'week' })}>{isZh ? '本周' : 'This week'}</button>
          <button className="nav-item" aria-current={view.page === 'agent' ? 'page' : undefined} onClick={() => { setAgentRequest(undefined); go({ page: 'agent' }); }}>{t.agent}</button>
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
          {canResume && <button className="ghost" onClick={() => void resumeSync()}>{resumeLabel}</button>}
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
      {backgroundLoadFailed && background.mode === 'image' && <p className="error-line" role="status"><i className="signal" aria-hidden="true" />{isZh ? '无法从浏览器存储读取背景图片，暂时显示渐变背景。可以在「设置 → 背景」重新选择图片。' : 'Could not read the background image from browser storage; showing the gradient for now. You can choose the image again in Settings → Background.'}<button className="small ghost" onClick={dismissLoadFailure}>{t.close}</button></p>}
      {courseRunError && <p className="error-line" role="status"><i className="signal" aria-hidden="true" />{courseRunError}</p>}
      {view.page !== 'course' && <div className="page-heading"><h1>{title}</h1>{view.page !== 'agent' && <button className="ghost" onClick={() => setCourseRefresh(value => value + 1)}>{t.refresh}</button>}</div>}
      {savedNotice > 0 && <div className="save-toast" role="status">{isZh ? '课程已经保存' : 'Courses saved'}</div>}
      {view.page === 'agent' ? <AgentChat language={language} courses={sidebarCourses} request={agentRequest} onOpenSettings={() => open('settings')} />
        : <LocalPlanning key={timeZone} language={language} timeZone={timeZone} frameworkLabel={frameworkLabel} refreshVersion={courseRefresh} courseId={view.page === 'course' ? view.courseId : undefined} onCourses={setSidebarCourses}
          syncIssues={courseRun?.courses ?? []} onCourse={courseId => go({ page: 'course', courseId })} onBack={() => go({ page: 'week' })}
          onAsk={(courseId, prompt) => { setAgentRequest(createAgentRequest(courseId, prompt)); go({ page: 'agent' }); }} />}
    </main>
    <dialog ref={selectDialog} className="select-dialog" aria-labelledby="select-title" onCancel={event => { event.preventDefault(); setCoursePanelOpen(false); }} onClose={() => setSelectContent(false)}>
      <div className="dialog-heading"><h2 id="select-title" tabIndex={-1} autoFocus>{isZh ? '修改选课' : 'Edit courses'}</h2><button className="ghost" onClick={() => setCoursePanelOpen(false)}>{t.close}</button></div>
      <p className="select-note"><i className="signal" aria-hidden="true" />{isZh ? '保存后会立即开始同步所选课程（会使用浏览器（Edge 或 Chrome）、Ed 和模型额度）。' : 'Saving starts a sync of the selected courses right away (uses the browser (Edge or Chrome), Ed and model quota).'}</p>
      {(coursePanelOpen || selectContent) && <LocalCourseSelect language={language} refreshVersion={courseRefresh} onSaved={ids => { setCoursePanelOpen(false); setSavedNotice(Date.now()); setCourseRefresh(value => value + 1); void startSelectedCourses(ids); }} />}
    </dialog>
    <dialog ref={syncDialog} className="sync-dialog" aria-labelledby="sync-title" onCancel={event => event.preventDefault()}>
      <h2 id="sync-title">{language === 'zh' ? (modal === 'finished' ? '同步结果' : '正在同步课程') : (modal === 'finished' ? 'Sync results' : 'Syncing courses')}</h2>
      {modal === 'select' ? <LocalCourseSelect language={language} refreshVersion={courseRefresh} onSaved={ids => { setSavedNotice(Date.now()); setCourseRefresh(value => value + 1); if (ids.length) void startSelectedCourses(ids); else setSyncModal('finished'); }} /> : <>
        {modal !== 'finished' && <><p>{language === 'zh' ? '同步中，请保持浏览器（Edge 或 Chrome）和 coursework 页面打开。' : 'Syncing. Please keep the browser (Edge or Chrome) and the coursework page open.'}</p><div className="sync-indeterminate" role="progressbar" aria-label={language === 'zh' ? '同步进行中' : 'Sync in progress'}><span /></div></>}
        {modal === 'discovery' && <p>{language === 'zh' ? '正在获取课程列表…' : 'Fetching course list…'}</p>}
        {modal === 'starting' && <p>{language === 'zh' ? '正在启动课程同步…' : 'Starting course sync…'}</p>}
        {modal === 'stopping' && <p>{language === 'zh' ? '正在中止，请稍候…' : 'Stopping…'}</p>}
        {courseRun && courseRun.courses.length > 0 && <><p>{language === 'zh' ? '已处理' : 'Processed'} {courseRun.courses.filter(course => ['completed', 'partial', 'incomplete', 'failed'].includes(course.status)).length} / {courseRun.courses.length}</p>{courseRun.courses.map(course => <div className="sync-course" key={course.id}><b>{course.code}</b><span>{['failed', 'incomplete', 'cancelled', 'interrupted'].includes(course.status) && <i className="signal" aria-hidden="true" />}{({ pending: language === 'zh' ? '等待' : 'Waiting', running: course.phase === 'canvas' ? (language === 'zh' ? '获取 LMS 信息中' : 'Fetching LMS data') : course.phase === 'ed' ? (language === 'zh' ? '获取 Ed 信息中' : 'Fetching Ed data') : course.phase === 'waiting_analysis' ? (language === 'zh' ? '等待 Agent 分析' : 'Waiting for agent') : course.phase === 'handbook' ? (language === 'zh' ? `获取 ${frameworkLabel ?? '考核框架'} 信息中` : `Fetching ${frameworkLabel ?? 'framework'} data`) : course.phase === 'analysis' ? (language === 'zh' ? 'Agent 分析中' : 'Agent analysing') : course.phase === 'saving' ? (language === 'zh' ? '校验与保存中' : 'Validating and saving') : (language === 'zh' ? '准备中' : 'Starting'), completed: language === 'zh' ? '已完成' : 'Completed', partial: language === 'zh' ? '部分完成' : 'Partial', incomplete: language === 'zh' ? '不完整' : 'Incomplete', failed: language === 'zh' ? '未完成' : 'Failed', cancelled: language === 'zh' ? '已中止' : 'Stopped', interrupted: language === 'zh' ? '已中断' : 'Interrupted' } as Record<string,string>)[course.status] ?? course.status}</span>{course.reused && <small className="muted">{language === 'zh' ? '沿用上次结果' : 'Reused from the last sync'}</small>}{['failed', 'incomplete', 'partial'].includes(course.status) && course.reason && <small>{course.status === 'incomplete' ? (language === 'zh' ? `本次同步不完整，仍显示上次的结果：${course.reason}` : `Incomplete; the previous result is still shown: ${translateReason(course.reason, 'en')}`) : translateReason(course.reason, language)}</small>}</div>)}</>}
        {(localSyncError || courseRunError || courseRun?.error) && <p role="alert">{localSyncError || courseRunError || translateReason(courseRun?.error ?? '', language)}</p>}
        {courseRun?.warnings?.map(warning => <p className="muted" role="status" key={warning}>{translateReason(warning, language)}</p>)}
      </>}
      {modal === 'finished' ? <div className="sync-actions">{courseRun?.resumable && courseRun.jobId && <button onClick={() => void resumeSync()}>{resumeLabel}</button>}<button className={courseRun?.resumable ? 'ghost' : undefined} onClick={() => setSyncModal(undefined)}>{language === 'zh' ? '关闭' : 'Close'}</button></div> : <button disabled={modal === 'stopping'} onClick={() => void stopSync()}>{language === 'zh' ? '中止同步' : 'Stop sync'}</button>}
    </dialog>
    <dialog ref={dialog} onCancel={event => { event.preventDefault(); close(); }} onClose={() => { setPanel(undefined); avatar.current?.focus(); }} aria-labelledby="panel-title">
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
        <AnalysisModelSettings language={language} />
        <SourceSettingsSection language={language} onSaved={sourceSettingsSaved} />
        <div className="avatar-settings"><span className="avatar-preview">{avatarImage ? <img src={avatarImage} alt="" /> : 'Y'}</span><div><label className="avatar-upload">{language === 'zh' ? '上传头像' : 'Upload photo'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return;
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setAvatarError(language === 'zh' ? '请选择不超过 2 MB 的 JPG、PNG 或 WebP 图片。' : 'Choose a JPG, PNG or WebP image up to 2 MB.'); return; }
          const reader = new FileReader(); reader.onerror = () => setAvatarError(language === 'zh' ? '图片读取失败。' : 'Could not read the image.');
          reader.onload = () => { if (typeof reader.result !== 'string') return; try { localStorage.setItem('coursework.avatar', reader.result); setAvatarImage(reader.result); setAvatarError(''); } catch { setAvatarError(language === 'zh' ? '头像保存失败，请检查浏览器存储。' : 'Could not save the photo in this browser.'); } };
          reader.readAsDataURL(file);
        }} /></label>{avatarImage && <button onClick={() => { try { localStorage.removeItem('coursework.avatar'); setAvatarImage(''); setAvatarError(''); } catch { setAvatarError(language === 'zh' ? '头像移除失败。' : 'Could not remove the photo.'); } }}>{language === 'zh' ? '移除' : 'Remove'}</button>}</div></div>
        {avatarError && <p role="alert">{avatarError}</p>}
        <div className="preferences"><label>{t.theme}<select value={theme} onChange={event => changeTheme(event.target.value as Theme)}>{(['system', 'light', 'dark'] as const).map(value => <option key={value} value={value}>{t[value]}</option>)}</select></label>
          <label>{t.language}<select value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="en">English</option><option value="zh">中文</option></select></label></div>
        <fieldset className="palette-picker"><legend>{t.palette}</legend><div className="palette-options">
          {palettes.map(value => <button key={value} type="button" className="palette-swatch" data-palette={value} aria-pressed={palette === value} onClick={() => changePalette(value)}>
            <span className="palette-chip" aria-hidden="true"><i /><i /><i /></span>{t.palettes[value]}</button>)}
        </div></fieldset>
        <BackgroundSettingsSection zh={isZh} settings={background} image={backgroundImage} onChange={setBackground} onMode={changeBackgroundMode} onImage={setBackgroundImage} />
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
const statusNames: Record<string, [string, string]> = { completed: ['完成', 'Completed'], partial: ['部分完成', 'Partial'], incomplete: ['不完整', 'Incomplete'], failed: ['未完成', 'Failed'], cancelled: ['已中止', 'Stopped'], interrupted: ['已中断', 'Interrupted'] };
const problemStatus = (status: string) => status === 'failed' || status === 'incomplete' || status === 'cancelled' || status === 'interrupted';
/** One result per run: a single course names its status; several courses count how many finished. */
function batchResult(batch: SyncBatch, zh: boolean): { text: string; problem: boolean } {
  const { entries } = batchSummary(batch);
  if (!batch.ended && !batch.legacy) return { text: zh ? '未结束' : 'Did not finish', problem: true };
  if (entries.length === 1) { const status = entries[0]!.status; return { text: statusNames[status]?.[zh ? 0 : 1] ?? status, problem: problemStatus(status) }; }
  const done = entries.filter(entry => entry.status === 'completed').length, partial = entries.filter(entry => entry.status === 'partial').length;
  const incomplete = entries.filter(entry => entry.status === 'incomplete').length;
  const failed = entries.length - done - partial - incomplete;
  const parts = [zh ? `${done}/${entries.length} 门完成` : `${done} of ${entries.length} completed`];
  if (partial) parts.push(zh ? `${partial} 门部分完成` : `${partial} partial`);
  if (incomplete) parts.push(zh ? `${incomplete} 门不完整` : `${incomplete} incomplete`);
  if (failed) parts.push(zh ? `${failed} 门未完成` : `${failed} failed`);
  return { text: parts.join(' · '), problem: failed > 0 || incomplete > 0 };
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
  const models = [...new Set(batch.courses.map(row => row.model).filter(Boolean))];
  return <section className="sync-latest" aria-label={zh ? '最近一次同步' : 'Latest sync'}>
    <div className="row-heading"><span className="muted">{zh ? '最近一次同步' : 'Latest sync'}</span><button className="small ghost" onClick={onRefresh}>{zh ? '刷新' : 'Refresh'}</button></div>
    <p className="sync-latest-when">{batchWhen(batch, language)} · {batchCourses(batch, zh)}{models.length > 0 && ` · ${models.join('、')}`}</p>
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
            <span /><span>{code}</span><span>{problemStatus(status) && <i className="signal" aria-hidden="true" />}{statusNames[status]?.[zh ? 0 : 1] ?? status}</span>
            <span className="num">{duration(row?.durationMs ?? null, zh)}</span><span className="num">{usageTokens(row)?.toLocaleString() ?? '—'}</span></div>)}
        </div>;
      })}
    </div>
    {batches.length > 8 && <button className="small ghost sync-more" onClick={() => setAll(!all)}>{all ? (zh ? '收起' : 'Show fewer') : (zh ? `显示全部 ${batches.length} 条` : `Show all ${batches.length}`)}</button>}
    <p className="sync-note">{zh ? '用时从保存选课后开始算；带「约」的是从本机采集目录还原的记录。' : 'Time starts after courses are saved; "~" marks runs recovered from local folders.'}</p>
  </section>;
}

const providerNames: Record<LlmProvider, [string, string]> = {
  deepseek: ['DeepSeek', 'DeepSeek'], 'openai-compatible': ['OpenAI 兼容接口', 'OpenAI-compatible API'],
  anthropic: ['Anthropic Claude', 'Anthropic Claude'], codex: ['Codex CLI', 'Codex CLI'],
};
const fieldErrorText: Record<string, [string, string]> = {
  required: ['必填。', 'Required.'], invalid_url: ['地址无效。', 'Not a valid URL.'],
  insecure_url: ['只能使用 HTTPS 或本机（localhost / 127.0.0.1）地址。', 'Use HTTPS or a localhost / 127.0.0.1 address.'],
  too_long: ['太长了。', 'Too long.'], whitespace: ['不能包含空格。', 'Must not contain spaces.'],
  invalid_provider: ['未知的提供方。', 'Unknown provider.'], unknown_field: ['请求包含未知字段。', 'Unknown field in request.'], invalid_json: ['请求格式错误。', 'Malformed request.'],
};
type ModelForm = { provider: LlmProvider; model: string; baseUrl: string; apiKey: string; clearKey: boolean };
function formFrom(config: PublicLlmConfig): ModelForm { return { provider: config.provider, model: config.model, baseUrl: config.baseUrl, apiKey: '', clearKey: false }; }

/** Analysis model settings (decision #229): one form, one Save. The key is write-only and never read back. */
function AnalysisModelSettings({ language }: { language: Language }) {
  const zh = language === 'zh';
  const pick = (pair: [string, string]) => pair[zh ? 0 : 1];
  const [config, setConfig] = useState<PublicLlmConfig>();
  const [form, setForm] = useState<ModelForm>();
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test'>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ problem: boolean; text: string }>();
  useEffect(() => {
    let live = true;
    fetch('/api/local/llm-config').then(async response => { if (!response.ok) throw new Error(); return await response.json() as PublicLlmConfig; })
      .then(data => { if (live) { setConfig(data); setForm(formFrom(data)); } }).catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, []);
  if (loadError) return <section className="settings-row model-settings"><div><h3>{zh ? '分析模型' : 'Analysis model'}</h3><p className="muted">{zh ? '无法读取模型设置（仅在本地开发服务器中可用）。' : 'Could not read model settings (local dev server only).'}</p></div></section>;
  if (!config || !form) return <section className="settings-row model-settings"><div><h3>{zh ? '分析模型' : 'Analysis model'}</h3><p className="muted">{zh ? '加载中…' : 'Loading…'}</p></div></section>;
  const sameProvider = form.provider === config.provider;
  const dirty = Boolean(config.providerInvalid) || !sameProvider || form.model !== config.model || form.baseUrl !== config.baseUrl || form.apiKey !== '' || form.clearKey;
  const placeholder = (sameProvider && !config.model ? config.effectiveModel : config.defaultModels[form.provider]) ?? (zh ? '必填，例如 gpt-5.5' : 'Required, e.g. gpt-5.5');
  const update = (patch: Partial<ModelForm>) => { setForm({ ...form, ...patch }); setStatus(undefined); setFieldErrors({}); };
  const changeProvider = (provider: LlmProvider) => update(provider === config.provider ? { ...formFrom(config), apiKey: form.apiKey } : { provider, model: '', baseUrl: '', clearKey: false });
  const errorFor = (field: string) => fieldErrors[field] && <small className="model-error" role="alert">{pick(fieldErrorText[fieldErrors[field]!] ?? [fieldErrors[field]!, fieldErrors[field]!])}</small>;
  async function save() {
    if (!form) return;
    setBusy('save'); setStatus(undefined); setFieldErrors({});
    try {
      const response = await fetch('/api/local/llm-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: form.provider, model: form.model, ...(form.provider === 'openai-compatible' ? { baseUrl: form.baseUrl } : {}), ...(form.apiKey ? { apiKey: form.apiKey } : {}), ...(form.clearKey ? { clearKey: true } : {}) }) });
      const data: unknown = await response.json().catch(() => undefined);
      if (response.status === 400 && data && typeof data === 'object' && 'fieldErrors' in data) { setFieldErrors(data.fieldErrors as Record<string, string>); setStatus({ problem: true, text: zh ? '没有保存：请修正标出的字段。' : 'Not saved: fix the marked fields.' }); return; }
      if (!response.ok) throw new Error();
      const next = data as PublicLlmConfig;
      setConfig(next); setForm(formFrom(next));
      setStatus({ problem: next.keyRequired && !next.hasKey, text: next.keyRequired && !next.hasKey ? (zh ? '已保存，但还没有 API 密钥，同步会失败。' : 'Saved, but there is no API key yet; syncs will fail.') : (zh ? '已保存。下次同步开始时生效。' : 'Saved. Applies from the next sync.') });
    } catch { setStatus({ problem: true, text: zh ? '保存失败，请重试。' : 'Could not save. Please retry.' }); }
    finally { setBusy(undefined); }
  }
  async function test() {
    setBusy('test'); setStatus(undefined);
    try {
      const response = await fetch('/api/local/llm-config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error(response.status === 409 ? (zh ? '已有一个测试在进行。' : 'A test is already running.') : '');
      const data = await response.json() as { ok: boolean; latencyMs: number; model: string | null; error?: string };
      const where = `${data.model ?? '—'} · ${data.latencyMs.toLocaleString()} ms`;
      setStatus(data.ok ? { problem: false, text: `${zh ? '连接成功' : 'Connected'} · ${where}` } : { problem: true, text: `${zh ? '连接失败' : 'Connection failed'} · ${where}${data.error ? ` · ${data.error}` : ''}` });
    } catch (error) { setStatus({ problem: true, text: error instanceof Error && error.message ? error.message : (zh ? '无法测试连接。' : 'Could not test the connection.') }); }
    finally { setBusy(undefined); }
  }
  const keyNote = sameProvider && config.hasKey && !form.clearKey
    ? (config.keySource === 'settings' ? (zh ? '已保存（来自设置）' : 'Saved (from settings)') : (zh ? '已保存（来自环境变量）' : 'Saved (from environment)'))
    : form.clearKey ? (zh ? '保存后清除' : 'Cleared on save') : '';
  return <section className="model-settings" aria-labelledby="model-settings-title">
    <h3 id="model-settings-title">{zh ? '分析模型' : 'Analysis model'}</h3>
    {config.providerInvalid && <p className="error-line" role="status"><i className="signal" aria-hidden="true" />{zh ? '环境变量 COURSE_ANALYSIS_PROVIDER 不可识别，同步不会启动。请在下面选择提供方并保存。' : 'COURSE_ANALYSIS_PROVIDER is not recognised; syncs will not start. Choose a provider below and save.'}</p>}
    <p className="muted model-note">{zh ? '同步时用来整理课程数据的模型。课程和成绩会发送给所选服务，可能产生费用。' : 'The model that organises course data during a sync. Course data and grades are sent to the chosen service and may cost money.'}</p>
    <label className="model-row"><span className="k">{zh ? '提供方' : 'Provider'}</span>
      <select value={form.provider} onChange={event => changeProvider(event.target.value as LlmProvider)}>{(Object.keys(providerNames) as LlmProvider[]).map(value => <option key={value} value={value}>{pick(providerNames[value])}</option>)}</select>{errorFor('provider')}</label>
    <label className="model-row"><span className="k">{zh ? '模型' : 'Model'}</span>
      <input value={form.model} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={event => update({ model: event.target.value })} />{errorFor('model')}</label>
    {form.provider === 'openai-compatible' && <label className="model-row"><span className="k">{zh ? '接口地址' : 'Endpoint'}</span>
      <input value={form.baseUrl} placeholder="https://…/v1/chat/completions" spellCheck={false} autoComplete="off" inputMode="url" onChange={event => update({ baseUrl: event.target.value })} />{errorFor('baseUrl')}</label>}
    {form.provider !== 'codex' ? <div className="model-row"><label className="k" htmlFor="model-key">API key</label>
      <div className="model-key"><input id="model-key" type="password" value={form.apiKey} autoComplete="new-password" spellCheck={false} placeholder={keyNote || (zh ? '粘贴密钥（只写入，不会显示）' : 'Paste key (write-only, never shown)')} onChange={event => update({ apiKey: event.target.value, clearKey: false })} />
        {sameProvider && config.keySource === 'settings' && !form.apiKey && <button type="button" className="small ghost" onClick={() => update({ clearKey: !form.clearKey })}>{form.clearKey ? (zh ? '撤销' : 'Undo') : (zh ? '清除' : 'Clear')}</button>}</div>
      {errorFor('apiKey')}
      {!sameProvider && config.keySource === 'settings' && <small className="muted">{zh ? '换了提供方，已保存的密钥不会沿用。' : 'The saved key is not carried over to another provider.'}</small>}</div>
      : <p className="muted model-note">{zh ? 'Codex CLI 用本机已登录的 Codex，不需要密钥。' : 'Codex CLI uses your signed-in local Codex; no key needed.'}</p>}
    <div className="model-actions">
      <button className="primary small" disabled={!dirty || busy !== undefined} onClick={() => void save()}>{busy === 'save' ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}</button>
      <button className="small" disabled={dirty || busy !== undefined} title={dirty ? (zh ? '先保存再测试' : 'Save before testing') : undefined} onClick={() => void test()}>{busy === 'test' ? (zh ? '测试中…' : 'Testing…') : (zh ? '测试连接' : 'Test connection')}</button>
      {status ? <span className={`model-status${status.problem ? ' problem' : ''}`} role="status">{status.problem && <i className="signal" aria-hidden="true" />}{status.text}</span>
        : dirty ? <span className="model-status muted">{zh ? '有未保存的更改。' : 'Unsaved changes.'}</span>
        : <span className="model-status muted">{zh ? `当前：${pick(providerNames[config.provider])} · ${config.effectiveModel ?? '—'}${config.source === 'env' ? '（来自环境变量）' : config.source === 'default' ? '（默认）' : ''}` : `Current: ${pick(providerNames[config.provider])} · ${config.effectiveModel ?? '—'}${config.source === 'env' ? ' (from environment)' : config.source === 'default' ? ' (default)' : ''}`}</span>}
    </div>
  </section>;
}
