import type { Snapshot } from '@orbital/contracts';
import { lookFor } from '../scene/planet-look';

/** Which planet is which (until planets carry their own labels), plus how to use the view. */
export function PlanetLegend({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="legend glass">
      {snapshot.planets.map((p) => (
        <span key={p.planet}><i style={{ background: lookFor(p.planet).palette[0] }} /> {p.planet}</span>
      ))}
      <span className="muted">Drag to rotate, scroll to zoom, hover a ship.</span>
    </div>
  );
}
