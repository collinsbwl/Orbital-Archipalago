import { useMemo } from 'react';
import { buildIndustry } from './industry';
import type { IndustryModel } from './industry';
import { Pieces } from './PieceMeshes';
import type { Terrain } from './terrain';

/** What every industry site looks like, built once per terrain. Smoke reads the emitters from the same models. */
export function useIndustryModels(terrain: Terrain): IndustryModel[] {
  return useMemo(() => buildIndustry(terrain.sites, terrain.features.pits, terrain), [terrain]);
}

/** Mine headframes and conveyors, refineries, farmsteads, pump stations and forges, standing on the terrain's sites. */
export function Industry({ models }: { models: IndustryModel[] }) {
  const pieces = useMemo(() => models.flatMap((m) => m.pieces), [models]);
  return <Pieces pieces={pieces} />;
}
