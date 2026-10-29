// Motion helpers. Every helper honours prefers-reduced-motion: it then applies the end state at once.
import { useLayoutEffect, useState, type DependencyList, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/** Shared with style.css (--ease-out, --dur-*) so JS-driven and CSS motion feel the same. */
export const easeOut = 'cubic-bezier(.2,.8,.2,1)';
export const durations = { short: 150, medium: 250, long: 420 } as const;

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let transitionToken = 0;
/**
 * Runs a state update inside a View Transition when the browser supports it. `page` slides the main canvas only;
 * `theme` crossfades the whole window. Without support, `theme` falls back to short colour transitions in CSS.
 * Returns true when a View Transition handled the change.
 */
export function viewTransition(kind: 'page' | 'theme', update: () => void): boolean {
  const root = document.documentElement;
  if (reducedMotion()) { update(); return false; }
  if (typeof document.startViewTransition !== 'function') {
    if (kind === 'theme') {
      root.dataset.theming = '';
      window.setTimeout(() => { delete root.dataset.theming; }, 350);
    }
    update();
    return false;
  }
  const token = ++transitionToken;
  root.dataset.vt = kind;
  const transition = document.startViewTransition(() => flushSync(update));
  // A failing update rejects these promises; the error already surfaced through flushSync, so only tidy up here.
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  transition.finished.catch(() => {}).finally(() => { if (token === transitionToken) delete root.dataset.vt; });
  return true;
}

/** Animates a modal dialog out (see `dialog.closing` in style.css) before closing it. */
const pendingCloses = new WeakMap<HTMLDialogElement, () => void>();
export function closeDialog(dialog: HTMLDialogElement | null | undefined): void {
  if (!dialog?.open || pendingCloses.has(dialog)) return;
  if (reducedMotion()) { dialog.close(); return; }
  dialog.classList.add('closing');
  const stop = () => {
    window.clearTimeout(timer);
    dialog.removeEventListener('animationend', onEnd);
    dialog.classList.remove('closing');
    pendingCloses.delete(dialog);
  };
  const finish = () => { stop(); if (dialog.open) dialog.close(); };
  const onEnd = (event: AnimationEvent) => { if (event.target === dialog) finish(); };
  dialog.addEventListener('animationend', onEnd);
  // The animation is 150 ms; the timer guarantees the close if animationend never fires (hidden tab, no animation).
  const timer = window.setTimeout(finish, 200);
  pendingCloses.set(dialog, stop);
}

/** Opens a modal dialog, cancelling a close animation that is still running. */
export function openDialog(dialog: HTMLDialogElement | null | undefined): void {
  if (!dialog) return;
  pendingCloses.get(dialog)?.();
  if (!dialog.open) dialog.showModal();
}

function offsetWithin(element: HTMLElement, container: HTMLElement): { left: number; top: number } | null {
  let left = 0, top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== container) { left += node.offsetLeft; top += node.offsetTop; node = node.offsetParent as HTMLElement | null; }
  return node === container ? { left, top } : null;
}

/**
 * Moves one indicator element onto the item that matches `selector` inside `container` (which must be positioned).
 * `x` follows only the horizontal position and width (a tab underline); `both` also follows the top and height.
 * The first placement and layout-only changes snap; later selection changes slide (CSS transitions on the indicator).
 * Besides `deps`, it re-measures when the container or the current item resizes and when text or items inside the
 * container change (a language switch, a renamed course), so the indicator never stays on stale geometry.
 */
export function useSlidingIndicator(container: RefObject<HTMLElement | null>, indicator: RefObject<HTMLElement | null>, selector: string, axis: 'x' | 'both', deps: DependencyList) {
  useLayoutEffect(() => {
    const box = container.current, mark = indicator.current;
    if (!box || !mark) return;
    let observed: HTMLElement | null = null;
    let last = '';
    const resize = new ResizeObserver(() => place(false));
    const place = (animate: boolean) => {
      const target = box.querySelector<HTMLElement>(selector);
      if (target !== observed) {
        if (observed) resize.unobserve(observed);
        if (target) resize.observe(target);
        observed = target;
      }
      const offset = target && target.offsetParent ? offsetWithin(target, box) : null;
      if (!target || !offset) { mark.style.opacity = '0'; delete mark.dataset.placed; last = ''; return; }
      const geometry = `${offset.left},${offset.top},${target.offsetWidth},${target.offsetHeight}`;
      // Observers also fire when nothing moved; re-applying then would cut a running slide short.
      if (geometry === last) return;
      last = geometry;
      const snap = !animate || mark.dataset.placed === undefined || reducedMotion();
      if (snap) mark.style.transition = 'none';
      mark.style.transform = axis === 'x' ? `translateX(${offset.left}px)` : `translate(${offset.left}px, ${offset.top}px)`;
      mark.style.width = `${target.offsetWidth}px`;
      if (axis === 'both') mark.style.height = `${target.offsetHeight}px`;
      mark.style.opacity = '1';
      mark.dataset.placed = '';
      if (snap) { void mark.offsetWidth; mark.style.transition = ''; }
    };
    place(true);
    resize.observe(box);
    const mutations = new MutationObserver(() => place(false));
    mutations.observe(box, { childList: true, subtree: true, characterData: true });
    return () => { resize.disconnect(); mutations.disconnect(); };
  }, deps);
}

/**
 * Counts from 0 up to `value` over ~700 ms with an ease-out whenever `animateKey` changes. Later value changes
 * (edits) show at once. The final text is exactly `format(value)`.
 */
export function useCountUp(value: number | undefined, format: (value: number) => string, animateKey: string): string {
  const [progress, setProgress] = useState(() => reducedMotion() ? 1 : 0);
  useLayoutEffect(() => {
    if (value === undefined || reducedMotion()) { setProgress(1); return; }
    setProgress(0);
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / 700);
      setProgress(t);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [animateKey]);
  if (value === undefined) return '—';
  return progress >= 1 ? format(value) : format(value * (1 - (1 - progress) ** 3));
}
