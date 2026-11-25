// Agent page (decision #548): DeepTutor's own interface in a frame. StudyOrbit renders no chat here; it saves the
// page's course context for the MCP server, asks the local server whether DeepTutor is up, and for a preset prompt
// starts one DeepTutor session after the owner's click. When DeepTutor is missing or stopped, the page says what to
// run. The frame exists only while this page is showing: DeepTutor's chat page calls the model when it opens.
// Before the frame is created, DeepTutor is told the page's language, which a browser new to DeepTutor then starts in.
import { useEffect, useState } from 'react';
import { agentRequestClaimed, claimAgentRequest, type AgentRequest } from './agent-request.js';
import { agentContextBody, describeStatus, frameUrl, statusPollMs, type AssistantStatus } from './agent-frame.js';
import type { Language } from './i18n.js';
import { readAvailability, readTargets, readWork, type SidebarCourse } from './LocalPlanning.js';
import { useReveal } from './motion.js';

function selectedCourseIds(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem('studyorbit.selected-course-ids') ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; }
  catch { return []; }
}

const json = { 'Content-Type': 'application/json' };

export function AgentFrame({ language, courses, request, onOpenSettings }:
  { language: Language; courses: SidebarCourse[]; request?: AgentRequest; onOpenSettings: () => void }) {
  const zh = language === 'zh';
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  // The session a preset started, per request; `failed` when DeepTutor did not take the prompt.
  const [turn, setTurn] = useState<{ nonce: number; sessionId?: string; failed?: boolean }>();
  const [contextSaved, setContextSaved] = useState(true);
  // The language DeepTutor was last told about; the frame waits for it, whether or not DeepTutor took it.
  const [languageTold, setLanguageTold] = useState<Language>();
  const [copied, setCopied] = useState<'done' | 'failed'>();
  const up = status?.state === 'running' || status?.state === 'external';

  // Status: asked on arrival and then on a timer while the page shows; never calls the model.
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      let next: AssistantStatus;
      try {
        const response = await fetch('/api/local/deeptutor/status', { cache: 'no-store' });
        next = response.ok ? await response.json() as AssistantStatus : { state: 'failed', reason: `status ${response.status}` };
      } catch { next = { state: 'failed', reason: zh ? '本地服务没有响应' : 'the local server did not answer' }; }
      if (!live) return;
      setStatus(next);
      timer = setTimeout(ask, statusPollMs(next));
    };
    void ask();
    return () => { live = false; clearTimeout(timer); };
  }, [zh]);

  // Course context for the MCP server: on arrival and for every request from another page.
  const courseIds = courses.length ? courses.map(course => course.id) : selectedCourseIds();
  const courseKey = courseIds.join(',');
  useEffect(() => {
    const body = agentContextBody({ courseIds, focusCourseId: request?.courseId, work: readWork(), availability: readAvailability(), targets: readTargets() });
    let live = true;
    fetch('/api/local/agent-context', { method: 'PUT', headers: json, body: JSON.stringify(body) })
      .then(response => { if (live) setContextSaved(response.ok); }, () => { if (live) setContextSaved(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseKey, request?.nonce]);

  // DeepTutor's interface and reply language follow the page's. It keeps its own setting per browser once it has
  // been opened there, so this decides the first visit; afterwards the language is changed in DeepTutor's settings.
  useEffect(() => {
    if (!up || languageTold === language) return;
    let live = true;
    const done = () => { if (live) setLanguageTold(language); };
    fetch('/api/local/deeptutor/language', { method: 'PUT', headers: json, body: JSON.stringify({ language }) }).then(done, done);
    return () => { live = false; };
  }, [up, language, languageTold]);

  // A preset prompt: one session, started once per request, only when DeepTutor is up.
  useEffect(() => {
    if (!up || !request?.prompt || !claimAgentRequest(request.nonce)) return;
    const nonce = request.nonce;
    setTurn({ nonce });
    fetch('/api/local/deeptutor/turns', { method: 'POST', headers: json, body: JSON.stringify({ content: request.prompt, language }) })
      .then(async response => { const data = response.ok ? await response.json() as { sessionId?: string } : {}; setTurn({ nonce, ...(data.sessionId ? { sessionId: data.sessionId } : { failed: true }) }); })
      .catch(() => setTurn({ nonce, failed: true }));
  }, [up, request, language]);

  const notice = describeStatus(status, language);
  // Waiting: the prompt is about to be handed over (not claimed yet) or its session id has not come back. A request
  // that was claimed before this mount (the page was left and opened again) is not waited for and not sent again.
  const mine = turn?.nonce === request?.nonce;
  const waitingForTurn = !!request?.prompt && up && (mine ? !turn!.sessionId && !turn!.failed : !agentRequestClaimed(request.nonce));
  const waitingForLanguage = up && languageTold === undefined;
  const reveal = useReveal(!(notice?.busy || waitingForTurn || waitingForLanguage));
  const session = turn && request && turn.nonce === request.nonce ? turn.sessionId : undefined;
  const src = up && !waitingForTurn && !waitingForLanguage ? frameUrl(status.url, window.location.hostname, session) : null;
  // The clipboard is missing on a page that is not a secure context and can refuse; then the page says to select the lines.
  const copyCommand = (text: string) => {
    const write = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
    write.then(() => { setCopied('done'); window.setTimeout(() => setCopied(current => current === 'done' ? undefined : current), 2000); }, () => setCopied('failed'));
  };
  const focus = request?.courseId ? courses.find(course => course.id === request.courseId)?.code : undefined;

  return <section className="panel agent-frame-page" data-agent-state={status?.state ?? 'unknown'}>
    <div className="agent-frame-bar">
      <span className="agent-frame-note">
        {focus ? (zh ? `从 ${focus} 打开` : `Opened from ${focus}`) : 'DeepTutor'}
        {up && <> · {zh ? '助手读 StudyOrbit 里的课程、成绩、截止和任务，读不到课程页上的修正' : 'It reads the courses, marks, deadlines and tasks in StudyOrbit, not the corrections made on a course page'}</>}
        {!contextSaved && <> · {zh ? '课程上下文没有存下来，助手这次读不到你的任务' : 'The course context could not be saved; the assistant cannot read your tasks this time'}</>}
        {turn?.failed && turn.nonce === request?.nonce && <> · {zh ? '这条提示没能发出去，可以在下面直接输入' : 'The prompt could not be sent; type it below instead'}</>}
        {up && status.warning === 'solve-module' && <> · {zh ? '检测到 DeepTutor 的 solve 模块（会代做题）。卸载：uv pip uninstall deeptutor-solve' : 'DeepTutor\'s solve module is installed (it does the work for you). Remove it: uv pip uninstall deeptutor-solve'}</>}
        {up && status.warning === 'version' && <> · {zh ? 'DeepTutor 的版本和这里验证过的 1.7.4 不同' : 'This DeepTutor is not the 1.7.4 release this page was tried with'}</>}
      </span>
      {src && <a className="agent-frame-link" href={src} target="_blank" rel="noreferrer">{zh ? '在新标签页打开' : 'Open in a new tab'}</a>}
    </div>
    {src
      ? <iframe className="agent-frame" title="DeepTutor" src={src} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" allow="clipboard-write" referrerPolicy="no-referrer" />
      : notice && !notice.busy
        ? <div className="empty agent-frame-notice" role="status">
          <h2>{notice.title}</h2>
          <p>{notice.body}</p>
          {notice.detail && <p className="agent-frame-detail">{notice.detail}</p>}
          {notice.command && <pre className="agent-frame-command">{notice.command}</pre>}
          {notice.command && notice.command.includes('\n') && <button className="small" onClick={() => copyCommand(notice.command!)}>{copied === 'done' ? (zh ? '已复制' : 'Copied') : (zh ? '复制这几行' : 'Copy these lines')}</button>}
          {copied === 'failed' && <p className="agent-frame-detail" role="alert">{zh ? '没能复制，请手动选中上面几行再复制。' : 'Could not copy. Select the lines above and copy them by hand.'}</p>}
          {notice.settings && <button onClick={onOpenSettings}>{zh ? '打开设置' : 'Open settings'}</button>}
        </div>
        // Nothing is painted for the first 150 ms: a status that arrives at once replaces this without a flash.
        : <div className={`agent-frame-wait page-placeholder pending${reveal === 'placeholder' ? ' late' : ''}`} role="status" aria-busy="true">
          <span className="skeleton" /><span className="skeleton" /><span className="skeleton" />
          {reveal === 'placeholder' && <p className="agent-frame-starting">{waitingForTurn ? (zh ? '正在把提示交给 DeepTutor…' : 'Handing the prompt to DeepTutor…') : <>{notice?.title} {notice?.body}</>}</p>}
        </div>}
  </section>;
}
