import type { Mode } from './types';

export const DEFAULT_LIVE_URL = 'ws://localhost:8787';

/**
 * Absolute `ws://` / `wss://` URLs pass through. Anything else (a path like `/ws`, or an http(s) URL) is resolved
 * against the page, with http → ws and https → wss: that is the single-origin deploy, where Caddy proxies `/ws` to
 * the engine, so the image never has to know its public domain.
 */
export function toWsUrl(url: string, pageHref: string): string {
  if (/^wss?:\/\//i.test(url)) return url;
  const u = new URL(url, pageHref);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

/** `?fixtures=1` forces fixtures; `?live=1` or VITE_ENGINE_WS_URL selects live; fixtures otherwise. */
export function resolveMode(search: string, engineWsUrl: string | undefined, pageHref = 'http://localhost/'): { mode: Mode; wsUrl: string } {
  const q = new URLSearchParams(search);
  const wsUrl = toWsUrl(engineWsUrl || DEFAULT_LIVE_URL, pageHref);
  if (q.get('fixtures') === '1') return { mode: 'fixture', wsUrl };
  if (q.get('live') === '1' || engineWsUrl) return { mode: 'live', wsUrl };
  return { mode: 'fixture', wsUrl };
}
