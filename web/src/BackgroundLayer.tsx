// Page background: one fixed layer behind the shell, plus its settings section (gradient, solid colour or an image).
import { useEffect, useState, type CSSProperties } from 'react';
import {
  backgroundFileProblem, backgroundLimits, backgroundModes, loadBackgroundImage, maxBackgroundBytes, prepareBackgroundImage,
  removeBackgroundImage, saveBackgroundImage, surfaceAlpha, type BackgroundMode, type BackgroundSettings,
} from './background.js';

/** Mirrors the settings onto <html>; index.html does the same before mount so the first paint is right. */
export function applyBackground(settings: BackgroundSettings) {
  const root = document.documentElement;
  const alpha = surfaceAlpha(settings);
  root.dataset.bg = settings.mode;
  root.style.setProperty('--surface-alpha', `${alpha}%`);
  if (alpha < 100) root.dataset.glass = ''; else delete root.dataset.glass;
}

/**
 * The stored image as an object URL; it is read from IndexedDB once after mount and revoked when replaced.
 * `loadFailed` is true when that read fails (storage blocked or corrupt), so the shell can say why no image shows.
 */
export function useBackgroundImage(): { url?: string; setUrl: (url: string | undefined) => void; loadFailed: boolean; dismissLoadFailure: () => void } {
  const [url, setUrl] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadBackgroundImage().then(blob => { if (live && blob) setUrl(URL.createObjectURL(blob)); }).catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return { url, setUrl: next => { setLoadFailed(false); setUrl(next); }, loadFailed, dismissLoadFailure: () => setLoadFailed(false) };
}

/** Image layers sit on a ground (gradient or solid, styled by data-bg); the scrim fades the image toward the ground. */
export function Backdrop({ settings, image }: { settings: BackgroundSettings; image?: string }) {
  const showImage = settings.mode === 'image' && image;
  return <div className="backdrop" aria-hidden="true">
    {showImage && <>
      <div className="backdrop-image" style={{ backgroundImage: `url("${image}")`, ...(settings.blur ? { filter: `blur(${settings.blur}px)`, inset: `${-settings.blur * 2}px` } : {}) }} />
      <div className="backdrop-scrim" style={{ opacity: (100 - settings.visibility) / 100 }} />
    </>}
  </div>;
}

const modeNames: Record<BackgroundMode, [string, string]> = { gradient: ['渐变', 'Gradient'], solid: ['纯色', 'Solid'], image: ['图片', 'Image'] };

export function BackgroundSettingsSection({ zh, settings, image, onChange, onMode, onImage }: {
  zh: boolean; settings: BackgroundSettings; image?: string;
  onChange: (next: BackgroundSettings) => void; onMode: (mode: BackgroundMode) => void; onImage: (url: string | undefined) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function upload(file: File) {
    const problem = backgroundFileProblem(file);
    if (problem) {
      setError(problem === 'type' ? (zh ? '只支持 JPG、PNG 或 WebP 图片。' : 'Only JPG, PNG or WebP images are supported.')
        : (zh ? `图片不能超过 ${maxBackgroundBytes / 1024 / 1024} MB。` : `The image must be ${maxBackgroundBytes / 1024 / 1024} MB or smaller.`));
      return;
    }
    setBusy(true); setError('');
    try {
      let blob: Blob;
      try { blob = await prepareBackgroundImage(file); } catch { setError(zh ? '无法读取这张图片，请换一张试试。' : 'Could not read this image. Try another one.'); return; }
      try { await saveBackgroundImage(blob); } catch { setError(zh ? '图片保存失败，请检查浏览器存储。' : 'Could not store the image in this browser.'); return; }
      onImage(URL.createObjectURL(blob));
      if (settings.mode !== 'image') onMode('image');
    } finally { setBusy(false); }
  }
  async function remove() {
    setError('');
    try { await removeBackgroundImage(); } catch { setError(zh ? '图片移除失败。' : 'Could not remove the image.'); return; }
    onImage(undefined);
    onMode('gradient');
  }
  const slider = (key: 'visibility' | 'blur' | 'cardOpacity', label: string, unit: string) => {
    const [min, max] = backgroundLimits[key];
    return <label className="range-row"><span>{label}</span><output>{settings[key]}{unit}</output>
      <input type="range" min={min} max={max} step={1} value={settings[key]} onChange={event => onChange({ ...settings, [key]: Number(event.target.value) })} /></label>;
  };
  const previewAlpha = surfaceAlpha(settings);
  return <fieldset className="background-picker"><legend>{zh ? '背景' : 'Background'}</legend>
    <div className="seg" role="group" aria-label={zh ? '背景类型' : 'Background type'}>
      {backgroundModes.map(mode => <button key={mode} type="button" aria-pressed={settings.mode === mode} onClick={() => onMode(mode)}>{modeNames[mode][zh ? 0 : 1]}</button>)}
    </div>
    {settings.mode === 'image' && <div className="background-image">
      <div className="background-preview" aria-hidden="true">
        {image && <i className="preview-image" style={{ backgroundImage: `url("${image}")`, filter: settings.blur ? `blur(${Math.max(0.5, settings.blur / 6)}px)` : undefined }} />}
        <i className="preview-scrim" style={{ opacity: image ? (100 - settings.visibility) / 100 : 1 }} />
        <i className="preview-card" style={{ '--preview-alpha': `${previewAlpha}%` } as CSSProperties}><b /><b /></i>
      </div>
      <div className="background-controls">
        <div className="background-actions">
          <label className="avatar-upload" aria-busy={busy}>{busy ? (zh ? '处理中…' : 'Processing…') : image ? (zh ? '更换图片' : 'Change image') : (zh ? '选择图片' : 'Choose image')}
            <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file); }} /></label>
          {image && <button type="button" disabled={busy} onClick={() => void remove()}>{zh ? '移除图片' : 'Remove image'}</button>}
        </div>
        <small className="muted">{zh ? 'JPG、PNG 或 WebP，最大 15 MB。图片只保存在这个浏览器里，不会上传。' : 'JPG, PNG or WebP up to 15 MB. Stored only in this browser, never uploaded.'}</small>
        {slider('visibility', zh ? '图片可见度' : 'Image visibility', '%')}
        {slider('blur', zh ? '模糊' : 'Blur', ' px')}
        {slider('cardOpacity', zh ? '卡片不透明度' : 'Card opacity', '%')}
      </div>
    </div>}
    {error && <p className="error-line" role="alert"><i className="signal" aria-hidden="true" />{error}</p>}
  </fieldset>;
}
