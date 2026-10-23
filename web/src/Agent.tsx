import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Conversation, PendingConfirmation } from '../../src/domain/schemas.js';
import { ClientError, type Client } from './client.js';
import { createAgentClient, type AgentClient } from './agent-client.js';
import { applyEvents, chatItems, unlinkedConfirmations, fromOpen, launchPresetOnce, pendingConfirmations, runStream, type AgentPreset, type ChatItem, type ChatState } from './chat.js';
import type { Copy, Language } from './i18n.js';

const code = (error: unknown) => error instanceof ClientError ? error.code : 'SOURCE_UNAVAILABLE';
const errorText = (value: string, t: Copy) => value === 'OWNER_SESSION_EXPIRED' ? t.session : `${t.error} (${value})`;
const outcomeText = { ok: 'stepOk', error: 'stepError', denied: 'stepDenied', waiting: 'stepWaiting' } as const;

function Screenshot({ agent, screenshotRef, t, open = false }: { agent: AgentClient; screenshotRef: string; t: Copy; open?: boolean }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (!shown) return;
    let alive = true; let objectUrl: string | undefined;
    agent.image(screenshotRef).then(blob => { if (alive) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [agent, screenshotRef, shown]);
  const body = failed ? <p className="muted">{t.screenshotUnavailable}</p> : url ? <img className="shot" src={url} alt={t.screenshot} /> : <p className="muted">{t.loading}</p>;
  if (open) return body;
  return <details className="shot-toggle" onToggle={event => setShown(event.currentTarget.open)}><summary>{t.screenshot}</summary>{shown && body}</details>;
}
/** Self-contained so "needs you" can render the same card outside a conversation. */
export function ConfirmationCard({ confirmation, client, t, onDecided }: { confirmation: PendingConfirmation; client: Client; t: Copy; onDecided?: (decision: 'confirmed' | 'cancelled') => void }) {
  const agent = useMemo(() => createAgentClient(client), [client]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function decide(decision: 'confirmed' | 'cancelled') {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await client.call('confirmation.decide', { confirmationId: confirmation.id, decision }); onDecided?.(decision); }
    catch (failure) { setError(code(failure)); }
    finally { setBusy(false); }
  }
  return <section className="confirm-card" aria-label={t.confirmTitle}>
    <b>{t.confirmTitle}</b>
    <p className="confirm-summary">{confirmation.summary}</p>
    <Screenshot agent={agent} screenshotRef={confirmation.screenshotRef} t={t} open />
    <div className="confirm-actions">
      <button className="alert-button" disabled={busy || !client.hasSession()} aria-busy={busy} onClick={() => void decide('confirmed')}>{busy ? t.deciding : t.confirmSubmit}</button>
      <button disabled={busy || !client.hasSession()} onClick={() => void decide('cancelled')}>{t.cancel}</button>
    </div>
    {error && <p role="status">{errorText(error, t)}</p>}
  </section>;
}
function Item({ item, agent, client, t, confirmations, onDecided }: { item: ChatItem; agent: AgentClient; client: Client; t: Copy;
  confirmations?: Map<string, PendingConfirmation>; onDecided(): void }) {
  const [viewError, setViewError] = useState<string>();
  if (item.kind === 'owner') return <><div className="msg me">{item.text}</div>{item.preset && <div className="msg-note">{t.presetSent}</div>}</>;
  if (item.kind === 'text') return <div className="msg ag">{item.text}</div>;
  if (item.kind === 'stopped') return <div className="msg-note left">{t.stopped}</div>;
  if (item.kind === 'error') return <div className="msg ag error-text">{item.code === 'AGENT_UNAVAILABLE' ? t.agentUnavailable : t.agentFailed}</div>;
  if (item.kind === 'confirmation') {
    if (item.decision !== 'pending') return <div className="msg-note left">{t[`${item.decision}Submit` as const]}</div>;
    const record = confirmations?.get(item.confirmationId);
    return record ? <ConfirmationCard confirmation={record} client={client} t={t} onDecided={onDecided} />
      : <div className="msg-note left">{confirmations ? t.confirmationUnavailable : t.loading}</div>;
  }
  return <div className={`step ${item.outcome}`}>
    <div className="step-head"><code>{item.tool}</code><small>{t[outcomeText[item.outcome]]}</small></div>
    {item.reason && <p className="step-reason">{item.reason}</p>}
    {item.screenshotRef && <Screenshot agent={agent} screenshotRef={item.screenshotRef} t={t} />}
    {item.tabId && <button className="small" onClick={() => { setViewError(undefined); agent.view(item.tabId!).catch(error => setViewError(code(error))); }}>{t.viewEdge}</button>}
    {viewError && <p role="status">{errorText(viewError, t)}</p>}
  </div>;
}
/** Agent page: conversation list newest first, open conversation with a resumable event stream. */
export function AgentPage({ client, t, language, preset, onPresetDone }: { client: Client; t: Copy; language: Language; preset?: AgentPreset; onPresetDone?: (conversationId: string) => void }) {
  const agent = useMemo(() => createAgentClient(client), [client]);
  const [conversations, setConversations] = useState<Conversation[]>();
  const [selected, setSelected] = useState<string>();
  const [chat, setChat] = useState<ChatState>();
  const [confirmations, setConfirmations] = useState<Map<string, PendingConfirmation>>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const live = useRef<ChatState>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const commit = (next: ChatState) => { live.current = next; setChat(next); };
  const refreshList = () => agent.list().then(setConversations).catch(failure => setError(code(failure)));
  useEffect(() => { if (client.hasSession()) void refreshList(); }, [agent]);
  useEffect(() => {
    if (!preset || !client.hasSession()) return;
    launchPresetOnce(preset, value => agent.create(value)).then(conversation => {
      setSelected(conversation.id); void refreshList(); onPresetDone?.(conversation.id);
    }).catch(failure => setError(code(failure)));
  }, [preset, agent]);
  useEffect(() => {
    live.current = undefined; setChat(undefined); setConfirmations(undefined); setDeleting(false);
    if (!selected) return;
    const controller = new AbortController();
    void agent.open(selected).then(opened => {
      if (controller.signal.aborted) return;
      commit(fromOpen(undefined, opened));
      return runStream({ connect: (after, signal) => agent.stream(selected, after, signal), signal: controller.signal,
        cursor: () => live.current?.conversation.id === selected ? live.current.cursor : undefined,
        onEvents: events => { if (live.current?.conversation.id === selected) commit(applyEvents(live.current, events)); },
        delay: ms => new Promise(resolve => setTimeout(resolve, ms)) });
    }).catch(failure => { if (!controller.signal.aborted) setError(code(failure)); });
    return () => controller.abort();
  }, [selected, agent]);
  const items = chat ? chatItems(chat) : [];
  const pendingKey = chat ? pendingConfirmations(chat).join(',') : '';
  const loadConfirmations = () => client.call('confirmation.list', { limit: 50 })
    .then(result => setConfirmations(new Map(result.items.map(row => [row.id, row])))).catch(() => setConfirmations(new Map()));
  useEffect(() => { if (chat) void loadConfirmations(); }, [pendingKey, chat?.conversation.id]);
  const unlinked = chat && confirmations ? unlinkedConfirmations(chat, [...confirmations.values()]) : [];
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [items.length, chat?.events.length]);
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await work(); } catch (failure) { setError(code(failure)); } finally { setBusy(false); }
  }
  function send(event: FormEvent) {
    event.preventDefault();
    const prompt = draft.trim(); const id = selected;
    if (!prompt || !id || chat?.running) return;
    void act(async () => {
      await agent.send(id, prompt); setDraft('');
      const opened = await agent.open(id);
      if (live.current?.conversation.id === id) commit(fromOpen(live.current, opened));
      void refreshList();
    });
  }
  const create = () => act(async () => { const conversation = await agent.create(); await refreshList(); setSelected(conversation.id); });
  const remove = (id: string) => act(async () => { await agent.remove(id); setSelected(undefined); await refreshList(); });
  const when = (value: string) => new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const writable = client.hasSession();
  return <div className="agent-page card">
    <nav className="chat-list" aria-label={t.chats}>
      <button className="new-chat" disabled={busy || !writable} onClick={() => void create()}>＋ {t.newChat}</button>
      {!conversations ? <p className="muted">{writable ? t.loading : t.session}</p> : !conversations.length && <p className="muted">{t.noChats}</p>}
      {conversations?.map(conversation => <button key={conversation.id} className="chat-entry" aria-current={conversation.id === selected ? 'true' : undefined} onClick={() => setSelected(conversation.id)}>
        <span>{conversation.title}</span><small>{when(conversation.updatedAt)}</small></button>)}
    </nav>
    <section className="conversation" aria-live="polite">
      {!selected ? <div className="conversation-empty"><p className="muted">{t.pickChat}</p></div> : <>
        <div className="conversation-head"><b>{chat?.conversation.title ?? conversations?.find(c => c.id === selected)?.title}</b>
          {chat?.running && <small className="muted" role="status">{t.replying}</small>}
          <span className="conversation-actions">
            {deleting ? <><button className="small" disabled={busy} onClick={() => void remove(selected)}>{t.confirmDelete}</button><button className="small" onClick={() => setDeleting(false)}>{t.cancel}</button></>
              : <button className="small" disabled={busy || !writable} onClick={() => setDeleting(true)}>{t.deleteChat}</button>}
          </span></div>
        <div className="chat-messages" ref={scroller}>
          {!chat ? <p className="muted">{t.loading}</p> : items.map(item => <Item key={item.id} item={item} agent={agent} client={client} t={t} confirmations={confirmations} onDecided={() => void loadConfirmations()} />)}
          {unlinked.map(row => <ConfirmationCard key={row.id} confirmation={row} client={client} t={t} onDecided={() => void loadConfirmations()} />)}
        </div>
        <form className="chat-form" onSubmit={send}>
          <input aria-label={t.chatPlaceholder} placeholder={t.chatPlaceholder} value={draft} onChange={event => setDraft(event.target.value)} maxLength={65536} disabled={!writable} />
          {chat?.running ? <button type="button" disabled={busy} onClick={() => void act(() => agent.stop(selected))}>{t.stop}</button>
            : <button type="submit" className="ink-button" disabled={busy || !writable || !chat || !draft.trim()}>{t.send}</button>}
        </form>
      </>}
      {error && <p className="chat-error" role="status">{errorText(error, t)}</p>}
    </section>
  </div>;
}
