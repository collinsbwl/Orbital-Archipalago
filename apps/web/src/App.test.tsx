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
// The real scene needs WebGL. This stand-in just lets a test click a planet to focus it.
vi.mock('./components/Scene3D', () => ({
  Scene3D: ({ focused, onFocus }: { focused: string | null; onFocus: (id: string | null) => void }) => (
    <button data-testid="scene" data-focused={focused ?? ''} onClick={() => onFocus('verdan')}>planet</button>
  ),
}));

const { App } = await import('./App');

describe('App god-mode panel', () => {
  it('is hidden for spectators', () => {
    view.role = 'spectator';
    render(<App />);
    expect(screen.queryByText('God mode')).toBeNull();
    expect(screen.getByText(/Verdan.*grain|grain.*Verdan/)).toBeTruthy(); // the drought, as a headline
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

  it('shows how to use the view and keeps panels mounted but folded', () => {
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

describe('App focus mode', () => {
  it('opens the planet card when a planet is focused, and Esc or Back returns to the map', () => {
    view.role = 'spectator';
    view.mode = 'live';
    render(<App />);
    expect(screen.queryByText('Back to map (Esc)')).toBeNull();

    fireEvent.click(screen.getByTestId('scene')); // click the planet
    expect(screen.getByLabelText('Verdan details')).toBeTruthy();
    expect(screen.getByTestId('scene').getAttribute('data-focused')).toBe('verdan');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('Verdan details')).toBeNull();
    expect(screen.getByTestId('scene').getAttribute('data-focused')).toBe('');

    fireEvent.click(screen.getByTestId('scene'));
    fireEvent.click(screen.getByText('Back to map (Esc)'));
    expect(screen.queryByLabelText('Verdan details')).toBeNull();
  });

  it('ignores other keys, and drops a focus on a planet that is no longer there', () => {
    view.role = 'spectator';
    view.mode = 'live';
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByTestId('scene'));
    fireEvent.keyDown(window, { key: 'a' });
    expect(screen.getByLabelText('Verdan details')).toBeTruthy();

    const only = makeSnapshot(8);
    only.planets = only.planets.filter((p) => p.planet === 'helion');
    view.snapshot = only; // another universe, without Verdan
    rerender(<App />);
    expect(screen.queryByLabelText('Verdan details')).toBeNull();
    view.snapshot = makeSnapshot(7);
  });
});
