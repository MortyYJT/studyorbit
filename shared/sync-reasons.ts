// Owner-facing reasons of a failed or incomplete collection (sync-incomplete change, decisions #480-#489). The sync
// turns a collector's exit code and stderr into one short Chinese reason, stored in the source's `unavailable`
// placeholder and in the course row; the page shows it as is in Chinese and translates the known phrases to English.
// Nothing here reads files; collectors' stderr is sanitised before it is kept (no paths, URL queries, cookies or
// tokens), and every reason is capped.

export const REASON_LIMIT = 300;
export const DETAIL_LIMIT = 160;

/** Display names of the browser bridges, by settings id. */
const BROWSERS: Record<string, [string, string]> = {
  'edge-applescript': ['Edge', 'Edge'],
  'chrome-applescript': ['Chrome', 'Chrome'],
  'cdp-chrome': ['专用浏览器', 'the dedicated browser'],
  'cdp-edge': ['专用浏览器', 'the dedicated browser'],
};
export const browserName = (id: string | null | undefined): string => (id && Object.hasOwn(BROWSERS, id) ? BROWSERS[id]![0] : '浏览器');

/**
 * Reason templates, Chinese and English, with `{b}` (browser), `{s}` (source label) and `{d}` (detail). The Chinese
 * text is what the sync stores; `translateReason` maps it to English for the page.
 */
export const REASON_TEMPLATES = Object.freeze({
  windowMissing: ['{b} 没有打开窗口，请打开一个 {b} 窗口后重试', '{b} has no open window. Open a {b} window and try again'],
  browserNotRunning: ['{b} 没有打开，请打开 {b} 并登录 Canvas 后重试', '{b} is not open. Open {b}, sign in to Canvas and try again'],
  appleEvents: ['{b} 不允许来自 Apple 事件的 JavaScript，请在 {b} 的开发者菜单里允许后重试', '{b} does not allow JavaScript from Apple Events. Allow it in the {b} Developer menu and try again'],
  canvasSignedOut: ['Canvas 登录已失效，请在 {b} 里重新登录 Canvas', 'Canvas sign-in has expired. Sign in to Canvas again in {b}'],
  timeout: ['{s} 采集超时，请检查网络和浏览器后重试', '{s} collection timed out. Check the network and the browser, then try again'],
  edSignedOut: ['Ed 未登录，请在终端运行 edstem auth login 后重试', 'Ed is not signed in. Run edstem auth login in a terminal and try again'],
  edCliMissing: ['找不到 edstem 命令，请先安装 edstem-cli', 'The edstem command was not found. Install edstem-cli first'],
  preflightWarning: ['{s} 检查未通过（{d}），{s} 数据可能缺失，同步照常进行', '{s} check failed ({d}); {s} data may be missing, the sync continues'],
  failedWithDetail: ['{s} 采集失败：{d}', '{s} collection failed: {d}'],
  failedWithCode: ['{s} 采集失败（退出码 {d}）', '{s} collection failed (exit code {d})'],
  partlyCollected: ['部分 {s} 数据未能读取', 'Some {s} data could not be read'],
  notCollected: ['{s} 数据未能读取', '{s} data could not be read'],
  unpaginated: ['{s} 分页未验证', '{s} pagination was not verified'],
  unparsable: ['{s} 考核表未能解析', 'The {s} assessment table could not be parsed'],
  unsourced: ['{d} 项权重或规则无出处', '{d} weights or rules have no source'],
  incomplete: ['本次同步不完整，仍显示上次的结果', 'This sync was incomplete; the previous result is still shown'],
  unreferenced: ['{d} 项考核没有来源引用', '{d} assessments have no source reference'],
} satisfies Record<string, readonly [string, string]>);
export type ReasonKey = keyof typeof REASON_TEMPLATES;

const fill = (template: string, values: { b?: string; s?: string; d?: string }) =>
  template.replace(/\{([bsd])\}/g, (_, key: 'b' | 's' | 'd') => values[key] ?? '');

/** The Chinese reason of `key` with its values. */
export function reasonText(key: ReasonKey, values: { b?: string; s?: string; d?: string } = {}): string {
  return fill(REASON_TEMPLATES[key][0], values);
}

