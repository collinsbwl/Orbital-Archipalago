import { useMemo } from 'react';
import { Pieces } from './PieceMeshes';
import { portPieces } from './port';
import type { Port } from './port';

/** The spaceport itself: apron, spur road, four pads, control tower and lights. */
export function Spaceport({ port }: { port: Port }) {
  const pieces = useMemo(() => portPieces(port), [port]);
  return <Pieces pieces={pieces} />;
}
