import { useState } from 'react';
import type { ReactNode } from 'react';

/**
 * A floating panel that can be folded up, so it never has to hide the scene. Its contents stay mounted while folded
 * (just hidden), so anything typed into them is kept.
 */
export function Panel({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel glass">
      <button className="panel-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span className="muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      <div className="panel-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
