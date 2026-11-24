import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDialog, drawArc, durations, easeOut, nextReveal, openDialog, pageFade, pageFadeFrom, placeholderDelay, reducedMotion, themeTransition, type Reveal } from '../web/src/motion.js';

// The helpers touch a handful of browser globals; each test installs the stand-ins it needs.
function motionPreference(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('prefers-reduced-motion: reduce') }));
}
function fakeRoot() {
  const root = { dataset: {} as Record<string, string> };
  vi.stubGlobal('window', globalThis);
  return root;
}
/** A canvas-like element whose animations are recorded. */
function fakeElement() {
  const animations: { keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean; cancel: () => void }[] = [];
  return {
    animations,
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = { keyframes, options, cancelled: false, cancel() { animation.cancelled = true; } };
      animations.push(animation);
      return animation;
    },
  };
}
function fakeDialog() {
  const classes = new Set<string>();
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const dialog = {
    open: true, closes: 0, shows: 0, classes,
    classList: { add: (name: string) => { classes.add(name); }, remove: (name: string) => { classes.delete(name); } },
    addEventListener: (type: string, listener: (event: unknown) => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener: (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener); },
    fire: (type: string, target: unknown) => { for (const listener of [...(listeners.get(type) ?? [])]) listener({ target }); },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    close() { dialog.open = false; dialog.closes += 1; },
    showModal() { dialog.open = true; dialog.shows += 1; },
  };
  return dialog;
}
type Dialog = Parameters<typeof closeDialog>[0];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('reducedMotion', () => {
  it('reads the media query, and is false where there is none', () => {
    motionPreference(true);
    expect(reducedMotion()).toBe(true);
    motionPreference(false);
    expect(reducedMotion()).toBe(false);
    vi.stubGlobal('matchMedia', undefined);
    expect(reducedMotion()).toBe(false);
  });
});

describe('pageFade', () => {
  it('fades the arriving page in from a visible start, by opacity only', () => {
    motionPreference(false);
    const element = fakeElement();
    const animation = pageFade(element as unknown as HTMLElement);
    expect(animation).toBe(element.animations[0]);
    expect(element.animations[0]!.keyframes).toEqual([{ opacity: pageFadeFrom }, { opacity: 1 }]);
    expect(element.animations[0]!.options).toEqual({ duration: durations.short, easing: easeOut });
    // The first frame already shows the page, so the switch is never blank.
    expect(pageFadeFrom).toBeGreaterThan(0);
    expect(pageFadeFrom).toBeLessThan(1);
    expect(Object.keys(element.animations[0]!.keyframes[0]!)).toEqual(['opacity']);
  });

  it('is interrupted by the next switch: the running fade is cancelled before a new one starts', () => {
    motionPreference(false);
    const element = fakeElement();
    pageFade(element as unknown as HTMLElement);
    pageFade(element as unknown as HTMLElement);
    pageFade(element as unknown as HTMLElement);
    expect(element.animations.map(animation => animation.cancelled)).toEqual([true, true, false]);
  });

  it('does nothing under reduced motion, and stops a fade that was running when the preference changed', () => {
    motionPreference(false);
    const element = fakeElement();
    pageFade(element as unknown as HTMLElement);
    motionPreference(true);
    expect(pageFade(element as unknown as HTMLElement)).toBeNull();
    expect(element.animations).toHaveLength(1);
    expect(element.animations[0]!.cancelled).toBe(true);
  });

  it('does nothing without an element or without the Web Animations API', () => {
    motionPreference(false);
    expect(pageFade(null)).toBeNull();
    expect(pageFade({} as HTMLElement)).toBeNull();
  });
});

describe('drawArc', () => {
  it('draws the earned arc in from empty to its own length, once', () => {
    motionPreference(false);
    const arc = fakeElement();
    expect(drawArc(arc as unknown as SVGElement, 440, 290)).toBe(arc.animations[0]);
    expect(arc.animations[0]!.keyframes).toEqual([{ strokeDashoffset: 440 }, { strokeDashoffset: 290 }]);
    expect(arc.animations[0]!.options).toEqual({ duration: durations.arc, easing: easeOut });
  });

  it('leaves the arc at its length under reduced motion, and without an element or the Web Animations API', () => {
    motionPreference(true);
    const arc = fakeElement();
    expect(drawArc(arc as unknown as SVGElement, 440, 290)).toBeNull();
    expect(arc.animations).toHaveLength(0);
    motionPreference(false);
    expect(drawArc(null, 440, 290)).toBeNull();
    expect(drawArc({} as SVGElement, 440, 290)).toBeNull();
  });
});

