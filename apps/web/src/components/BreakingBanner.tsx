import { useEffect, useRef, useState } from 'react';
import type { SimEvent } from '@orbital/contracts';
import { toNews, type Glance } from './headlines';
import { EXIT_MS } from './motion';
import { GlanceLine, planetsInStory, type PlanetCurrency } from './NewsBits';

/** How long a breaking story stays on screen. */
export const BANNER_MS = 10_000;

interface Story { id: string; headline: string; glance: Glance; planetIds: Set<string> }

interface Props {
  events: SimEvent[];
  planets?: PlanetCurrency[];
  /** Current cycle. If it goes backwards (looped playback), events are news again. */
  cycle?: number;
  /** The planet the player is on or zoomed into: only that planet's news pops up. Null on the map. */
  focused?: string | null;
}

/**
 * TV-style breaking-news lower third. It slides in when a new breaking event arrives (not for events already
 * there on load), with a ticker crawling the latest headlines, and slides away after BANNER_MS or on close.
 */
export function BreakingBanner({ events, planets = [], cycle = 0, focused = null }: Props) {
  const seen = useRef<Set<string> | null>(null);
  const lastCycle = useRef(cycle);
  const [story, setStory] = useState<Story | null>(null);
  // True while the banner slides away; it is removed EXIT_MS later.
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(events.map((e) => e.id)); // old news on load is not breaking
      return;
    }
    if (cycle < lastCycle.current) seen.current.clear(); // playback looped: the same events are happening again
    lastCycle.current = cycle;
    let newest: Story | null = null;
    for (const e of events) {
      if (seen.current.has(e.id)) continue;
      seen.current.add(e.id);
      const n = toNews(e);
      if (!n?.glance.breaking) continue;
      const planetIds = planetsInStory(e, n.glance, planets);
      if (focused && !planetIds.has(focused)) continue; // on a planet: only its own news
      newest = { id: e.id, ...n, planetIds };
    }
    if (newest) {
      setStory(newest);
      setLeaving(false);
    }
  }, [events, cycle, focused, planets]);

  useEffect(() => {
    if (!story) return;
    const t = setTimeout(() => setLeaving(true), BANNER_MS);
    return () => clearTimeout(t);
  }, [story]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => {
      setStory(null);
      setLeaving(false);
    }, EXIT_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  // Landing on another planet hides a story that isn't about it.
  if (!story || (focused && !story.planetIds.has(focused))) return null;
  const ticker = [...events].reverse().flatMap((e) => {
    const n = toNews(e);
    if (!n) return [];
    return !focused || planetsInStory(e, n.glance, planets).has(focused) ? [n.headline] : [];
  }).slice(0, 8);
  return (
    <div className={`breaking-banner${leaving ? ' leaving' : ''}`} role="alert" key={story.id}>
      <div className="bb-main">
        <div className="bb-flag">Breaking<br />news</div>
        <div className="bb-body">
          <div className="bb-desk">{story.glance.category}</div>
          <div className="bb-headline">{story.headline}</div>
          <GlanceLine g={story.glance} planets={planets} />
        </div>
        <button className="bb-close" aria-label="Dismiss breaking news" onClick={() => setLeaving(true)}>×</button>
      </div>
      {ticker.length > 0 && (
        <div className="bb-ticker" aria-hidden="true">
          <span className="bb-ticker-label">ONN</span>
          <div className="bb-crawl"><span>{[...ticker, ...ticker].join('   ●   ')}</span></div>
        </div>
      )}
    </div>
  );
}
