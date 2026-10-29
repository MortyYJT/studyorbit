// Agent chat page (decision #230): conversation list beside the open conversation, streamed replies over SSE.
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Language } from './i18n.js';
import type { SidebarCourse } from './LocalPlanning.js';
import type { Chat, ChatMessage, ChatSummary } from '../../scripts/lib/chat-store.mjs';

/** A request from elsewhere in the app to open a fresh chat, optionally scoped to one course and sending a preset prompt. */
export type AgentRequest = { nonce: number; courseId?: string; prompt?: string };
type Failure = { code: string; message: string };
type Draft = { scope: string[] | null };

function selectedCourseIds(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem('coursework.selected-course-ids') ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; }
  catch { return []; }
}
// The page remounts on every visit, so the last handled request lives outside it: a request is acted on (and its prompt sent) once.
let handledNonce: number | undefined;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));

/** Split a server-sent event stream into parsed `{event, data}` records. */
async function readStream(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: Record<string, unknown>) => void) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const flush = (block: string) => {
    let event = 'message'; const data: string[] = [];
    for (const line of block.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
    if (!data.length) return;
    try { onEvent(event, JSON.parse(data.join('\n')) as Record<string, unknown>); } catch { /* Ignore malformed events. */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) { flush(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
  }
  if (buffer.trim()) flush(buffer);
}

/** Plain-text rendering: paragraphs, bullet and numbered lists, headings as bold lines. No HTML is interpreted. */
export function RichText({ text }: { text: string }) {
  const blocks = text.replace(/\*\*(.+?)\*\*/g, '$1').split(/\n{2,}/).map(block => block.split('\n').filter(line => line.trim()));
  return <>{blocks.map((lines, index) => {
    if (!lines.length) return null;
    const bullet = /^\s*[-*•]\s+/, numbered = /^\s*\d+[.)、]\s+/;
    if (lines.every(line => bullet.test(line))) return <ul key={index}>{lines.map((line, item) => <li key={item}>{line.replace(bullet, '')}</li>)}</ul>;
    if (lines.every(line => numbered.test(line))) return <ol key={index}>{lines.map((line, item) => <li key={item}>{line.replace(numbered, '')}</li>)}</ol>;
    const parts: ReactNode[] = [];
    lines.forEach((line, item) => {
      const heading = /^#{1,6}\s+/.test(line);
      parts.push(<Fragment key={item}>{item > 0 && <br />}{heading ? <strong>{line.replace(/^#{1,6}\s+/, '')}</strong> : line}</Fragment>);
    });
    return <p key={index}>{parts}</p>;
  })}</>;
}

export function AgentChat({ language, courses, request, onOpenSettings }: { language: Language; courses: SidebarCourse[]; request?: AgentRequest; onOpenSettings: () => void }) {
  const zh = language === 'zh';
  const [chats, setChats] = useState<(ChatSummary & { running?: boolean })[]>();
  const [listError, setListError] = useState(false);
  const [active, setActive] = useState<Chat>();
  const [draft, setDraft] = useState<Draft>({ scope: request?.courseId ? [request.courseId] : null });
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState<Failure>();
  const [remoteRunning, setRemoteRunning] = useState(false);
  // A preset prompt waits until the fresh draft it belongs to has rendered, then sends once.
  const [queued, setQueued] = useState<string>();
  const [saved, setSaved] = useState<Record<string, 'saving' | 'saved' | 'failed'>>({});
  const messagesRef = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // Messages at or after this index were added in this view and rise in; history and the saved copy of a streamed reply do not.
  const entered = useRef(0);
  const busy = streaming !== undefined;

  async function loadList() {
    try {
      const response = await fetch('/api/local/chats', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json() as { chats: (ChatSummary & { running?: boolean })[] };
      setChats(data.chats); setListError(false);
    } catch { setListError(true); setChats(current => current ?? []); }
  }
  async function loadChat(id: string): Promise<(Chat & { running?: boolean }) | undefined> {
    const response = await fetch(`/api/local/chats/${id}`, { cache: 'no-store' });
    if (!response.ok) return undefined;
    return await response.json() as Chat & { running?: boolean };
  }
  async function open(id: string) {
    if (busy) return;
    setFailure(undefined);
    const chat = await loadChat(id);
    if (!chat) { await loadList(); return; }
    entered.current = chat.messages.length;
    setActive(chat); setRemoteRunning(!!chat.running);
  }
  function startDraft(courseId?: string) {
    if (busy) return;
    entered.current = 0;
    setActive(undefined); setFailure(undefined); setRemoteRunning(false); setDraft({ scope: courseId ? [courseId] : null });
    composer.current?.focus();
  }

  useEffect(() => { void loadList(); }, []);
  useEffect(() => {
    if (!request || request.nonce === handledNonce || busy) return;
    handledNonce = request.nonce; startDraft(request.courseId);
    if (request.prompt) setQueued(request.prompt);
  }, [request]);
  useEffect(() => { if (queued && !active && !busy) { setQueued(undefined); void send(queued); } }, [queued, active, busy]);
  useEffect(() => { const element = messagesRef.current; if (element) element.scrollTop = element.scrollHeight; }, [active, streaming, pending]);
  // A reply started before this page was opened keeps running on the server; poll until it is saved.
  useEffect(() => {
    if (!remoteRunning || !active) return;
    const timer = window.setInterval(async () => {
      const chat = await loadChat(active.id).catch(() => undefined);
      if (chat && !chat.running) { entered.current = chat.messages.length; setActive(chat); setRemoteRunning(false); void loadList(); }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [remoteRunning, active?.id]);

  const scope = active ? active.courseIds : draft.scope ?? selectedCourseIds();
  const allSelected = sameSet(scope, selectedCourseIds());
  const codeOf = (id: string) => courses.find(course => course.id === id)?.code ?? id;
  const scopeText = !scope.length ? (zh ? '没有选择课程' : 'No courses selected')
    : allSelected && scope.length > 1 ? (zh ? '全部已选课程' : 'All selected courses') : scope.map(codeOf).join(zh ? '、' : ', ');

  function describeFailure(code: string, fallback?: string): string {
    if (code === 'ANALYSIS_PROVIDER_INVALID') return zh ? '环境变量 COURSE_ANALYSIS_PROVIDER 不是可识别的提供方。' : 'COURSE_ANALYSIS_PROVIDER is not a known provider.';
    if (code === 'ANALYSIS_KEY_MISSING') return zh ? '分析模型还没有 API 密钥。' : 'The analysis model has no API key.';
    if (code.startsWith('ANALYSIS_')) return zh ? '分析模型还没配置好（接口地址或模型缺失）。' : 'The analysis model is not fully configured.';
    if (code === 'REPLY_RUNNING') return zh ? '这个对话正在回复，请等它结束或先停止。' : 'A reply is already running in this chat.';
    if (code === 'CONTENT_TOO_LONG') return zh ? '消息太长（最多 8000 字）。' : 'Message is too long (8,000 characters max).';
    if (code === 'CHAT_NOT_FOUND') return zh ? '这个对话已被删除。' : 'This chat was deleted.';
    return fallback || (zh ? '无法完成回复，请重试。' : 'Could not complete the reply. Please retry.');
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy || remoteRunning) return;
    setFailure(undefined); setPending(content); setStreaming(''); setInput('');
    let chat = active;
    let created: Chat | undefined, accepted = false;
    // A chat created for this send is removed again if the server refuses the message before saving it.
    const discardCreated = async () => {
      if (!created) return;
      const id = created.id; created = undefined; chat = undefined; setActive(undefined);
      try { await fetch(`/api/local/chats/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }); } catch { /* Left as an empty chat. */ }
    };
    try {
      if (!chat) {
        const response = await fetch('/api/local/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseIds: scope }) });
        if (!response.ok) throw new Error('CHAT_UNAVAILABLE');
        chat = created = await response.json() as Chat;
        setActive(chat);
      }
      const response = await fetch(`/api/local/chats/${chat.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, courseIds: scope, language }) });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        const code = data.error ?? 'CHAT_UNAVAILABLE';
        setFailure({ code, message: describeFailure(code) });
        if (code !== 'REPLY_RUNNING') setInput(content);
        await discardCreated();
      } else {
        accepted = true;
        await readStream(response.body, (event, data) => {
          if (event === 'delta' && typeof data.text === 'string') setStreaming(current => (current ?? '') + data.text);
          if (event === 'error') setFailure({ code: String(data.error ?? 'MODEL_ERROR'), message: describeFailure(String(data.error ?? ''), typeof data.message === 'string' ? data.message : undefined) });
        });
      }
    } catch {
      setFailure({ code: 'CHAT_UNAVAILABLE', message: zh ? '无法连接本地服务（仅在本地开发服务器中可用）。' : 'Could not reach the local server (dev server only).' });
      if (!accepted) { setInput(content); await discardCreated(); }
    } finally {
      if (chat) { const fresh = await loadChat(chat.id).catch(() => undefined); if (fresh) { entered.current = fresh.messages.length; setActive(fresh); } }
      setStreaming(undefined); setPending(undefined);
      void loadList();
    }
  }
  /** Save one finished reply of a single-course chat as a revision note (decision #236). */
  async function saveNote(chat: Chat, index: number, content: string) {
    const key = `${chat.id}:${index}`;
    setSaved(current => ({ ...current, [key]: 'saving' }));
    try {
      const response = await fetch('/api/local/revision-notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: chat.courseIds[0], content, chatId: chat.id }) });
      setSaved(current => ({ ...current, [key]: response.ok ? 'saved' : 'failed' }));
    } catch { setSaved(current => ({ ...current, [key]: 'failed' })); }
  }
  async function stop() {
    if (!active) return;
    try { await fetch(`/api/local/chats/${active.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* The reply ends on its own. */ }
  }
  async function remove(chat: ChatSummary) {
    if (busy && active?.id === chat.id) return;
    if (!window.confirm(zh ? `删除对话「${chat.title || '新对话'}」？删除后无法恢复。` : `Delete "${chat.title || 'New chat'}"? This cannot be undone.`)) return;
    try {
      const response = await fetch(`/api/local/chats/${chat.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      if (!response.ok && response.status !== 404) throw new Error('failed');
      if (active?.id === chat.id) startDraft();
    } catch { setFailure({ code: 'DELETE_FAILED', message: zh ? '删除失败，请重试。' : 'Could not delete the chat.' }); }
    void loadList();
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); }
  }

  // The server saves the user message first, but the open chat is reloaded only when the reply ends.
  const messages: ChatMessage[] = [...(active?.messages ?? []), ...(pending ? [{ role: 'user' as const, content: pending, at: '' }] : [])];
  const suggestions = zh
    ? ['这周我应该先做什么？', '按现在的成绩，期末要拿 H1 需要多少分？', '帮我出 5 道复习题', '解释一下各项考核的权重']
    : ['What should I do first this week?', 'What do I need on the final to get an H1?', 'Give me 5 revision questions', 'Explain how my assessments are weighted'];
  const note = (message: ChatMessage, index: number) => {
    const parts = [message.model, message.usage ? `${(message.usage.input + message.usage.output).toLocaleString(language)} tokens` : null,
      message.status === 'stopped' ? (zh ? '已停止' : 'Stopped') : message.status === 'error' ? (zh ? '未完成' : 'Incomplete') : null].filter(Boolean);
    // Only stored replies of a chat about exactly one course can be saved; replies that failed are not offered.
    const savable = active && active.courseIds.length === 1 && index < active.messages.length && message.status !== 'error' && message.content.trim();
    const state = active ? saved[`${active.id}:${index}`] : undefined;
    if (!parts.length && !savable) return null;
    return <small className="msg-note left">{parts.join(' · ')}{savable && <>{parts.length > 0 && ' · '}<button type="button" className="link-button" disabled={state === 'saving' || state === 'saved'} onClick={() => void saveNote(active, index, message.content)}>
      {state === 'saved' ? (zh ? '已存到复习' : 'Saved to revision') : state === 'saving' ? (zh ? '保存中…' : 'Saving…') : state === 'failed' ? (zh ? '保存失败，重试' : 'Save failed, retry') : (zh ? '存到复习' : 'Save to revision')}</button></>}</small>;
  };

  return <div className="agent-page card">
    <nav className="chat-list" aria-label={zh ? '对话' : 'Chats'}>
      <button className="new-chat" onClick={() => startDraft()} disabled={busy}>{zh ? '新对话' : 'New chat'}</button>
      {listError && <p className="muted">{zh ? '无法读取对话。' : 'Could not load chats.'}</p>}
      {chats?.length === 0 && !listError && <p className="muted">{zh ? '还没有对话。' : 'No chats yet.'}</p>}
      {chats?.map(chat => <div key={chat.id} className="chat-row">
        <button className="chat-entry" aria-current={active?.id === chat.id ? 'true' : undefined} disabled={busy && active?.id !== chat.id} onClick={() => void open(chat.id)}>
          <span>{chat.title || (zh ? '新对话' : 'New chat')}</span>
          <small className="muted">{new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(chat.updatedAt))}{chat.running ? (zh ? ' · 回复中' : ' · replying') : ''}</small>
        </button>
        <button className="chat-delete ghost small" aria-label={zh ? `删除对话 ${chat.title}` : `Delete chat ${chat.title}`} title={zh ? '删除' : 'Delete'} disabled={busy && active?.id === chat.id} onClick={() => void remove(chat)}>×</button>
      </div>)}
    </nav>
    <section className="conversation" aria-label={zh ? '对话内容' : 'Conversation'}>
      <div className="conversation-head"><b>{active?.title || (zh ? '新对话' : 'New chat')}</b><span className="muted">{zh ? '范围：' : 'Scope: '}{scopeText}</span></div>
      <div className="chat-messages" ref={messagesRef} aria-live="polite">
        {!messages.length && !busy && <div className="chat-empty">
          <p className="muted">{zh ? '问问你的课程：成绩、权重、本周计划、复习。' : 'Ask about your courses: grades, weights, this week, revision.'}</p>
          <div className="suggestions">{suggestions.map(text => <button key={text} onClick={() => void send(text)} disabled={remoteRunning}>{text}</button>)}</div>
        </div>}
        {messages.map((message, index) => message.role === 'user'
          ? <div key={index} className={`msg me${index >= entered.current ? ' enter' : ''}`}>{message.content}</div>
          : <Fragment key={index}><div className={`msg ag${index >= entered.current ? ' enter' : ''}`}><RichText text={message.content} /></div>{note(message, index)}</Fragment>)}
        {busy && <div className={`msg ag enter${streaming ? ' streaming' : ''}`}>{streaming ? <RichText text={streaming} /> : <span className="muted">{zh ? '思考中…' : 'Thinking…'}</span>}</div>}
        {remoteRunning && !busy && <div className="msg ag"><span className="muted">{zh ? '正在回复…' : 'Replying…'}</span></div>}
      </div>
      {failure && <p className="chat-error error-line" role="status"><i className="signal" aria-hidden="true" />{failure.message}
        {failure.code.startsWith('ANALYSIS_') && <button className="ghost small" onClick={onOpenSettings}>{zh ? '去设置分析模型' : 'Set up the analysis model'}</button>}</p>}
      <form className="chat-form" onSubmit={event => { event.preventDefault(); void send(input); }}>
        <textarea ref={composer} rows={1} value={input} maxLength={8000} onChange={event => setInput(event.target.value)} onKeyDown={onKeyDown}
          placeholder={zh ? '输入问题，Enter 发送，Shift+Enter 换行' : 'Ask something. Enter to send, Shift+Enter for a new line'} aria-label={zh ? '消息' : 'Message'} />
        {busy ? <button type="button" onClick={() => void stop()}>{zh ? '停止' : 'Stop'}</button>
          : <button type="submit" className="primary" disabled={!input.trim() || remoteRunning}>{zh ? '发送' : 'Send'}</button>}
      </form>
      <p className="chat-note muted">{zh ? '基于同步得到的课程数据，不包含你在页面上的修改；不会代写或提交作业。' : 'Uses synced course data, not your edits on this page. It will not write or submit graded work.'}</p>
    </section>
  </div>;
}