const FILE_URL = /\bfile:\/\/[^\s'"`<>()（）]*/gi;
const QUOTED_PATH = /(['"`])(?:~|[A-Za-z]:)?[\\/][^'"`\n]*\1/g;
/** The rest of a path with spaces after its first segment was replaced, e.g. `<path> Smith/proj/x.json`. */
const PATH_TAIL = /<path>(?:(?:\s+[^\s\\/]+){0,3}\s+(?!\S*:\/\/)[^\s\\/]*[\\/]\S*)+/g;
const PATH = /(?<![\w.:/~-])(?:~|[A-Za-z]:)?[\\/](?:[^\s\\/'"`,;:()（）]+[\\/])+[^\s'"`,;:()（）]*/g;
const URL_TEXT = /\bhttps?:\/\/[^\s'"`<>()（）]+/gi;
const SECRET = /\b(cookie|set-cookie|token|access[_-]?token|authorization|bearer|session(?:id)?|secret|password|api[_-]?key)\b\s*[:=]?\s*("[^"]*"|'[^']*'|\S+)/gi;
const LONG_TOKEN = /[A-Za-z0-9+_=-]{32,}/g;

/** An uncaught Node error prints the throwing source line and a stack: keep only its message; drop stack lines. */
function withoutStack(text: string): string {
  const thrown = /^(?:[A-Z]\w*)?Error(?: \[[^\]]*\])?: (.+)$/m.exec(text);
  const value = thrown && /^\s+at /m.test(text) ? thrown[1]! : text;
  return value.split('\n').filter(line => !/^\s+at /.test(line)).join('\n');
}

/**
 * A collector's stderr made safe to keep: URLs reduced to origin and path (no query or fragment), absolute paths,
 * cookie/token-like values and long opaque strings replaced, whitespace collapsed, capped at `limit` characters.
 */
export function sanitiseDetail(text: unknown, limit = DETAIL_LIMIT): string {
  let value = withoutStack(String(text ?? ''));
  value = value.replace(URL_TEXT, url => {
    try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`; } catch { return '<url>'; }
  });
  value = value.replace(SECRET, (_, name: string) => `${name}=<hidden>`);
  value = value.replace(FILE_URL, '<path>');
  value = value.replace(QUOTED_PATH, (_, quote: string) => `${quote}<path>${quote}`);
  value = value.replace(PATH, '<path>');
  value = value.replace(PATH_TAIL, '<path>');
  value = value.replace(LONG_TOKEN, '<hidden>');
  value = value.replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** The hint every AppleScript collector appends to its error; removed before matching (it names Apple Events). */
const APPLE_EVENTS_HINT = /如提示 JavaScript from Apple Events，[^。]*。/g;
/** The prefix a collector puts before its own message, removed from the detail. */
const COLLECTOR_PREFIX = /^[^\n：:]{1,40}(?:后台采集失败|采集不可用|采集失败)[：:]\s*/;

export type CollectorFailure = {
  /** Source id and label ('canvas', 'Canvas'). */
  source: string; label: string;
  /** Settings id of the browser bridge, e.g. 'edge-applescript'. */
  browser?: string | null;
  /** Exit code, null when the process could not start or was killed. */
  code: number | null;
  /** The collector's stderr (at most a few KB). */
  error?: string;
  /** True when the sync stopped the collector after its time limit. */
  timedOut?: boolean;
};

/**
 * One short Chinese reason for a failed collection: a missing browser window, a browser that is not running, Apple
 * Events JavaScript turned off, Canvas signed out (HTTP 401/403 or a sign-in redirect), Ed signed out or its CLI
 * missing, a timeout, or a generic text with the sanitised detail.
 */
export function collectorFailureReason({ source, label, browser, code, error, timedOut }: CollectorFailure): string {
  const raw = String(error ?? '').replace(APPLE_EVENTS_HINT, ' ');
  const b = /EDGE_WINDOW_MISSING|Microsoft Edge/.test(raw) ? 'Edge' : /CHROME_WINDOW_MISSING|Google Chrome/.test(raw) ? 'Chrome' : browserName(browser);
  if (/\b(?:EDGE|CHROME|BROWSER)_WINDOW_MISSING\b/.test(raw)) return reasonText('windowMissing', { b });
  if (/请先打开 (?:Microsoft Edge|Google Chrome) 并登录/.test(raw)) return reasonText('browserNotRunning', { b });
  if (/JavaScript (?:through|from) (?:AppleScript|Apple Events)|Allow JavaScript from Apple Events/i.test(raw)) return reasonText('appleEvents', { b });
  if (source === 'canvas' && /Canvas HTTP 40[13]\b|Canvas 登录可能已失效/.test(raw)) return reasonText('canvasSignedOut', { b });
  if (/\bED_SIGNED_OUT\b|not (?:logged|signed) in|unauthori[sz]ed|HTTP 401\b/i.test(raw) && source === 'ed') return reasonText('edSignedOut');
  if (source === 'ed' && /\bED_CLI_MISSING\b|ENOENT/.test(raw)) return reasonText('edCliMissing');
  if (timedOut || /页面加载超时|timed? ?out|ETIMEDOUT/i.test(raw)) return reasonText('timeout', { s: label });
  const detail = sanitiseDetail(withoutStack(raw).split('\n').map(line => line.replace(COLLECTOR_PREFIX, '').replace(/。\s*$/, '')).filter(Boolean).join('；'));
  if (detail) return reasonText('failedWithDetail', { s: label, d: detail });
  return reasonText('failedWithCode', { s: label, d: code === null ? '无' : String(code) });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiled = Object.values(REASON_TEMPLATES).map(([zh, en]) => {
  const keys: string[] = [];
  const source = escape(zh).replace(/\\\{([bsd])\\\}/g, (_, key: string) => {
    if (keys.includes(key)) return `\\k<${key}>`;
    keys.push(key);
    if (key !== 'd') return `(?<${key}>[^\\s，；。（）]+)`;
    return zh.startsWith('{d}') ? '(?<d>\\d+)' : '(?<d>[^（）；]+)';
  });
  return { pattern: new RegExp(source, 'g'), en };
});
const BROWSER_EN = new Map(Object.values(BROWSERS).map(([zh, en]) => [zh, en] as const));

/** The reason with every known Chinese phrase replaced by its English text (unknown text is kept). */
export function translateReason(reason: string, language: 'zh' | 'en'): string {
  if (language === 'zh' || !reason) return reason;
  let out = reason;
  for (const { pattern, en } of compiled) {
    out = out.replace(pattern, (...args) => {
      const groups = (args.at(-1) ?? {}) as Record<string, string | undefined>;
      return fill(en, { b: groups.b === undefined ? undefined : BROWSER_EN.get(groups.b) ?? groups.b, s: groups.s, d: groups.d });
    });
  }
  return out.replace(/；/g, '; ').replace(/：/g, ': ').replace(/（/g, ' (').replace(/）/g, ')').replace(/。/g, '.').replace(/，/g, ', ').replace(/\s+/g, ' ').trim();
}
