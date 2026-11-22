import type { Snapshot } from '@orbital/contracts';
import { lookFor } from '../scene/planet-look';

/** Which colour is which planet: a swatch from each planet's look beside its name. */
export function PlanetLegend({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="legend glass">
      {snapshot.planets.map((p) => (
        <span key={p.planet}><i style={{ background: lookFor(p.planet).palette[0] }} /> {p.planet}</span>
      ))}
    </div>
  );
}
