import { useMemo } from 'react';
import type { AtmosphereRef } from './atmosphere-ref';
import { Pieces } from './PieceMeshes';
import { portPieces } from './port';
import type { Port } from './port';

/** The spaceport itself: apron, spur road, four pads, control tower and lights (which come on after dark). */
export function Spaceport({ port, atmo }: { port: Port; atmo?: AtmosphereRef }) {
  const pieces = useMemo(() => portPieces(port), [port]);
  return <Pieces pieces={pieces} atmo={atmo} />;
}
