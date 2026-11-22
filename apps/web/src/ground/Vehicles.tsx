import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { makeLoop } from './city-layout';
import type { CityLayout, Loop } from './city-layout';
import { setInstance } from './instancing';
import type { Port } from './port';
import { haulPath } from './port';
import { carGeometry, haulerGeometry } from './shapes';
import { haulerCount, lanePolygon, makeVehicles, MAX_CARS, MAX_HAULERS, roadLoops, vehicleCount, vehiclePose } from './traffic';
import type { VehicleSpec } from './traffic';

const CAR_COLORS = ['#d9534f', '#4f8fd9', '#e8c547', '#8fd46a', '#f2f2f2', '#9b6ad9', '#e8884f'];
const HAULER_COLOR = '#e8a43c';
/** Road surface heights, so wheels rest on the tarmac. */
const ROAD_Y = 0.08;
const SPUR_Y = 0.1;

/** One kind of vehicle as an instanced mesh, driven round loops. Only the first `count` specs are shown. */
function Fleet({ geometry, specs, loops, count, colors, y }: { geometry: THREE.BufferGeometry; specs: VehicleSpec[]; loops: Loop[]; count: number; colors: (s: VehicleSpec) => THREE.ColorRepresentation; y: number }) {
  const material = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7 }), []);
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(geometry, material, Math.max(1, specs.length));
    m.frustumCulled = false;
    m.count = 0;
    return m;
  }, [geometry, material, specs.length]);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => void mesh.dispose(), [mesh]);

  useFrame(({ clock }) => {
    const n = Math.min(count, specs.length);
    for (let i = 0; i < n; i++) {
      const s = specs[i]!;
      const p = vehiclePose(loops, s, clock.elapsedTime);
      setInstance(mesh, i, { x: p.x, y, z: p.z, rotY: p.heading, scale: s.scale, color: colors(s) });
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

/**
 * Cars looping the radial roads, and haulers shuttling between the spaceport and the plaza. How many are out is a share
 * (`traffic`, 0 to 1) of a fixed fleet, so the mood system can thin them out or fill the streets; haulers also grow with
 * the number of ships at the port.
 */
export function Vehicles({ planet, streets, port, traffic, portShips }: { planet: string; streets: CityLayout; port: Port; traffic: number; portShips: number }) {
  const carLoops = useMemo(() => roadLoops(streets), [streets]);
  const haulLoops = useMemo(() => [makeLoop(lanePolygon(haulPath(port, streets), 1.4))], [port, streets]);
  const cars = useMemo(() => makeVehicles(carLoops, MAX_CARS, planet, 'car'), [carLoops, planet]);
  const haulers = useMemo(() => makeVehicles(haulLoops, MAX_HAULERS, planet, 'hauler'), [haulLoops, planet]);
  const carGeo = useMemo(() => carGeometry(), []);
  const haulerGeo = useMemo(() => haulerGeometry(), []);
  useEffect(() => () => carGeo.dispose(), [carGeo]);
  useEffect(() => () => haulerGeo.dispose(), [haulerGeo]);
  const color = useMemo(() => new THREE.Color(), []);
  const carColor = (s: VehicleSpec) => color.set(CAR_COLORS[Math.floor(s.tint * CAR_COLORS.length) % CAR_COLORS.length]!);
  const haulerColor = () => color.set(HAULER_COLOR);
  return (
    <>
      <Fleet geometry={carGeo} specs={cars} loops={carLoops} count={vehicleCount(MAX_CARS, traffic)} colors={carColor} y={ROAD_Y} />
      <Fleet geometry={haulerGeo} specs={haulers} loops={haulLoops} count={haulerCount(portShips, traffic)} colors={haulerColor} y={SPUR_Y} />
    </>
  );
}
