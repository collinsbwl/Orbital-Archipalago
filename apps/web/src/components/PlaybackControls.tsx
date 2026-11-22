export const SPEEDS = [0.5, 1, 2, 4] as const;

interface Props {
  playbackPaused: boolean;
  setPlaybackPaused: (paused: boolean) => void;
  playbackSpeed: number;
  setPlaybackSpeed: (speed: number) => void;
}

/** Pause and speed buttons for the recorded fixtures. (A live engine sets its own pace.) */
export function PlaybackControls({ playbackPaused, setPlaybackPaused, playbackSpeed, setPlaybackSpeed }: Props) {
  return (
    <div className="playback glass" role="group" aria-label="Playback">
      <button onClick={() => setPlaybackPaused(!playbackPaused)}>{playbackPaused ? 'Play' : 'Pause'}</button>
      {SPEEDS.map((s) => (
        <button key={s} aria-pressed={playbackSpeed === s} onClick={() => setPlaybackSpeed(s)}>{s}x</button>
      ))}
    </div>
  );
}
