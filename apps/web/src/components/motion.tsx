import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** How long a number or chart takes to glide to its new value. Shorter than one cycle, so it settles before the next. */
export const TWEEN_MS = 600;

const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Follows `target`, gliding from the value currently shown to the new one over `ms` instead of jumping.
 * Works on several numbers at once (e.g. a chart's axis bounds) so they move together.
 */
export function useTweenedList(target: readonly number[], ms = TWEEN_MS): number[] {
  const [shown, setShown] = useState<number[]>(() => [...target]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const key = target.join('|');

  useEffect(() => {
    const to = key === '' ? [] : key.split('|').map(Number);
    const from = shownRef.current;
    if (reducedMotion() || from.length !== to.length || to.some((v, i) => !Number.isFinite(v) || !Number.isFinite(from[i]!))) {
      setShown(to);
      return;
    }
    if (to.every((v, i) => v === from[i])) return;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const k = easeOut(t);
      setShown(to.map((v, i) => from[i]! + (v - from[i]!) * k));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [key, ms]);

  return shown;
}

/** How long a leaving item stays on screen while it animates out. */
export const EXIT_MS = 350;

/**
 * Keeps items that dropped out of `items` around for EXIT_MS, flagged `leaving`, so they can animate out instead of
 * vanishing. A leaving item keeps the place it had in the list.
 */
export function usePresence<T>(items: T[], keyOf: (item: T) => string): { item: T; key: string; leaving: boolean }[] {
  const [leaving, setLeaving] = useState<Map<string, { item: T; index: number }>>(new Map());
  const prev = useRef<{ item: T; key: string }[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const current = items.map((item) => ({ item, key: keyOf(item) }));
  const currentKeys = current.map((c) => c.key).join('\n');

  useEffect(() => {
    const now = new Set(current.map((c) => c.key));
    const gone = prev.current.map((p, index) => ({ ...p, index })).filter((p) => !now.has(p.key));
    prev.current = current;
    if (gone.length === 0 || reducedMotion()) return;
    setLeaving((m) => {
      const next = new Map(m);
      for (const g of gone) next.set(g.key, { item: g.item, index: g.index });
      return next;
    });
    // Not cancelled when the list changes again: each exit finishes on its own clock.
    const t = setTimeout(() => {
      timers.current.delete(t);
      setLeaving((m) => {
        const next = new Map(m);
        for (const g of gone) next.delete(g.key);
        return next;
      });
    }, EXIT_MS);
    timers.current.add(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKeys]);

  const out = current.map((c) => ({ ...c, leaving: false }));
  const present = new Set(out.map((o) => o.key));
  for (const [key, { item, index }] of [...leaving].sort((a, b) => a[1].index - b[1].index)) {
    if (present.has(key)) continue;
    out.splice(Math.min(index, out.length), 0, { item, key, leaving: true });
  }
  return out;
}

/**
 * FLIP animation for a list keyed by `data-key`: when items are added or reordered, the ones that stay slide to
 * their new place instead of jumping, and new ones (after the first render) fade and slide in.
 */
export function useFlipList(listRef: RefObject<HTMLElement | null>, deps: unknown) {
  const positions = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = Array.from(list.children) as HTMLElement[];
    const next = new Map<string, number>();
    for (const el of items) if (!el.classList.contains('leaving')) next.set(el.dataset.key ?? '', el.offsetTop);
    const prev = positions.current;
    positions.current = next;
    if (!prev || reducedMotion() || typeof list.animate !== 'function') return;
    for (const el of items) {
      if (el.classList.contains('leaving')) continue;
      const key = el.dataset.key ?? '';
      const before = prev.get(key);
      if (before === undefined) {
        el.animate([{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'ease-out' });
      } else if (before !== next.get(key)) {
        el.animate([{ transform: `translateY(${before - next.get(key)!}px)` }, { transform: 'none' }], { duration: 450, easing: 'ease-out' });
      }
    }
  }, [deps, listRef]);
}

/** Which way is good news for a number: 'up' (GDP), 'down' (inflation), or 'none' (just show that it changed). */
export type Better = 'up' | 'down' | 'none';

/** The tone of a change from `prev` to `next`, or null if it did not change. */
export function tickTone(prev: number, next: number, better: Better): 'good' | 'bad' | 'neutral' | null {
  if (next === prev || !Number.isFinite(prev) || !Number.isFinite(next)) return null;
  if (better === 'none') return 'neutral';
  return (next > prev) === (better === 'up') ? 'good' : 'bad';
}

/** Wraps a number's text: when `value` changes it briefly flashes green (good), red (bad) or blue (neutral), then fades back. */
export function Tick({ value, better, children }: { value: number; better: Better; children: ReactNode }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<{ tone: string; n: number } | null>(null);
  useEffect(() => {
    const tone = tickTone(prev.current, value, better);
    prev.current = value;
    if (tone) setFlash((f) => ({ tone, n: (f?.n ?? 0) + 1 }));
  }, [value, better]);
  // A new key remounts the span, which restarts the flash animation on every change.
  return <span key={flash?.n ?? 0} className={flash ? `tick tick-${flash.tone}` : 'tick'}>{children}</span>;
}
