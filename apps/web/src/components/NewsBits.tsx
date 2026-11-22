import type { PlanetSnapshot, SimEvent } from '@orbital/contracts';
import { lookFor } from '../scene/planet-look';
import type { Glance } from './headlines';

export type PlanetCurrency = Pick<PlanetSnapshot, 'planet' | 'currency'>;

const ARROW = { up: '▲', down: '▼', none: '◆' } as const;

/** Display name ("Helion", "New tethys") back to the planet id the engine uses ("helion", "new_tethys"). */
export const idOf = (name: string) => name.toLowerCase().replace(/ /g, '_');
const nameOf = (id: string) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Ids of every planet a story is about: the event's own planet, the planets it names, and a currency's home planet. */
export function planetsInStory(e: SimEvent, g: Glance, planets: PlanetCurrency[]): Set<string> {
  const ids = new Set(g.planets.map(idOf));
  if (e.planet) ids.add(e.planet);
  const home = g.currency ? planets.find((p) => p.currency === g.currency)?.planet : undefined;
  if (home) ids.add(home);
  return ids;
}

export function PlanetChip({ id, label }: { id: string; label: string }) {
  return <span className="planet-chip"><i style={{ background: lookFor(id).palette[0] }} />{label}</span>;
}

/** The desk tag in front of a story: a red BREAKING for the big stuff, else its category. */
export function NewsTag({ g }: { g: Glance }) {
  return g.breaking
    ? <span className="news-tag breaking">Breaking</span>
    : <span className={`news-tag cat-${g.category.replace(/ /g, '-').toLowerCase()}`}>{g.category}</span>;
}

/** One-line summary of a story: planet(s), what changed, which way, by how much. Colour shows good or bad news. */
export function GlanceLine({ g, planets }: { g: Glance; planets: PlanetCurrency[] }) {
  const currencyPlanet = g.currency ? planets.find((p) => p.currency === g.currency)?.planet : undefined;
  return (
    <div className="glance">
      {g.planets.map((name, i) => (
        <span key={name} className="glance-planets">
          {i > 0 && <span className="muted">{g.what === 'Trade' ? '→' : '&'}</span>}
          <PlanetChip id={idOf(name)} label={name} />
        </span>
      ))}
      {currencyPlanet && <PlanetChip id={currencyPlanet} label={nameOf(currencyPlanet)} />}
      <span className={`move ${g.tone}`}>
        <b>{ARROW[g.direction]}</b> {g.what} <b>{g.change}</b>
      </span>
    </div>
  );
}
