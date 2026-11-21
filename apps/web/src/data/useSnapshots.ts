import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import type { GodModeCommand, Snapshot, UniverseId } from '@orbital/contracts';
import { AUTH0_ENABLED } from '../auth';
import { FixtureSource } from './fixture-source';
import { LiveSource } from './live-source';
import { resolveMode } from './mode';
import { INITIAL_STATE } from './types';
import type { CommandAck, Mode, Role, SnapshotSource } from './types';

export interface SnapshotsView {
  snapshot: Snapshot | null;
  role: Role | null;
  connected: boolean;
  mode: Mode;
  sendCommand: (universeId: UniverseId, command: GodModeCommand) => Promise<CommandAck>;
  universeId: UniverseId | null;
  universes: UniverseId[];
  selectUniverse: (id: UniverseId) => void;
  error: string | null;
  playbackPaused: boolean;
  setPlaybackPaused: (paused: boolean) => void;
  playbackSpeed: number;
  setPlaybackSpeed: (speed: number) => void;
}

const { mode, wsUrl } = resolveMode(window.location.search, import.meta.env.VITE_ENGINE_WS_URL);

export function useSnapshots(): SnapshotsView {
  // Outside <Auth0Provider> this returns the inert default context (not authenticated, not loading).
  const { isAuthenticated, isLoading, getAccessTokenSilently } = useAuth0();
  const authPending = AUTH0_ENABLED && isLoading;

  const source: SnapshotSource | null = useMemo(() => {
    if (authPending) return null;
    if (mode === 'fixture') return new FixtureSource();
    const getToken = AUTH0_ENABLED && isAuthenticated ? () => getAccessTokenSilently().catch(() => undefined) : undefined;
    return new LiveSource({ url: wsUrl, ...(getToken ? { getToken } : {}) });
    // getAccessTokenSilently is stable enough; rebuild only when the auth state flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authPending, isAuthenticated]);

  useEffect(() => {
    source?.start();
    return () => source?.stop();
  }, [source]);

  const subscribe = useCallback((l: () => void) => source?.subscribe(l) ?? (() => undefined), [source]);
  const getState = useCallback(() => source?.getState() ?? INITIAL_STATE, [source]);
  const state = useSyncExternalStore(subscribe, getState);

  return {
    ...state,
    mode,
    sendCommand: (u, c) => (source ? source.sendCommand(u, c) : Promise.resolve({ ok: false, error: 'not connected' })),
    selectUniverse: (id) => source?.selectUniverse(id),
    setPlaybackPaused: (p) => source?.setPlaybackPaused(p),
    setPlaybackSpeed: (v) => source?.setPlaybackSpeed(v),
  };
}
