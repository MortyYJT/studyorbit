import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ShellStore, attention, emptyStore, settingsFromForm, type Settings } from './shell.js';
import { en, zh, type Copy, type Language, type Theme } from './i18n.js';
import { WeekStore } from './weekStore.js';
import { needsYou, weekModel } from './week.js';
import { NeedsYou, WeekView } from './WeekView.js';

type Panel = 'status' | 'audit' | 'settings' | 'metrics';
export type View = { page: 'week' } | { page: 'agent' } | { page: 'course'; courseId: string };
function preference(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function remember(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Preferences remain usable in memory. */ } }
function errorText(code: string, t: Copy): string {
  return code === 'OWNER_SESSION_EXPIRED' ? t.session : code === 'AUTH_EXPIRED' ? t.auth : `${t.error} (${code})`;
}
export function App({ store }: { store: ShellStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [language, setLanguage] = useState<Language>(() => preference('coursework.language') === 'zh' ? 'zh' : 'en');
  const [theme, setTheme] = useState<Theme>(() => { const value = preference('coursework.theme'); return value === 'light' || value === 'dark' ? value : 'system'; });
  const [view, setView] = useState<View>({ page: 'week' });
  const [week] = useState(() => new WeekStore(store.client));
  const weekState = useSyncExternalStore(week.subscribe, week.getSnapshot);
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<Panel>();
  const dialog = useRef<HTMLDialogElement>(null);
  const avatar = useRef<HTMLButtonElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const t = language === 'zh' ? zh : en;
  const rows = useMemo(() => weekModel({ plan: weekState.plan, courses: weekState.courses ?? [], assessments: [], tasks: weekState.tasks ?? [], monday: weekState.today ?? '1970-01-05', timeZone: weekState.timeZone }), [weekState]);
  const needs = needsYou({ attention: attention(state), confirmations: weekState.confirmations ?? [], overflow: rows.overflow, unestimated: rows.unestimated });
  const refreshAll = () => Promise.all([store.refresh(), week.refresh()]);
  const running = state.syncing || state.sync?.running;
  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => { void refreshAll(); }, 30000);
    return () => window.clearInterval(timer);
  }, [store, week]);
  useEffect(() => { document.documentElement.dataset.theme = theme; remember('coursework.theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; remember('coursework.language', language); }, [language]);
  useEffect(() => { if (panel) dialog.current?.showModal(); }, [panel]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  function open(next: Panel) { setMenu(false); setPanel(next); if (next === 'audit') void store.loadAudit(); }
  function close() { dialog.current?.close(); setPanel(undefined); avatar.current?.focus(); }
  const syncButton = <button disabled={!!running || !store.client.hasSession()} onClick={() => void store.sync().then(() => week.refresh())} aria-busy={!!running}>{running ? t.syncing : t.sync}</button>;
  function date(value?: string) { return value ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: state.planning?.settings?.timeZone }).format(new Date(value)) : t.never; }
  return <>
    <header>
      <span className="brand"><span className="brand-dot" />coursework</span>
      <nav aria-label="coursework">
        {(['week', 'agent'] as const).map(item => <button key={item} aria-current={view.page === item ? 'page' : undefined} onClick={() => setView({ page: item })}>{t[item]}</button>)}
      </nav>
      <div className="header-actions">{syncButton}
        <div className="avatar-wrap" ref={menuRoot} onKeyDown={event => { if (event.key === 'Escape') { setMenu(false); avatar.current?.focus(); } }}>
          <button className="avatar" ref={avatar} aria-label={t.menu} aria-expanded={menu} aria-controls="owner-menu" onClick={() => setMenu(!menu)}>Y</button>
          {!!needs.length && <span className="badge" />}
          {menu && <div id="owner-menu" className="menu">{(['status', 'metrics', 'audit', 'settings'] as const).map(item => <button key={item} onClick={() => open(item)}>{t[item]}</button>)}</div>}
        </div>
      </div>
    </header>
    <main>
      {!store.client.hasSession() && <p className="needs" role="status">{t.session}</p>}
      {state.errors.action && <p role="status">{errorText(state.errors.action, t)}</p>}
      <NeedsYou needs={needs} t={t} onStatus={() => open('status')} onAgent={() => setView({ page: 'agent' })} />
      <div className="page-heading"><h1>{view.page === 'course' ? t.course : t[view.page]}</h1><button onClick={() => void refreshAll()}>{t.refresh}</button></div>
      {view.page === 'agent' ? <section className="card empty"><p>{t.agentHelp}</p></section>
        : view.page === 'course' ? <section className="card empty"><p>{t.courseHelp}</p><button onClick={() => setView({ page: 'week' })}>{t.back}</button></section> : <>
        {state.errors.courses || state.errors.tasks ? <section className="card"><p>{t.error}</p></section>
          : !state.courses || !state.tasks ? <p role="status">{t.loading}</p>
          : emptyStore(state) ? <section className="card empty"><span className="empty-symbol" aria-hidden="true">◇</span><h2>{t.empty}</h2><p>{t.emptyHelp}</p>{syncButton}</section>
          : <>{!state.courses.coverage.complete || !state.tasks.coverage.complete ? <p>{t.incomplete}</p> : null}
            <WeekView store={week} t={t} language={language} canWrite={store.client.hasSession()} settingsMissing={!!state.planning && !state.planning.settings}
              onOpenCourse={courseId => setView({ page: 'course', courseId })} onOpenSettings={() => open('settings')} /></>}
      </>}
    </main>
    <dialog ref={dialog} onCancel={close} onClose={() => { setPanel(undefined); avatar.current?.focus(); }} aria-labelledby="panel-title">
      <div className="dialog-heading"><h2 id="panel-title">{panel ? t[panel] : ''}</h2><button onClick={close}>{t.close}</button></div>
      {panel === 'status' && <><button onClick={() => void store.refresh()}>{t.refresh}</button>
        {(['canvas', 'ed'] as const).map(site => <section className="provider" key={site}><h3>{site === 'ed' ? 'Ed' : 'Canvas'}</h3>
          <dl><dt>{t.status}</dt><dd>{state.errors.browser ? t.unavailable : state.browser?.[site] ? t[state.browser[site].state] : t.loading}</dd>
            <dt>{t.checked}</dt><dd>{date(state.browser?.[site]?.checkedAt)}</dd>
            <dt>{t.lastSync}</dt><dd>{state.errors.sync ? t.unavailable : date(state.sync?.[site].lastRun?.at)} {state.sync?.[site].lastRun?.status}</dd>
            <dt>{t.lastSuccess}</dt><dd>{state.errors.sync ? t.unavailable : date(state.sync?.[site].lastSuccess?.at)}</dd></dl>
          <button disabled={state.signingIn[site] || !store.client.hasSession()} aria-busy={state.signingIn[site]} aria-describedby={`focus-${site}`} onClick={() => void store.signIn(site)}>{state.signingIn[site] ? t.focusing : t.focus}</button><p id={`focus-${site}`} className="muted">{t.focusHelp}</p>
          {state.errors[`${site}SignIn`] && <p role="status">{errorText(state.errors[`${site}SignIn`]!, t)}</p>}
        </section>)}
        {(state.errors.browser || state.errors.sync) && <p role="status">{t.error}</p>}
      </>}
      {panel === 'metrics' && <p>{t.metricsHelp}</p>}
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
