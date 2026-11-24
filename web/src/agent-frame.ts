// Pure parts of the Agent page (decision #548): the page shows DeepTutor's own interface in a frame and hands it the
// page's course context through the local server. No DOM and no network here, so it is unit-tested.
import { buildPlanningSnapshot, type SentPlanning } from '../../shared/planning-snapshot.js';
import type { Band } from '../../shared/course-calculations.js';
import type { Language } from './i18n.js';

export type AssistantStatus =
  | { state: 'off' | 'starting' | 'not-installed' | 'unsupported-provider' }
  | { state: 'running' | 'external'; url: string; warning?: string }
  | { state: 'failed'; reason: string };

/** Shown on the Agent page when DeepTutor is missing; the same command is in docs/setup.md. */
export const INSTALL_COMMAND = [
  'uv venv --python 3.12 ~/.local/share/studyorbit/deeptutor/venv',
  'uv pip install --python ~/.local/share/studyorbit/deeptutor/venv/bin/python "deeptutor[server,web,memory,questions,notebook]==1.7.4"',
].join('\n');

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Address of DeepTutor's chat page for the frame: the assistant's port under the host name the StudyOrbit page itself
 * was opened with (so both are the same site), optionally on one session. Null unless the address the server reported
 * is plain http on a loopback name; a session id that is not a simple token is ignored.
 */
export function frameUrl(assistantUrl: string, pageHostname: string, sessionId?: string): string | null {
  let url: URL;
  try { url = new URL(assistantUrl); } catch { return null; }
  if (url.protocol !== 'http:' || !LOOPBACK.includes(url.hostname) || !url.port) return null;
  const host = LOOPBACK.includes(pageHostname) ? pageHostname : url.hostname;
  const session = sessionId && /^[A-Za-z0-9_-]{1,120}$/.test(sessionId) ? `/${sessionId}` : '';
  return `http://${host}:${url.port}/chat${session}`;
}

type Work = Parameters<typeof buildPlanningSnapshot>[0]['work'];
/** Body of `PUT /api/local/agent-context`: what the MCP server cannot read from the browser by itself. */
export function agentContextBody({ courseIds, focusCourseId, work, availability, targets }:
  { courseIds: string[]; focusCourseId?: string; work: Work; availability: number[]; targets: Record<string, Band> }): { selectedCourseIds: string[]; focusCourseId: string | null; planning: SentPlanning } {
  return {
    selectedCourseIds: courseIds,
    focusCourseId: focusCourseId && courseIds.includes(focusCourseId) ? focusCourseId : null,
    planning: buildPlanningSnapshot({ work, availability, targets, courseIds }),
  };
}

export type StatusNotice = { title: string; body: string; detail?: string; command?: string; settings?: boolean; busy?: boolean };

/** What the page says instead of the frame; null when DeepTutor can be shown. `null` status: not asked yet. */
export function describeStatus(status: AssistantStatus | null, language: Language): StatusNotice | null {
  const zh = language === 'zh';
  if (!status || status.state === 'starting') return { busy: true, title: zh ? '正在启动 DeepTutor…' : 'Starting DeepTutor…', body: zh ? '第一次启动要复制网页文件，可能要半分钟。' : 'The first start copies the web files and can take half a minute.' };
  switch (status.state) {
    case 'running': case 'external': return null;
    case 'not-installed': return {
      title: zh ? '还没有安装 DeepTutor' : 'DeepTutor is not installed',
      body: zh ? '对话、记忆和出题由 DeepTutor 提供，它装在仓库外面。在终端里运行下面两行，然后重新运行 npm run dev。其余页面不受影响。' : 'Chat, memory and practice questions come from DeepTutor, which is installed outside the repository. Run these two lines in a terminal, then run npm run dev again. The other pages work without it.',
      command: INSTALL_COMMAND,
    };
    case 'unsupported-provider': return {
      title: zh ? '助手目前只支持 DeepSeek' : 'The assistant works with DeepSeek only',
      body: zh ? '在「设置 → 分析模型」里选 DeepSeek，然后重新运行 npm run dev。' : 'Choose DeepSeek in Settings → Analysis model, then run npm run dev again.',
      settings: true,
    };
    case 'off': return {
      title: zh ? '这次启动没有带助手' : 'This run was started without the assistant',
      body: zh ? '去掉环境变量 STUDYORBIT_DEEPTUTOR=off 后重新运行 npm run dev。' : 'Remove the environment variable STUDYORBIT_DEEPTUTOR=off and run npm run dev again.',
    };
    case 'failed': return {
      title: zh ? 'DeepTutor 没有在运行' : 'DeepTutor is not running',
      body: zh ? '停止后重新运行下面的命令；出错原因也会打印在运行它的终端里。其余页面不受影响。' : 'Stop and run the command below again; the reason is also printed in the terminal it runs in. The other pages work without it.',
      detail: status.reason, command: 'npm run dev',
    };
  }
}

/** How long to wait before asking for the status again. */
export function statusPollMs(status: AssistantStatus | null): number {
  return !status || status.state === 'starting' ? 1000 : 5000;
}
