import { useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { hashString } from '../scene/planet-look';
import type { AtmosphereRef } from './atmosphere-ref';
import type { CityLayout } from './city-layout';
import { crystalSpireGeometry, iceShellGeometry, useCrystalMaterial } from './crystal';
import { applyPlacements } from './instancing';
import type { Placement } from './instancing';
import { portClearance } from './port';
import type { Port } from './port';
import { makeRng } from './rng';
import type { Terrain } from './terrain';

export interface Monolith {
  kind: 'spire' | 'shell';
  x: number;
  z: number;
  y: number;
  /** Across and tall, metres. */
  width: number;
  height: number;
  rotY: number;
  color: string;
}

const COLORS = ['#9fd4f2', '#6fa9d6', '#c8ecff', '#4f86b8'];

/**
 * The giant ice structures on a crystal world's skyline: one carved shell the size of a hill straight across the city
 * from where you land, a ring of colossal spires just outside the city, and a far forest of spires fading into the
 * haze by the mountains. Nothing lands on water, a mine or field, or the spaceport. Same planet, same skyline.
 */
export function layoutMonoliths(planet: string, layout: CityLayout, terrain: Terrain, port: Port): Monolith[] {
  const rng = makeRng(hashString(`${planet}:monoliths`));
  const out: Monolith[] = [];
  const free = (x: number, z: number, room: number) =>
    terrain.waterDepthAt(x, z) <= 0 && terrain.siteClearance(x, z) > room && portClearance(port, x, z) > room;
  const place = (kind: Monolith['kind'], angle: number, radius: number, width: number, height: number) => {
    // Nudge round the circle until the spot is clear.
    for (let tries = 0; tries < 12; tries++) {
      const a = angle + (tries % 2 ? 1 : -1) * Math.ceil(tries / 2) * 0.18;
      const x = radius * Math.sin(a);
      const z = radius * Math.cos(a);
      if (!free(x, z, width * 0.6)) continue;
      out.push({ kind, x, z, y: terrain.heightAt(x, z) - 0.5, width, height, rotY: a + Math.PI / 2 + (rng() - 0.5) * 0.6, color: COLORS[Math.floor(rng() * COLORS.length)]! });
      return;
    }
  };

  // Straight across from the landing spot, so it rises behind the city in the first view.
  const landing = layout.roads[0]!.angle;
  place('shell', landing + Math.PI + 0.35, 112, 46, 92);

  // Colossal spires just past the edge of the city, between the roads.
  const roads = layout.roads.map((r) => r.angle);
  for (let i = 0; i < roads.length; i++) {
    const a = roads[i]!;
    const b = roads[(i + 1) % roads.length]! + (i === roads.length - 1 ? Math.PI * 2 : 0);
    const mid = (a + b) / 2;
    const tall = rng() < 0.4;
    place('spire', mid + (rng() - 0.5) * 0.2, 84 + rng() * 10, tall ? 9 : 6, tall ? 95 + rng() * 40 : 45 + rng() * 30);
  }

  // A far field of spires in the haze.
  for (let i = 0; i < 40; i++) {
    const r = 150 + rng() * 120;
    place('spire', rng() * Math.PI * 2, r, 5 + rng() * 9, 35 + rng() * 75);
  }
  return out;
}

/** The skyline of a crystal world (see `layoutMonoliths`). */
export function IceLandmarks({ planet, layout, terrain, port, atmo }: { planet: string; layout: CityLayout; terrain: Terrain; port: Port; atmo?: AtmosphereRef }) {
  const monoliths = useMemo(() => layoutMonoliths(planet, layout, terrain, port), [planet, layout, terrain, port]);
  const spireGeo = useMemo(() => crystalSpireGeometry(), []);
  const shellGeo = useMemo(() => iceShellGeometry(hashString(planet) % 7), [planet]);
  useEffect(() => () => spireGeo.dispose(), [spireGeo]);
  useEffect(() => () => shellGeo.dispose(), [shellGeo]);
  const spireMaterial = useCrystalMaterial(atmo, { strength: 1.2 });
  const shellMaterial = useCrystalMaterial(atmo, { glow: '#ffd9a8', strength: 0.55 });

  const spires = useMemo<Placement[]>(
    () => monoliths.filter((m) => m.kind === 'spire').map((m) => ({ x: m.x, y: m.y, z: m.z, rotY: m.rotY, scale: [m.width, m.height, m.width], color: m.color })),
    [monoliths],
  );
  const shells = useMemo<Placement[]>(
    () => monoliths.filter((m) => m.kind === 'shell').map((m) => ({ x: m.x, y: m.y, z: m.z, rotY: m.rotY, scale: [m.width, m.height, m.width], color: '#b9cfe0' })),
    [monoliths],
  );

  const spireMesh = useMemo(() => new THREE.InstancedMesh(spireGeo, spireMaterial, Math.max(1, spires.length)), [spireGeo, spireMaterial, spires.length]);
  const shellMesh = useMemo(() => new THREE.InstancedMesh(shellGeo, shellMaterial, Math.max(1, shells.length)), [shellGeo, shellMaterial, shells.length]);
  useEffect(() => () => void spireMesh.dispose(), [spireMesh]);
  useEffect(() => () => void shellMesh.dispose(), [shellMesh]);
  useLayoutEffect(() => {
    applyPlacements(spireMesh, spires);
    applyPlacements(shellMesh, shells);
    spireMesh.computeBoundingSphere();
    shellMesh.computeBoundingSphere();
  }, [spireMesh, shellMesh, spires, shells]);

  return (
    <>
      <primitive object={spireMesh} />
      <primitive object={shellMesh} />
    </>
  );
}