describe('nextReveal', () => {
  it('shows data that arrives inside the delay at once, with no placeholder and no fade', () => {
    expect(nextReveal('waiting', 'ready')).toBe('shown');
  });

  it('paints the placeholder once the delay has passed, and fades in only what replaces a painted placeholder', () => {
    expect(nextReveal('waiting', 'delay')).toBe('placeholder');
    expect(nextReveal('placeholder', 'ready')).toBe('faded');
  });

  it('ignores a late timer and a repeated arrival', () => {
    for (const state of ['shown', 'faded', 'placeholder'] as Reveal[]) expect(nextReveal(state, 'delay')).toBe(state);
    expect(nextReveal('shown', 'ready')).toBe('shown');
    expect(nextReveal('faded', 'ready')).toBe('faded');
  });

  it('goes back to plain content when the fade has finished, so the fade never plays a second time', () => {
    expect(nextReveal('faded', 'done')).toBe('shown');
    for (const state of ['waiting', 'placeholder', 'shown'] as Reveal[]) expect(nextReveal(state, 'done')).toBe(state);
  });

  it('starts over when the data goes away', () => {
    for (const state of ['waiting', 'placeholder', 'shown', 'faded'] as Reveal[]) expect(nextReveal(state, 'reset')).toBe('waiting');
  });

  it('waits a short, fixed time before any placeholder', () => {
    expect(placeholderDelay).toBeGreaterThanOrEqual(100);
    expect(placeholderDelay).toBeLessThanOrEqual(200);
  });
});

describe('themeTransition (theme and background change)', () => {
  it('applies the change at once under reduced motion and marks nothing', () => {
    motionPreference(true);
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });
    let applied = 0;
    themeTransition(() => { applied += 1; });
    expect(applied).toBe(1);
    expect(root.dataset).toEqual({});
  });

  it('marks the window while the colours fade, applies the change in the same call, and clears the mark after', () => {
    motionPreference(false);
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });
    let applied = 0;
    themeTransition(() => { expect('theming' in root.dataset).toBe(true); applied += 1; });
    expect(applied).toBe(1);
    vi.advanceTimersByTime(durations.medium - 1);
    expect('theming' in root.dataset).toBe(true);
    vi.advanceTimersByTime(200);
    expect('theming' in root.dataset).toBe(false);
  });

  it('is interrupted by the next pick: the mark stays until the last fade has had its time', () => {
    motionPreference(false);
    const root = fakeRoot();
    vi.stubGlobal('document', { documentElement: root });
    themeTransition(() => {});
    vi.advanceTimersByTime(durations.medium - 50);
    themeTransition(() => {});
    vi.advanceTimersByTime(durations.medium - 50);
    expect('theming' in root.dataset).toBe(true);
    vi.advanceTimersByTime(200);
    expect('theming' in root.dataset).toBe(false);
  });

  it('never starts a View Transition, which would take every click while it runs', () => {
    motionPreference(false);
    const root = fakeRoot();
    const startViewTransition = vi.fn();
    vi.stubGlobal('document', { documentElement: root, startViewTransition });
    themeTransition(() => {});
    expect(startViewTransition).not.toHaveBeenCalled();
  });
});

