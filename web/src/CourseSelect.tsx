import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Copy } from './i18n.js';
import { selectionRows, type ShellStore } from './shell.js';

function errorText(code: string, t: Copy) { return code === 'OWNER_SESSION_EXPIRED' ? t.session : `${t.error} (${code})`; }

/** Course selection dialog: offered courses with checkboxes, saved through the owner session (`courses.select`). */
export function CourseSelect({ store, t, onClose }: { store: ShellStore; t: Copy; onClose: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const s = t.syncNeeds;
  const ref = useRef<HTMLDialogElement>(null);
  const rows = useMemo(() => selectionRows(state.candidates ?? []), [state.candidates]);
  const [checked, setChecked] = useState<Set<string>>();
  const [saved, setSaved] = useState(false);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); void store.loadCandidates(); return () => dialog?.close(); }, [store]);
  // Start from the recorded decisions once the candidates arrive; later reloads keep the owner's ticks.
  useEffect(() => { if (state.candidates && !checked) setChecked(new Set(rows.filter(row => row.checked).map(row => row.key))); }, [state.candidates, rows, checked]);
  function toggle(key: string, on: boolean) {
    const next = new Set(checked); if (on) next.add(key); else next.delete(key);
    setChecked(next); setSaved(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checked && await store.selectCourses(rows, checked)) setSaved(true);
  }
  return <dialog ref={ref} onClose={onClose} aria-labelledby="select-title">
    <div className="dialog-heading"><h2 id="select-title">{s.dialogTitle}</h2><button onClick={() => ref.current?.close()}>{t.close}</button></div>
    <p className="muted">{s.dialogHelp}</p>
    {state.errors.candidates ? <p role="status">{errorText(state.errors.candidates, t)}</p>
      : !state.candidates || !checked ? <p role="status">{t.loading}</p>
      : !rows.length ? <p>{s.noCandidates}</p>
      : <form onSubmit={event => void submit(event)}>
        <fieldset className="course-select"><legend className="visually-hidden">{s.dialogTitle}</legend>
          {rows.map(row => <label key={row.key} className="check-row">
            <input type="checkbox" checked={checked.has(row.key)} onChange={event => toggle(row.key, event.target.checked)} />
            <span><b>{row.code}</b> {row.name && <span className="muted">{row.name}</span>} <small>{row.term}</small></span>
            {row.undecided && <span className="pill">{s.newCourse}</span>}
          </label>)}
        </fieldset>
        <button type="submit" className="primary" disabled={state.selecting || !store.client.hasSession()} aria-busy={state.selecting}>{state.selecting ? t.saving : s.saveSelection}</button>
        {saved && <p role="status">{s.selectionSaved}</p>}
      </form>}
    {state.errors.select && <p role="status" className="error">{errorText(state.errors.select, t)}</p>}
  </dialog>;
}
