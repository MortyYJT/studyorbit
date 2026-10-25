import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Client } from './client.js';
import type { Copy, Language } from './i18n.js';
import { MemoryStore, type MemoryKind, type MemoryView } from './memory.js';

type Course = { id: string; code: string; name: string };
const kinds: MemoryKind[] = ['habit', 'weakness', 'preference', 'other'];
export function MemoryPanel({ client, t, language, courses, onConversation, timeZone }: {
  client: Client; t: Copy; language: Language; courses: readonly Course[]; onConversation(id: string): void; timeZone?: string;
}) {
  const store = useMemo(() => new MemoryStore(client), [client]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [editing, setEditing] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const copy = t.memoryCopy;
  const disabled = state.loading || state.saving || !client.hasSession();
  useEffect(() => { void store.load(); }, [store]);
  const when = (value: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone }).format(new Date(value));
  const label = (item: MemoryView) => item.courseId ? courses.find(course => course.id === item.courseId)?.code ?? item.courseId : copy.general;
  return <div className="memory-panel">
    <div className="row-heading"><button disabled={state.loading || state.saving} onClick={() => void store.load()}>{t.refresh}</button>
      <button disabled={disabled} onClick={() => setAdding(!adding)}>{copy.add}</button></div>
    {!client.hasSession() && <p role="status">{t.session}</p>}
    {state.error && <p role="status">{state.error === 'OWNER_SESSION_EXPIRED' ? t.session : `${t.error} (${state.error})`}</p>}
    {state.loading && <p role="status">{t.loading}</p>}
    {adding && <MemoryForm key="add" t={t} courses={courses} disabled={disabled} onCancel={() => setAdding(false)}
      onSave={async input => { if (await store.add(input)) setAdding(false); }} />}
    {state.items?.length === 0 && <p className="muted">{copy.empty}</p>}
    <div className="memory-list">{state.items?.map(item => <article key={item.id}>
      <div className="memory-meta"><strong>{copy.kinds[item.kind]}</strong><span>{label(item)}</span><time dateTime={item.createdAt}>{when(item.createdAt)}</time><span>{copy[item.origin]}</span></div>
      {item.origin === 'agent' && <p className="muted">{item.conversationId
        ? <a href={`?conversation=${encodeURIComponent(item.conversationId)}`} onClick={event => { event.preventDefault(); onConversation(item.conversationId!); }}>{copy.source}</a>
        : item.sourceDeleted ? copy.deleted : copy.noSource}</p>}
      {editing === item.id ? <MemoryForm key={item.id} item={item} t={t} courses={courses} disabled={disabled} onCancel={() => setEditing(undefined)}
        onSave={async input => { if (await store.edit(item.id, input.text, input.kind)) setEditing(undefined); }} />
        : <><p className="memory-text">{item.text}</p><div className="memory-actions"><button disabled={disabled} onClick={() => { setEditing(item.id); setDeleting(undefined); }}>{copy.edit}</button>
          <button disabled={disabled} onClick={() => setDeleting(item.id)}>{t.delete}</button></div></>}
      {deleting === item.id && <div role="group" aria-label={copy.confirm} className="memory-confirm"><p>{copy.confirm}</p>
        <button disabled={disabled} onClick={() => void store.remove(item.id).then(ok => { if (ok) setDeleting(undefined); })}>{t.confirmDelete}</button>
        <button disabled={state.saving} onClick={() => setDeleting(undefined)}>{copy.cancel}</button></div>}
    </article>)}</div>
    {state.nextCursor && <button disabled={state.loading || state.saving} onClick={() => void store.load(true)}>{t.more}</button>}
  </div>;
}
function MemoryForm({ item, t, courses, disabled, onSave, onCancel }: {
  item?: MemoryView; t: Copy; courses: readonly Course[]; disabled: boolean;
  onSave(input: { text: string; kind: MemoryKind; courseId?: string }): Promise<void>; onCancel(): void;
}) {
  const [text, setText] = useState(item?.text ?? '');
  const [kind, setKind] = useState<MemoryKind>(item?.kind ?? 'other');
  const [courseId, setCourseId] = useState('');
  const copy = t.memoryCopy;
  function submit(event: FormEvent) { event.preventDefault(); if (text.trim()) void onSave({ text: text.trim(), kind, ...(courseId ? { courseId } : {}) }); }
  return <form onSubmit={submit} className="memory-form" aria-label={item ? copy.edit : copy.add}>
    <label>{copy.kind}<select value={kind} disabled={disabled} onChange={event => setKind(event.target.value as MemoryKind)}>{kinds.map(value => <option key={value} value={value}>{copy.kinds[value]}</option>)}</select></label>
    {!item && <label>{t.course}<select value={courseId} disabled={disabled} onChange={event => setCourseId(event.target.value)}><option value="">{copy.general}</option>{courses.map(course => <option key={course.id} value={course.id}>{course.code} · {course.name}</option>)}</select></label>}
    <label>{copy.text}<textarea value={text} required maxLength={500} rows={4} disabled={disabled} onChange={event => setText(event.target.value)} /></label>
    <small>{text.length} / 500</small>
    <div className="memory-actions"><button type="submit" disabled={disabled || !text.trim()}>{copy.save}</button><button type="button" disabled={disabled} onClick={onCancel}>{copy.cancel}</button></div>
  </form>;
}
