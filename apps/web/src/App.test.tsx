import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from './test-fixtures';
import type { SnapshotsView } from './data/useSnapshots';

const view: SnapshotsView = {
  snapshot: makeSnapshot(7), role: 'spectator', connected: true, mode: 'live', universeId: 'u0', universes: ['u0'], error: null,
  playbackPaused: false, sendCommand: vi.fn(async () => ({ ok: true })), selectUniverse: vi.fn(), setPlaybackPaused: vi.fn(),
};
vi.mock('./data/useSnapshots', () => ({ useSnapshots: () => view }));
vi.mock('./components/Scene3D', () => ({ Scene3D: () => <div data-testid="scene" /> }));

const { App } = await import('./App');

describe('App god-mode panel', () => {
  it('is hidden for spectators', () => {
    view.role = 'spectator';
    render(<App />);
    expect(screen.queryByText('God mode')).toBeNull();
    expect(screen.getByText(/drought on Verdan/)).toBeTruthy();
  });

  it('is shown for operators', () => {
    view.role = 'operator';
    render(<App />);
    expect(screen.getByText('God mode')).toBeTruthy();
    expect(screen.getByText('Fork universe')).toBeTruthy();
  });

  it('shows a read-only note in fixture mode', () => {
    view.role = 'spectator';
    view.mode = 'fixture';
    render(<App />);
    expect(screen.queryByText('God mode')).toBeNull();
    expect(screen.getByText(/read-only/)).toBeTruthy();
  });
});
