import { useMemo } from 'react';
import { PLAZA_TOP } from './City';
import { marketPieces, openCount } from './market';
import type { Stall } from './market';
import { Pieces } from './PieceMeshes';

/** Stalls round the plaza edge. `share` (0 to 1) is how many are open: the rest stand shuttered. */
export function Market({ stalls, share }: { stalls: Stall[]; share: number }) {
  const open = openCount(stalls.length, share);
  const pieces = useMemo(() => marketPieces(stalls, open, PLAZA_TOP), [stalls, open]);
  return <Pieces pieces={pieces} />;
}
