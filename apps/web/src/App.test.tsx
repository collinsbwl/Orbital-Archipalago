import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from './test-fixtures';
import type { SnapshotsView } from './data/useSnapshots';

const view: SnapshotsView = {
  snapshot: makeSnapshot(7), role: 'spectator', connected: true, mode: 'live', universeId: 'u0', universes: ['u0'], error: null,
  playbackPaused: false, sendCommand: vi.fn(async () => ({ ok: true })), selectUniverse: vi.fn(), setPlaybackPaused: vi.fn(),
  playbackSpeed: 1, setPlaybackSpeed: vi.fn(),
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

describe('App playback controls', () => {
  it('shows pause and speed buttons in fixture mode and wires them up', () => {
    view.role = 'spectator';
    view.mode = 'fixture';
    render(<App />);
    fireEvent.click(screen.getByText('Pause'));
    expect(view.setPlaybackPaused).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText('4x'));
    expect(view.setPlaybackSpeed).toHaveBeenCalledWith(4);
    expect(screen.getByText('1x').getAttribute('aria-pressed')).toBe('true');
  });

  it('hides them for a live engine, which sets its own pace', () => {
    view.role = 'spectator';
    view.mode = 'live';
    render(<App />);
    expect(screen.queryByText('Pause')).toBeNull();
    expect(screen.queryByText('4x')).toBeNull();
  });

  it('holds the scene still while playback is paused', () => {
    view.mode = 'fixture';
    view.playbackPaused = true;
    render(<App />);
    expect(screen.getByText('Play')).toBeTruthy();
    view.playbackPaused = false;
  });

  it('lists the planets in the legend and keeps panels mounted but folded', () => {
    view.mode = 'live';
    render(<App />);
    expect(screen.getAllByText(/Drag to rotate/).length).toBe(1);
    const head = screen.getByText('Planets and charts').closest('button')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Charts')).toBeTruthy(); // still in the page, just hidden
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });
});
