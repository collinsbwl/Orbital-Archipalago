import type { SimEvent } from '@orbital/contracts';

export const GOD_MODE_TAG = '[god mode]'; // same tag the engine puts on operator-caused events

export function EventFeed({ events }: { events: SimEvent[] }) {
  const newestFirst = [...events].reverse().sort((a, b) => b.cycle - a.cycle);
  return (
    <section>
      {newestFirst.length === 0 && <p className="muted">No events yet.</p>}
      <ul className="events">
        {newestFirst.map((e) => (
          <li key={e.id} className={e.text.startsWith(GOD_MODE_TAG) ? 'god' : undefined}>
            <span className="muted">c{e.cycle}</span> <span className={`badge ${e.kind}`}>{e.kind}</span> {e.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
