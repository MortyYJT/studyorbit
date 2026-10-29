import { useEffect, useState } from 'react';
import type { Language } from './i18n.js';

/** The reply of GET/PUT /api/local/source-settings (server/routes/source-settings.ts). */
export type SourceSettingsReply = {
  settings: {
    version: 1; institution: string; canvasOrigin: string | null; browser: string; browserPath: string | null;
    edRegion: string; timeZone: string; codePattern: string | null;
  };
  saved: boolean;
  platform: string;
  available: {
    institutions: { id: string; label: { zh: string; en: string }; defaultCanvasOrigin: string | null; fixedTimeZone: string | null; frameworkLabel: string | null }[];
    browsers: { id: string; label: { zh: string; en: string }; experimental: boolean; implemented: boolean; available: boolean }[];
    edRegions: string[];
  };
};

/** Reads the source settings; null when the local server cannot answer. */
export async function fetchSourceSettings(): Promise<SourceSettingsReply | null> {
  try {
    const response = await fetch('/api/local/source-settings', { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json() as SourceSettingsReply;
  } catch { return null; }
}

type Form = { institution: string; canvasOrigin: string; browser: string; browserPath: string; edRegion: string; timeZone: string; codePattern: string };
function formFrom(reply: SourceSettingsReply): Form {
  const { settings } = reply;
  const fixed = reply.available.institutions.find(item => item.id === settings.institution)?.fixedTimeZone ?? null;
  return {
    institution: settings.institution, canvasOrigin: settings.canvasOrigin ?? '', browser: settings.browser, browserPath: settings.browserPath ?? '',
    edRegion: settings.edRegion, timeZone: fixed ? '' : settings.timeZone, codePattern: settings.codePattern ?? '',
  };
}

const fieldNames: Record<string, [string, string]> = {
  institution: ['学校', 'Institution'], canvasOrigin: ['Canvas 地址', 'Canvas address'], browser: ['浏览器', 'Browser'], browserPath: ['浏览器程序', 'Browser program'],
  edRegion: ['Ed 区域', 'Ed region'], timeZone: ['时区', 'Time zone'], codePattern: ['课程代码正则', 'Course code pattern'],
};

/**
 * 「数据来源」 (generic-adapters design §8, decision #447): institution, Canvas address, browser, Ed region and, for the
 * generic institution, time zone and course-code pattern. One form, one Save; saving is refused while a sync runs.
 */
export function SourceSettingsSection({ language, onSaved }: { language: Language; onSaved: (reply: SourceSettingsReply) => void }) {
  const zh = language === 'zh';
  const pick = (pair: [string, string]) => pair[zh ? 0 : 1];
  const [reply, setReply] = useState<SourceSettingsReply>();
  const [form, setForm] = useState<Form>();
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: string | null; reason: string }>();
  const [status, setStatus] = useState<{ problem: boolean; text: string }>();
  useEffect(() => {
    let live = true;
    void fetchSourceSettings().then(data => { if (!live) return; if (data) { setReply(data); setForm(formFrom(data)); } else setLoadError(true); });
    return () => { live = false; };
  }, []);
  const title = <h3 id="source-settings-title">{zh ? '数据来源' : 'Data sources'}</h3>;
  if (loadError) return <section className="model-settings" aria-labelledby="source-settings-title">{title}<p className="muted">{zh ? '无法读取数据来源设置（仅在本地服务中可用）。' : 'Could not read the data-source settings (local server only).'}</p></section>;
  if (!reply || !form) return <section className="model-settings" aria-labelledby="source-settings-title">{title}<p className="muted">{zh ? '加载中…' : 'Loading…'}</p></section>;

  const institution = reply.available.institutions.find(item => item.id === form.institution);
  const generic = !institution?.fixedTimeZone;
  const cdp = form.browser.startsWith('cdp-');
  const chosenBrowser = reply.available.browsers.find(item => item.id === form.browser);
  const initial = formFrom(reply);
  const dirty = (Object.keys(form) as (keyof Form)[]).some(key => form[key] !== initial[key]);
  const update = (patch: Partial<Form>) => { setForm({ ...form, ...patch }); setStatus(undefined); setFieldError(undefined); };
  const changeInstitution = (id: string) => {
    const next = reply.available.institutions.find(item => item.id === id);
    // The default institution has a fixed Canvas: fill it in; another institution starts with the owner's address.
    update({ institution: id, canvasOrigin: next?.defaultCanvasOrigin ?? (id === reply.settings.institution ? reply.settings.canvasOrigin ?? '' : ''), timeZone: '', codePattern: '' });
  };
  const errorFor = (field: string) => fieldError?.field === field && <small className="model-error" role="alert">{fieldError.reason}</small>;
  const browserLabel = (browser: SourceSettingsReply['available']['browsers'][number]) => `${pick([browser.label.zh, browser.label.en])}${browser.experimental ? (zh ? ' · 实验性，未在 Windows 上验证' : ' · experimental, not verified on Windows') : ''}${!browser.implemented ? (zh ? ' · 尚未实现' : ' · not built yet') : ''}`;

  async function save() {
    if (!form || !reply) return;
    setBusy(true); setStatus(undefined); setFieldError(undefined);
    try {
      const body = {
        institution: form.institution, canvasOrigin: form.canvasOrigin.trim() || null, browser: form.browser,
        browserPath: cdp && form.browserPath.trim() ? form.browserPath.trim() : null, edRegion: form.edRegion,
        timeZone: generic && form.timeZone.trim() ? form.timeZone.trim() : null, codePattern: generic && form.codePattern ? form.codePattern : null,
      };
      const response = await fetch('/api/local/source-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data: unknown = await response.json().catch(() => undefined);
      if (response.status === 409) { setStatus({ problem: true, text: zh ? '同步或获取课程正在进行，等它结束后再保存。' : 'A sync or course fetch is running. Save after it ends.' }); return; }
      if (response.status === 400 && data && typeof data === 'object' && 'field' in data) {
        const failure = data as { field: string | null; reason?: string };
        setFieldError({ field: failure.field, reason: failure.reason ?? '' });
        setStatus({ problem: true, text: zh ? `没有保存：${failure.field ? pick(fieldNames[failure.field] ?? [failure.field, failure.field]) : '设置'}${failure.reason ? `（${failure.reason}）` : ''}` : `Not saved: ${failure.field ? pick(fieldNames[failure.field] ?? [failure.field, failure.field]) : 'settings'}${failure.reason ? ` (${failure.reason})` : ''}` });
        return;
      }
      if (!response.ok) throw new Error();
      const next = data as SourceSettingsReply;
      const moved = next.settings.institution !== reply.settings.institution || next.settings.canvasOrigin !== reply.settings.canvasOrigin;
      setReply(next); setForm(formFrom(next)); onSaved(next);
      setStatus({ problem: moved, text: moved
        ? (zh ? '已保存。学校或 Canvas 地址已更改，请点击“立即同步”重新获取课程。' : 'Saved. The institution or Canvas address changed: click “Sync now” to fetch the courses again.')
        : (zh ? '已保存。下次同步开始时生效。' : 'Saved. Applies from the next sync.') });
    } catch { setStatus({ problem: true, text: zh ? '保存失败，请重试。' : 'Could not save. Please retry.' }); }
    finally { setBusy(false); }
  }

  return <section className="model-settings source-settings" aria-labelledby="source-settings-title">
    {title}
    <p className="muted model-note">{zh ? '从哪里获取课程：学校、Canvas 地址、用哪个浏览器读取 Canvas，以及 Ed 的区域。不改设置就和以前一样。' : 'Where courses come from: institution, Canvas address, the browser that reads Canvas, and the Ed region. Nothing changes until you save.'}
      {!reply.saved && (zh ? ' 现在使用默认设置。' : ' Using the defaults now.')}</p>
    <label className="model-row"><span className="k">{pick(fieldNames.institution!)}</span>
      <select value={form.institution} onChange={event => changeInstitution(event.target.value)}>{reply.available.institutions.map(item => <option key={item.id} value={item.id}>{pick([item.label.zh, item.label.en])}</option>)}</select>{errorFor('institution')}</label>
    <label className="model-row"><span className="k">{pick(fieldNames.canvasOrigin!)}</span>
      <input value={form.canvasOrigin} placeholder="https://canvas.example.edu" spellCheck={false} autoComplete="off" inputMode="url" onChange={event => update({ canvasOrigin: event.target.value })} />
      {errorFor('canvasOrigin') || <small className="muted">{zh ? '只填网站地址（https://…），不含路径。' : 'Only the site address (https://…), no path.'}</small>}</label>
    <label className="model-row"><span className="k">{pick(fieldNames.browser!)}</span>
      <select value={form.browser} onChange={event => update({ browser: event.target.value, browserPath: '' })}>{reply.available.browsers.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{browserLabel(item)}</option>)}</select>
      {errorFor('browser') || (chosenBrowser?.experimental && <small className="muted">{zh ? '实验性，未在 Windows 上验证。专用浏览器的采集在后续版本实现，目前选它同步会失败。' : 'Experimental, not verified on Windows. Collecting through the dedicated browser comes in a later version; syncing with it fails for now.'}</small>)}</label>
    {cdp && <label className="model-row"><span className="k">{pick(fieldNames.browserPath!)}</span>
      <input value={form.browserPath} placeholder={zh ? '可选：浏览器程序的完整路径' : 'Optional: full path of the browser program'} spellCheck={false} autoComplete="off" onChange={event => update({ browserPath: event.target.value })} />{errorFor('browserPath')}</label>}
    <label className="model-row"><span className="k">{pick(fieldNames.edRegion!)}</span>
      <select value={form.edRegion} onChange={event => update({ edRegion: event.target.value })}>{reply.available.edRegions.map(region => <option key={region} value={region}>{region === 'auto' ? (zh ? '自动（跟随 edstem 登录）' : 'Automatic (edstem sign-in)') : region}</option>)}</select>
      {errorFor('edRegion') || <small className="muted">{form.edRegion === 'auto' ? (zh ? '自动时课程链接按 au 生成；在美国或欧洲区请直接选 us 或 eu。' : 'Automatic links lessons on au; in the US or EU choose us or eu.') : (zh ? `与 edstem 登录区域不一致时不读取 Ed。${form.edRegion !== 'au' ? '这个区域没有实测过。' : ''}` : `Ed is skipped when the edstem sign-in is in another region.${form.edRegion !== 'au' ? ' This region is not verified.' : ''}`)}</small>}</label>
    {generic && <>
      <label className="model-row"><span className="k">{pick(fieldNames.timeZone!)}</span>
        <input value={form.timeZone} placeholder={zh ? '留空：本机时区' : 'Empty: this computer’s zone'} spellCheck={false} autoComplete="off" onChange={event => update({ timeZone: event.target.value })} />
        {errorFor('timeZone') || <small className="muted">{zh ? '例如 America/New_York；决定“今天”和截止日期按哪天算。' : 'For example America/New_York; decides “today” and the day of each deadline.'}</small>}</label>
      <label className="model-row"><span className="k">{pick(fieldNames.codePattern!)}</span>
        <input value={form.codePattern} placeholder={zh ? '可选，例如 ^([A-Z]+\\d+)' : 'Optional, e.g. ^([A-Z]+\\d+)'} spellCheck={false} autoComplete="off" onChange={event => update({ codePattern: event.target.value })} />
        {errorFor('codePattern') || <small className="muted">{zh ? '只同步课程代码匹配的课程，括号里的部分就是课程代码；留空时接受由字母、数字、空格、点、下划线和连字符组成的代码。' : 'Only courses whose code matches are synced; the part in parentheses is the course code. Empty accepts codes of letters, digits, spaces, dots, underscores and hyphens.'}</small>}</label>
    </>}
    <div className="model-actions">
      <button className="primary small" disabled={!dirty || busy} onClick={() => void save()}>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}</button>
      {status ? <span className={`model-status${status.problem ? ' problem' : ''}`} role="status">{status.problem && <i className="signal" aria-hidden="true" />}{status.text}</span>
        : dirty ? <span className="model-status muted">{zh ? '有未保存的更改。' : 'Unsaved changes.'}</span>
        : <span className="model-status muted">{zh ? `当前：${pick([institution?.label.zh ?? form.institution, institution?.label.en ?? form.institution])} · ${reply.settings.timeZone}` : `Current: ${institution?.label.en ?? form.institution} · ${reply.settings.timeZone}`}</span>}
    </div>
  </section>;
}
