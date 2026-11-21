import type { Mode } from './types';

export const DEFAULT_LIVE_URL = 'ws://localhost:8787';

/** `?fixtures=1` forces fixtures; `?live=1` or VITE_ENGINE_WS_URL selects live; fixtures otherwise. */
export function resolveMode(search: string, engineWsUrl: string | undefined): { mode: Mode; wsUrl: string } {
  const q = new URLSearchParams(search);
  const wsUrl = engineWsUrl || DEFAULT_LIVE_URL;
  if (q.get('fixtures') === '1') return { mode: 'fixture', wsUrl };
  if (q.get('live') === '1' || engineWsUrl) return { mode: 'live', wsUrl };
  return { mode: 'fixture', wsUrl };
}
