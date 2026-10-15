import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { isOwnerCommand } from '../protocol/registry.js';

export interface ToolPolicyOptions {
  dataDirectory: string;
  workspace: string;
  frontendOrigin?: string;
  debuggingPort?: number;
}
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch { const parent = dirname(path); return parent === path ? path : resolve(canonical(parent), basename(path)); }
}
function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
/** Best effort against visible arguments; this is not a shell sandbox. */
export function deniedToolReason(input: unknown, cwd: string, options: ToolPolicyOptions): string | undefined {
  const data = canonical(resolve(options.dataDirectory)); const workspace = canonical(resolve(options.workspace));
  const deniedPath = (value: string) => {
    if (basename(value) === 'browser.json') return true;
    const path = resolve(cwd, value); const actual = canonical(path);
    return inside(path, resolve(options.dataDirectory)) && !inside(path, resolve(options.workspace))
      || inside(actual, data) && !inside(actual, workspace);
  };
  const walk = (value: unknown, key = ''): boolean => {
    if (Array.isArray(value)) return value.some(item => walk(item, key));
    if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => walk(v, k));
    if (typeof value !== 'string') return false;
    // File bodies and replacement text are inert; retain checks on paths, patterns and commands.
    if (['content', 'old_string', 'new_string'].includes(key)) return false;
    if (/path|file|directory|cwd/i.test(key) && deniedPath(value)) return true;
    const tokens = value.match(/"[^"]*"|'[^']*'|[^\s;|&<>]+/g) ?? [];
    for (const raw of tokens) {
      const token = raw.replace(/^["']|["']$/g, '').replace(/^--?[^=]+=/, '')
        .replace(/\$(?:\{PWD\}|PWD\b)/g, cwd);
      if ((key === 'command' || isAbsolute(token) || token === '..' || token.startsWith('./') || token.startsWith('../') || token.includes('browser.json')) && deniedPath(token)) return true;
    }
    for (const match of value.matchAll(/(?:https?|wss?):\/\/[^\s"'<>]+/gi)) {
      try {
        const url = new URL(match[0]);
        const local = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(url.hostname.toLowerCase());
        const frontend = options.frontendOrigin ? new URL(options.frontendOrigin) : undefined;
        if (frontend && url.origin === frontend.origin
          || local && (Number(url.port) === options.debuggingPort || frontend && url.port === frontend.port)) return true;
      } catch { /* Non-URL strings cannot connect on their own. */ }
    }
    if (key === 'command') {
      const commandText = value.replace(/["']/g, '');
      if (/(?:^|[\s/;|&()])(?:ps|pgrep|script|expect|unbuffer|socat)(?=$|[\s;|&()])|pty\s*[.(]|openpty|forkpty|\bpython(?:\d(?:\.\d+)?)?\s+-m\s+pty\b/.test(commandText)) return true;
      if (/\bcoursework\b|(?:^|[\s/])cli\.[cm]?[jt]s\b/.test(value)) {
        const words = commandText.split(/[\s;|&()]+/);
        for (let i = 0; i < words.length; i++) {
          if (/(?:^|\/)(?:coursework|cli\.[cm]?[jt]s)$/.test(words[i])) {
            const command = words.slice(i + 1).filter(word => !word.startsWith('-'));
            if (['ui', 'http', 'mcp', 'login', 'sync'].includes(command[0])
              || isOwnerCommand(command[0]) || isOwnerCommand(command.slice(0, 2).join('.'))
              || isOwnerCommand(command.slice(0, 3).join('.'))) return true;
          }
        }
      }
      // Also catch host:port spellings without a URL scheme (curl, nc, browser clients).
      const ports = [options.debuggingPort, options.frontendOrigin ? Number(new URL(options.frontendOrigin).port) : undefined].filter(Boolean);
      if (ports.some(port => new RegExp(`(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[?::1\\]?)[\\s:]+${port}\\b`).test(value))) return true;
    }
    return false;
  };
  return walk(input) ? 'Tool call denied by coursework policy.' : undefined;
}
