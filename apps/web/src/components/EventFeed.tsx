import { useRef } from 'react';
import type { SimEvent } from '@orbital/contracts';
import { toNews } from './headlines';
import { useFlipList, usePresence } from './motion';
import { GlanceLine, NewsTag, type PlanetCurrency } from './NewsBits';

export const GOD_MODE_TAG = '[god mode]'; // same tag the engine puts on operator-caused events

/** Big events as a news channel's story list. Routine engine events are left out. */
export function EventFeed({ events, planets = [] }: { events: SimEvent[]; planets?: PlanetCurrency[] }) {
  const newestFirst = [...events].reverse().sort((a, b) => b.cycle - a.cycle);
  const news = newestFirst.flatMap((e) => {
    const n = toNews(e);
    return n ? [{ e, ...n }] : [];
  });
  // New stories slide in, old ones fade out, and the rest glide to their new place.
  const shown = usePresence(news, (n) => n.e.id);
  const listRef = useRef<HTMLUListElement>(null);
  useFlipList(listRef, shown.map((s) => s.key).join(','));

  return (
    <section>
      <div className="station-bar">
        <span className="live-dot" /> <b>LIVE</b> <span className="station">Orbital News</span>
      </div>
      {news.length === 0 && <p className="muted">{newestFirst.length > 0 ? 'No big news yet.' : 'No events yet.'}</p>}
      <ul className="events news" ref={listRef}>
        {shown.map(({ item: { e, headline, glance }, key, leaving }) => (
          <li key={key} data-key={key} className={`tone-${glance.tone}${glance.breaking ? ' breaking' : ''}${e.text.startsWith(GOD_MODE_TAG) ? ' god' : ''}${leaving ? ' leaving' : ''}`}>
            <div className="news-top">
              <NewsTag g={glance} />
              <span className="muted cycle">c{e.cycle}</span>
            </div>
            <div className="headline">{headline}</div>
            <GlanceLine g={glance} planets={planets} />
          </li>
        ))}
      </ul>
    </section>
  );
}
