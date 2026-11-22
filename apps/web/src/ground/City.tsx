import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PLAZA_RADIUS, ROAD_WIDTH, SIDEWALK_WIDTH } from './city-layout';
import type { CityLayout } from './city-layout';
import { shownHeight, stepGrowth } from './growth';
import type { GrowthState } from './growth';
import type { GroundLook } from './ground-look';
import { InstancedGroup } from './InstancedGroup';
import { setInstance } from './instancing';
import type { Placement } from './instancing';
import { groundedBox } from './shapes';

const ROAD_TOP = 0.08;
const SIDEWALK_TOP = 0.2;
export const PLAZA_TOP = 0.22;
/** Lane dashes along each road. */
const DASH_EVERY = 6;

/** A flat-shaded material that takes its colour from per-instance colours. */
function useFlatMaterial(roughness = 0.9) {
  const material = useMemo(() => new THREE.MeshStandardMaterial({ flatShading: true, roughness, metalness: 0.02 }), [roughness]);
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

const INDUSTRIAL = { wall: '#8d9096', roof: '#4a4d52' };
const RING_ROAD_Y = 0.05;
const RING_WALK_Y = 0.07;

/**
 * The city on the flat ground at the origin: a paved plaza with a fountain, roads with sidewalks and lane dashes, ring
 * streets that appear as the city spreads, and instanced buildings in the planet's colours that rise out of the ground
 * as the population grows.
 */
export function City({ layout, look }: { layout: CityLayout; look: GroundLook }) {
  const box = useMemo(() => groundedBox(), []);
  useEffect(() => () => box.dispose(), [box]);
  const material = useFlatMaterial();

  const roads = useMemo<Placement[]>(
    () => layout.roads.map((r) => ({ x: (r.dir[0] * r.length) / 2, y: 0, z: (r.dir[1] * r.length) / 2, rotY: r.angle, scale: [ROAD_WIDTH, ROAD_TOP, r.length], color: '#3a3d44' })),
    [layout],
  );
  const sidewalks = useMemo<Placement[]>(() => {
    const out: Placement[] = [];
    const off = ROAD_WIDTH / 2 + SIDEWALK_WIDTH / 2;
    for (const r of layout.roads) {
      for (const s of [1, -1]) {
        out.push({
          x: (r.dir[0] * r.length) / 2 + r.side[0] * off * s, y: 0, z: (r.dir[1] * r.length) / 2 + r.side[1] * off * s,
          rotY: r.angle, scale: [SIDEWALK_WIDTH, SIDEWALK_TOP, r.length], color: '#a9adb4',
        });
      }
    }
    return out;
  }, [layout]);
  const dashes = useMemo<Placement[]>(() => {
    const out: Placement[] = [];
    for (const r of layout.roads) {
      for (let d = PLAZA_RADIUS + 4; d < r.length - 3; d += DASH_EVERY) {
        out.push({ x: r.dir[0] * d, y: ROAD_TOP, z: r.dir[1] * d, rotY: r.angle, scale: [0.25, 0.02, 2.4], color: '#d8c35a' });
      }
    }
    return out;
  }, [layout]);

  return (
    <group>
      <InstancedGroup geometry={box} material={material} items={roads} />
      <InstancedGroup geometry={box} material={material} items={sidewalks} />
      <InstancedGroup geometry={box} material={material} items={dashes} />
      <RingStreets streets={layout.ringStreets} />
      <GrowingBuildings key={layout.options.planet} layout={layout} look={look} box={box} material={material} />
      <Plaza />
    </group>
  );
}

/** Buildings that rise out of the ground when they first appear and grow when the city grows. One instanced mesh for walls, one for roofs. */
function GrowingBuildings({ layout, look, box, material }: { layout: CityLayout; look: GroundLook; box: THREE.BufferGeometry; material: THREE.Material }) {
  const capacity = Math.max(1, layout.capacity);
  const walls = useMemo(() => {
    const m = new THREE.InstancedMesh(box, material, capacity);
    m.frustumCulled = false;
    return m;
  }, [box, material, capacity]);
  const roofs = useMemo(() => {
    const m = new THREE.InstancedMesh(box, material, capacity);
    m.frustumCulled = false;
    return m;
  }, [box, material, capacity]);
  useEffect(() => () => void walls.dispose(), [walls]);
  useEffect(() => () => void roofs.dispose(), [roofs]);

  const state = useRef<GrowthState>(new Map());
  const first = useRef(true);
  const moving = useRef(false);

  /** Writes every building's current look into the two meshes. */
  const draw = () => {
    const list = layout.buildings;
    list.forEach((b, i) => {
      const s = state.current.get(b.id);
      const h = s ? shownHeight(s) : 0;
      const hide = h < 0.01;
      const industrial = b.kind === 'industrial';
      setInstance(walls, i, { x: b.x, y: 0, z: b.z, rotY: b.rotY, scale: hide ? 0 : [b.w, h, b.d], color: industrial ? INDUSTRIAL.wall : look.buildings[b.paletteIndex % look.buildings.length]! });
      setInstance(roofs, i, { x: b.x, y: h, z: b.z, rotY: b.rotY, scale: hide ? 0 : [b.w + 0.4, 0.5, b.d + 0.4], color: industrial ? INDUSTRIAL.roof : '#555a63' });
    });
    for (const m of [walls, roofs]) {
      m.count = list.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  };

  // A new layout (a new population tier): the first one we see appears at once, later ones animate in.
  useLayoutEffect(() => {
    moving.current = stepGrowth(state.current, layout.buildings, 0, first.current);
    first.current = false;
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, look, walls, roofs]);

  useFrame((_, delta) => {
    if (!moving.current) return;
    moving.current = stepGrowth(state.current, layout.buildings, Math.min(delta, 0.1));
    draw();
  });

  return (
    <>
      <primitive object={walls} />
      <primitive object={roofs} />
    </>
  );
}

/** Ring streets: a flat ring of road with a sidewalk ring each side. Drawn just under the radial roads so those cross over them. */
function RingStreets({ streets }: { streets: CityLayout['ringStreets'] }) {
  const parts = useMemo(
    () =>
      streets.flatMap((st) => {
        const half = st.width / 2;
        const ring = (inner: number, outer: number, y: number, color: string) => ({ key: `${st.index}:${y}:${inner}`, geometry: new THREE.RingGeometry(inner, outer, 72).rotateX(-Math.PI / 2).translate(0, y, 0), color });
        return [
          ring(st.radius - half, st.radius + half, RING_ROAD_Y, '#3a3d44'),
          ring(st.radius - half - st.sidewalk, st.radius - half, RING_WALK_Y, '#a9adb4'),
          ring(st.radius + half, st.radius + half + st.sidewalk, RING_WALK_Y, '#a9adb4'),
        ];
      }),
    [streets],
  );
  useEffect(() => () => parts.forEach((p) => p.geometry.dispose()), [parts]);
  return (
    <>
      {parts.map((p) => (
        <mesh key={p.key} geometry={p.geometry}>
          <meshStandardMaterial color={p.color} flatShading roughness={0.95} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
        </mesh>
      ))}
    </>
  );
}

/** A round paved plaza with a stepped fountain and a central spire. */
function Plaza() {
  return (
    <group>
      <mesh position={[0, PLAZA_TOP / 2, 0]}>
        <cylinderGeometry args={[PLAZA_RADIUS, PLAZA_RADIUS, PLAZA_TOP, 32]} />
        <meshStandardMaterial color="#c9ccd2" flatShading roughness={0.95} />
      </mesh>
      <mesh position={[0, PLAZA_TOP + 0.02, 0]}>
        <cylinderGeometry args={[PLAZA_RADIUS * 0.62, PLAZA_RADIUS * 0.62, 0.04, 28]} />
        <meshStandardMaterial color="#aeb3bb" flatShading roughness={0.95} />
      </mesh>
      <mesh position={[0, PLAZA_TOP + 0.35, 0]}>
        <cylinderGeometry args={[2.6, 3, 0.7, 14]} />
        <meshStandardMaterial color="#d8dce2" flatShading roughness={0.8} />
      </mesh>
      <mesh position={[0, PLAZA_TOP + 0.62, 0]}>
        <cylinderGeometry args={[2.2, 2.2, 0.1, 14]} />
        <meshStandardMaterial color="#5fb2d8" flatShading roughness={0.3} />
      </mesh>
      <mesh position={[0, PLAZA_TOP + 2.2, 0]}>
        <coneGeometry args={[0.55, 3.6, 6]} />
        <meshStandardMaterial color="#e8ebef" flatShading roughness={0.6} />
      </mesh>
    </group>
  );
}