describe('closeDialog and openDialog', () => {
  it('closes at once under reduced motion', () => {
    motionPreference(true);
    vi.stubGlobal('window', globalThis);
    const dialog = fakeDialog();
    closeDialog(dialog as unknown as Dialog);
    expect(dialog.open).toBe(false);
    expect(dialog.classes.has('closing')).toBe(false);
  });

  it('plays the exit and closes when it ends', () => {
    motionPreference(false);
    vi.stubGlobal('window', globalThis);
    const dialog = fakeDialog();
    closeDialog(dialog as unknown as Dialog);
    expect(dialog.open).toBe(true);
    expect(dialog.classes.has('closing')).toBe(true);
    // An animation ending inside the dialog is not the dialog's own.
    dialog.fire('animationend', {});
    expect(dialog.open).toBe(true);
    dialog.fire('animationend', dialog);
    expect(dialog.open).toBe(false);
    expect(dialog.classes.has('closing')).toBe(false);
    expect(dialog.listenerCount('animationend')).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(dialog.closes).toBe(1);
  });

  it('closes on a timer when the exit animation never reports its end', () => {
    motionPreference(false);
    vi.stubGlobal('window', globalThis);
    const dialog = fakeDialog();
    closeDialog(dialog as unknown as Dialog);
    vi.advanceTimersByTime(durations.short + 60);
    expect(dialog.open).toBe(false);
    expect(dialog.closes).toBe(1);
  });

  it('ignores a second close while the first is running, and a dialog that is not open', () => {
    motionPreference(false);
    vi.stubGlobal('window', globalThis);
    const dialog = fakeDialog();
    closeDialog(dialog as unknown as Dialog);
    closeDialog(dialog as unknown as Dialog);
    expect(dialog.listenerCount('animationend')).toBe(1);
    const closed = fakeDialog(); closed.open = false;
    closeDialog(closed as unknown as Dialog);
    expect(closed.classes.has('closing')).toBe(false);
    closeDialog(null);
  });

  it('reopening during the exit cancels it instead of closing later', () => {
    motionPreference(false);
    vi.stubGlobal('window', globalThis);
    const dialog = fakeDialog();
    closeDialog(dialog as unknown as Dialog);
    openDialog(dialog as unknown as Dialog);
    expect(dialog.classes.has('closing')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(dialog.open).toBe(true);
    expect(dialog.closes).toBe(0);
    expect(dialog.shows).toBe(0);
    const closed = fakeDialog(); closed.open = false;
    openDialog(closed as unknown as Dialog);
    expect(closed.shows).toBe(1);
  });
});

describe('the motion rules in style.css', () => {
  const css = readFileSync(new URL('../web/src/style.css', import.meta.url), 'utf8');
  const lines = css.split('\n');

  it('share the durations and the easing with motion.ts', () => {
    for (const token of [`--ease-out:${easeOut};`, `--dur-1:${durations.short}ms;`, `--dur-2:${durations.medium}ms;`]) expect(css.includes(token), token).toBe(true);
  });

  it('switch every animation and transition off under reduced motion, in one rule', () => {
    const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion:reduce) {'));
    expect(block.includes('*,*::before,*::after,::backdrop { animation:none !important; transition:none !important; }')).toBe(true);
    // The folding rows transition a pseudo-element that the universal selector does not reach.
    expect(block.includes('::details-content { transition:none !important; }')).toBe(true);
    // One place only: a second reduced-motion block would be a list somebody forgets to extend.
    expect(css.match(/prefers-reduced-motion/g)).toHaveLength(1);
  });

  it('use no View Transition: its picture of the page takes every click while it is shown', () => {
    expect(css.includes('view-transition')).toBe(false);
    for (const file of ['App.tsx', 'LocalPlanning.tsx', 'Agent.tsx', 'motion.ts', 'BackgroundLayer.tsx']) {
      const source = readFileSync(new URL(`../web/src/${file}`, import.meta.url), 'utf8');
      expect(source.includes('startViewTransition('), file).toBe(false);
    }
  });

  it('keep entrance choreography out of the pages', () => {
    for (const gone of ['page-in', 'page-out', 'rise-in', 'grow-x']) expect(css).not.toMatch(new RegExp(`@keyframes ${gone}\\b`));
  });

  it('animate nothing but opacity and transform in keyframes', () => {
    const frames = lines.filter(line => line.trimStart().startsWith('@keyframes'));
    expect(frames.length).toBeGreaterThan(0);
    for (const line of frames) {
      const properties = [...line.slice(line.indexOf('{') + 1).matchAll(/([a-z-]+)\s*:/g)].map(match => match[1]);
      expect(properties.filter(property => property !== 'opacity' && property !== 'transform'), line).toEqual([]);
    }
  });
});
