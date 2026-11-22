import type { PlanetSnapshot } from '@orbital/contracts';
import { planetTitle } from '../scene/labels';
import { lookFor } from '../scene/planet-look';

const n = (v: number) => v.toLocaleString('en-US');

/** The economy numbers of one planet, as listed in the card. Kept separate so they are easy to test. */
export function planetFacts(p: PlanetSnapshot): [string, string][] {
  return [
    ['GDP', n(p.metrics.gdp)],
    ['Inflation (CPI)', (p.metrics.cpi / 100).toFixed(1)],
    ['Trade balance', n(p.metrics.tradeBalance)],
    ['Population', n(p.metrics.population)],
    ['Consumer confidence', String(p.metrics.consumerConfidence)],
    ['Business confidence', String(p.metrics.businessConfidence)],
    ['Policy rate', `${(p.policy.policyRateBp / 100).toFixed(2)}%`],
  ];
}

/** The card shown while the camera is zoomed in on a planet. It updates with every new snapshot. */
export function PlanetCard({ planet, onBack }: { planet: PlanetSnapshot; onBack: () => void }) {
  return (
    <section className="planet-card glass" aria-label={`${planetTitle(planet.planet)} details`}>
      <header>
        <strong><i style={{ background: lookFor(planet.planet).palette[0] }} />{planetTitle(planet.planet)}</strong>
        <span className="muted">{planet.currency}</span>
        <span className="spacer" />
        <button onClick={onBack}>Back to map (Esc)</button>
      </header>
      <dl>
        {planetFacts(planet).map(([label, value]) => (
          <div key={label}>
            <dt className="muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
