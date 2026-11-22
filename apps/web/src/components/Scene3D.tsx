import { lazy, Suspense, useState } from 'react';
import type { Snapshot } from '@orbital/contracts';

// The 3D code is big, so it loads only when the view is shown.
const SceneCanvas = lazy(() => import('../scene/SceneCanvas'));

/** True if this browser can make a WebGL context. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

interface Scene3DProps {
  snapshot: Snapshot;
  /** Holds planets and ships still (paused playback or a paused engine). */
  frozen: boolean;
  /** The planet the camera is zoomed in on, or null for the map. */
  focused: string | null;
  onFocus: (planetId: string | null) => void;
}

/** The 3D view of the archipelago. */
export function Scene3D({ snapshot, frozen, focused, onFocus }: Scene3DProps) {
  const [ok] = useState(webglAvailable);
  if (!ok) return <div className="scene-note muted">The 3D view needs WebGL, which this browser does not have.</div>;
  return (
    <Suspense fallback={<div className="scene-note muted">Loading the 3D view...</div>}>
      <SceneCanvas snapshot={snapshot} frozen={frozen} focused={focused} onFocus={onFocus} />
    </Suspense>
  );
}
