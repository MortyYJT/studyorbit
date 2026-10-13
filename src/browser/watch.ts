import { fileURLToPath } from 'node:url';
import { ResidentBrowser, browserClock } from './resident.js';
import type { RequestClock } from '../capture/limiter.js';

/** Detached observer, not a browser launcher. It stops when its browser exits or is replaced. */
export async function watchBrowserExit(resident: Pick<ResidentBrowser, 'current'>, pid: number, clock: RequestClock = browserClock): Promise<void> {
  while (resident.current()?.pid === pid) await clock.sleep(1000);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]; const pid = Number(process.argv[3]);
  if (directory && Number.isSafeInteger(pid) && pid > 0) {
    // The observer never emits paths, endpoints, page content or process errors.
    await watchBrowserExit(new ResidentBrowser({ directory }), pid).catch(() => {});
  }
}
