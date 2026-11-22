import { useEffect, useRef } from 'react';
import { startIslandScene } from './island-scene';

export interface LandingProps {
  /** The button's label: "Sign in" with Auth0, "Enter" in anonymous dev. */
  actionLabel: string;
  onAction: () => void;
  /** True while Auth0 is still working out who the user is (e.g. right after the login redirect returns). */
  busy?: boolean;
  error?: string | null;
}

function Letters({ word, offset }: { word: string; offset: number }) {
  return (
    <>
      {[...word].map((ch, i) => (
        <span key={i} className="landing-letter" style={{ animationDelay: `${((offset + i) * 0.055).toFixed(3)}s` }}>
          {ch}
        </span>
      ))}
    </>
  );
}

/** The page shown before sign-in: the title forms letter by letter, then a 3D island bursts out and lands. */
export function Landing({ actionLabel, onAction, busy = false, error = null }: LandingProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    try {
      return startIslandScene(canvas);
    } catch {
      return undefined; // no WebGL: the page still works, just without the island
    }
  }, []);

  return (
    <main className="landing">
      <canvas ref={canvasRef} className="landing-canvas" aria-hidden="true" />
      <div className="landing-content">
        <h1 className="landing-title" aria-label="Orbital Archipelago">
          <span aria-hidden="true">
            <Letters word="ORBITAL" offset={0} />
          </span>
          <span aria-hidden="true" className="landing-title-accent">
            <Letters word="ARCHIPELAGO" offset={4} />
          </span>
        </h1>
        <div className="landing-cta">
          <button type="button" className="landing-button" onClick={onAction} disabled={busy}>
            {busy ? 'Signing in...' : actionLabel}
          </button>
          {error && (
            <p role="alert" className="landing-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
