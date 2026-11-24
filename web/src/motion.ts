// Motion helpers. One small rule set, shared with the motion section of style.css:
//   - a page switch replaces the page in the click's own frame and fades it in, by opacity only, from a visible start;
//     nothing animates out, so the switch is never slowed and a second click simply restarts the fade;
//   - data that is not there yet shows a placeholder only after `placeholderDelay`, and only what replaces a painted
//     placeholder fades in; data that arrives sooner is painted as it is;
//   - one indicator slides to the current item; dialogs and the drawer fade or slide in and leave faster;
//   - the one thing that performs on arrival is the earned arc of a course's grade ring, which draws in;
//   - a theme or background change fades every colour together; there is no View Transition anywhere, because the
//     page under one takes no clicks while it runs.
// Every helper honours prefers-reduced-motion: it then applies the end state at once. Loading states still show.
import { useEffect, useLayoutEffect, useState, type DependencyList, type RefObject } from 'react';

/** Shared with style.css (--ease-out, --dur-*) so JS-driven and CSS motion feel the same. */
export const easeOut = 'cubic-bezier(.2,.8,.2,1)';
export const durations = { short: 150, medium: 250, arc: 700 } as const;

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The opacity a page starts its fade at: above zero, so the first frame after the click already shows the page. */
export const pageFadeFrom = 0.4;
const pageFades = new WeakMap<object, Animation>();
/**
 * Fades the page that has just replaced another one in `element`. Opacity only: a transform on the canvas would
 * re-anchor the fixed drawer, toast and phone menu inside it. A fade still running is cancelled first, so quick
 * switches never queue. Returns the animation, or null when nothing was started (reduced motion, no element, or a
 * browser without the Web Animations API).
 */
export function pageFade(element: HTMLElement | null | undefined): Animation | null {
  if (!element) return null;
  pageFades.get(element)?.cancel();
  pageFades.delete(element);
  if (reducedMotion() || typeof element.animate !== 'function') return null;
  const animation = element.animate([{ opacity: pageFadeFrom }, { opacity: 1 }], { duration: durations.short, easing: easeOut });
  pageFades.set(element, animation);
  return animation;
}

/**
 * Draws the earned arc of the grade ring in, from an empty ring (`from`, the ring's full dash length) to the arc the
 * course has earned (`to`). The figure inside the ring and every other number are final from the first frame; only the
 * arc moves. Returns null when nothing was started (reduced motion: the arc is simply there).
 */
export function drawArc(arc: SVGElement | null | undefined, from: number, to: number): Animation | null {
  if (!arc || reducedMotion() || typeof arc.animate !== 'function') return null;
  return arc.animate([{ strokeDashoffset: from }, { strokeDashoffset: to }], { duration: durations.arc, easing: easeOut });
}

/** How long data may take before its placeholder is painted. Shorter waits show nothing, then the data itself. */
export const placeholderDelay = 150;
/**
 * What stands in the place of data that may still be on its way.
 * `waiting`: the space is reserved and nothing is painted yet. `placeholder`: the wait outlasted the delay.
 * `shown`: the data, painted at once. `faded`: the data replacing a placeholder that was painted, so it fades in;
 * when the fade is `done` it is `shown` again, so the fade cannot replay if the element is put back later.
 */
export type Reveal = 'waiting' | 'placeholder' | 'shown' | 'faded';
export function nextReveal(state: Reveal, event: 'ready' | 'delay' | 'done' | 'reset'): Reveal {
  if (event === 'reset') return 'waiting';
  if (event === 'delay') return state === 'waiting' ? 'placeholder' : state;
  if (event === 'done') return state === 'faded' ? 'shown' : state;
  return state === 'waiting' ? 'shown' : state === 'placeholder' ? 'faded' : state;
}
/** Follows `ready` through `nextReveal`, with the delay timer. `ready` true on mount means `shown`: no placeholder, no fade. */
export function useReveal(ready: boolean): Reveal {
  const [state, setState] = useState<Reveal>(ready ? 'shown' : 'waiting');
  // Derived during render, so the data is never held back for a frame behind its placeholder.
  const settled = state === 'shown' || state === 'faded';
  const current = ready && !settled ? nextReveal(state, 'ready') : !ready && settled ? nextReveal(state, 'reset') : state;
  if (current !== state) setState(current);
  useEffect(() => {
    if (current !== 'waiting' && current !== 'faded') return;
    const timer = current === 'waiting' ? window.setTimeout(() => setState(value => nextReveal(value, 'delay')), placeholderDelay)
      : window.setTimeout(() => setState(value => nextReveal(value, 'done')), durations.short + 50);
    return () => window.clearTimeout(timer);
  }, [current]);
  return current;
}

let themingTimer: number | undefined;
/**
 * Applies a theme or background change while every colour on the page fades to its new value together (style.css,
 * `data-theming`): the mark is set, `update` runs in the same call, and the mark is cleared when the fade has had its
 * time. A newer call keeps the mark for its own fade. Not a View Transition: that shows a picture of the page, and the
 * page under a picture takes no clicks for as long as it is shown.
 */
export function themeTransition(update: () => void): void {
  if (reducedMotion()) { update(); return; }
  const root = document.documentElement;
  root.dataset.theming = '';
  window.clearTimeout(themingTimer);
  themingTimer = window.setTimeout(() => { delete root.dataset.theming; }, durations.medium + 50);
  update();
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
  // The timer guarantees the close if animationend never fires (hidden tab, no animation).
  const timer = window.setTimeout(finish, durations.short + 50);
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
