import type { Page } from 'playwright';
import type { RequestClock } from '../capture/limiter.js';
import { CourseworkError } from '../protocol/errors.js';
import { browserClock } from './resident.js';

export interface HighlightTarget {
  isVisible(): Promise<boolean>;
  evaluate(callback: (element: HTMLElement | SVGElement) => void): Promise<void>;
  click(): Promise<void>;
}
/** One visible action per call; callers remain responsible for their assessment grant and audit. */
export async function highlightThenClick(
  page: Pick<Page, 'bringToFront'>, target: HighlightTarget,
  clock: RequestClock = browserClock,
): Promise<void> {
  try {
    const visible = async () => {
      if (!await target.isVisible()) throw new CourseworkError('INVALID_INPUT', 'Browser action requires a visible target.');
    };
    await visible();
    await page.bringToFront();
    await target.evaluate(element => { (element as HTMLElement).style.outline = '2px solid red'; });
    const deadline = clock.now() + 1000;
    while (clock.now() < deadline) await clock.sleep(deadline - clock.now());
    await visible();
    await target.click();
  } catch (error) {
    if (error instanceof CourseworkError && error.code === 'INVALID_INPUT') throw error;
    // Playwright call logs may include the selector or page content.
    throw new CourseworkError('SOURCE_UNAVAILABLE', 'Visible browser action unavailable.');
  }
}
