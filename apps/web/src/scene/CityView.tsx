import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { PlanetSnapshot } from '@orbital/contracts';
import { CITY_RADIUS, PLATEAU_TOP, ROAD_HALF_LENGTH, ROAD_HALF_WIDTH, cityCounts, cityLayout, makeWalkers, stepWalker, walkerPose } from './city';
import type { House } from './city';
import type { SurfaceSite } from './focus';
import type { PlanetLook } from './planet-look';
import { mulberry32 } from './rng';

const GRASS = '#6aa356';
const ROCK = '#7d6b58';
const ROAD = '#4a4f5a';
const WALLS = ['#ecd2aa', '#dcaea6', '#b4cde4', '#cfe0aa', '#e3d6f3'];
const ROOFS = ['#b5523a', '#8a4a3a', '#5a6a8a', '#a8642f', '#7a5a8a'];
const ALIENS = ['#7fd6a4', '#b48be8', '#6cc4e8', '#f0b46a', '#e88bb4'];

/** The floor of the city is this high above the origin of the city's own space (which sits on the planet surface). */
const FLOOR = PLATEAU_TOP;

function Plateau() {
  // A round mesa: rocky sides, a grassy top. Its lower part is buried in the planet.
  return (
    <mesh position-y={FLOOR - 0.1}>
      <cylinderGeometry args={[CITY_RADIUS, CITY_RADIUS + 0.014, 0.2, 28]} />
      <meshStandardMaterial attach="material-0" color={ROCK} flatShading />
      <meshStandardMaterial attach="material-1" color={GRASS} flatShading />
      <meshStandardMaterial attach="material-2" color={ROCK} flatShading />
    </mesh>
  );
}

function Roads() {
  const length = ROAD_HALF_LENGTH * 2 + 0.02;
  return (
    <group position-y={FLOOR + 0.0012}>
      <mesh>
        <boxGeometry args={[length, 0.0024, ROAD_HALF_WIDTH * 2]} />
        <meshStandardMaterial color={ROAD} flatShading />
      </mesh>
      <mesh>
        <boxGeometry args={[ROAD_HALF_WIDTH * 2, 0.0024, length]} />
        <meshStandardMaterial color={ROAD} flatShading />
      </mesh>
    </group>
  );
}

function HouseBlock({ house }: { house: House }) {
  const roof = Math.max(house.w, house.d) * 0.78;
  return (
    <group position={[house.x, FLOOR, house.z]}>
      <mesh position-y={house.h / 2}>
        <boxGeometry args={[house.w, house.h, house.d]} />
        <meshStandardMaterial color={WALLS[house.look % WALLS.length]} flatShading />
      </mesh>
      <mesh position-y={house.h + 0.007} rotation-y={Math.PI / 4}>
        <coneGeometry args={[roof, 0.014, 4]} />
        <meshStandardMaterial color={ROOFS[house.look % ROOFS.length]} flatShading />
      </mesh>
    </group>
  );
}

function Farm({ layout }: { layout: ReturnType<typeof cityLayout> }) {
  return (
    <>
      {layout.fields.map((f, i) => (
        <group key={i} position={[f.x, FLOOR + 0.001, f.z]}>
          <mesh>
            <boxGeometry args={[f.w, 0.002, f.d]} />
            <meshStandardMaterial color="#4f8a3f" flatShading />
          </mesh>
          {[-0.3, -0.1, 0.1, 0.3].map((k) => (
            <mesh key={k} position={[0, 0.0012, f.d * k]}>
              <boxGeometry args={[f.w * 0.9, 0.0016, f.d * 0.08]} />
              <meshStandardMaterial color="#8fbf5a" flatShading />
            </mesh>
          ))}
        </group>
      ))}
      <group position={[layout.barn.x, FLOOR, layout.barn.z]}>
        <mesh position-y={0.013}>
          <boxGeometry args={[0.04, 0.026, 0.028]} />
          <meshStandardMaterial color="#b5523a" flatShading />
        </mesh>
        <mesh position-y={0.03} rotation={[0, 0, Math.PI / 2]} scale={[1, 1, 1]}>
          <cylinderGeometry args={[0.014, 0.014, 0.04, 3]} />
          <meshStandardMaterial color="#8a3a2a" flatShading />
        </mesh>
      </group>
      <group position={[layout.silo.x, FLOOR, layout.silo.z]}>
        <mesh position-y={0.02}>
          <cylinderGeometry args={[0.009, 0.009, 0.04, 10]} />
          <meshStandardMaterial color="#cfd4da" flatShading />
        </mesh>
        <mesh position-y={0.045}>
          <coneGeometry args={[0.0105, 0.012, 10]} />
          <meshStandardMaterial color="#8a93a0" flatShading />
        </mesh>
      </group>
    </>
  );
}

function Plaza({ layout }: { layout: ReturnType<typeof cityLayout> }) {
  const { plaza, pad } = layout;
  return (
    <>
      <group position={[plaza.x, FLOOR, plaza.z]}>
        <mesh position-y={0.0016}>
          <cylinderGeometry args={[plaza.r, plaza.r, 0.0032, 20]} />
          <meshStandardMaterial color="#b9b2a0" flatShading />
        </mesh>
        <mesh position-y={0.006}>
          <cylinderGeometry args={[0.009, 0.011, 0.01, 12]} />
          <meshStandardMaterial color="#6ec6e8" flatShading />
        </mesh>
      </group>
      {/* The spaceport's landing pad. */}
      <group position={[pad.x, FLOOR, pad.z]}>
        <mesh position-y={0.0016}>
          <cylinderGeometry args={[pad.r, pad.r, 0.0032, 20]} />
          <meshStandardMaterial color="#3a3f4a" flatShading />
        </mesh>
        <mesh position-y={0.0036} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[pad.r * 0.55, pad.r * 0.7, 20]} />
          <meshBasicMaterial color="#e8c84a" />
        </mesh>
      </group>
    </>
  );
}

/** The little aliens, walking the cross-shaped road. How many, and how fast, follows the planet's numbers. */
function Aliens({ count, speed, seed }: { count: number; speed: number; seed: number }) {
  const walkers = useMemo(() => makeWalkers(count, seed), [count, seed]);
  const colors = useMemo(() => {
    const rand = mulberry32(seed ^ 0x9e3779b9);
    return walkers.map(() => ALIENS[Math.floor(rand() * ALIENS.length)]!);
  }, [walkers, seed]);
  const rand = useMemo(() => mulberry32(seed ^ 0x85ebca6b), [seed]);
  const groups = useRef<(THREE.Group | null)[]>([]);
  const pace = useRef(speed);
  pace.current = speed;

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.1); // a stalled tab must not make them leap
    walkers.forEach((w, i) => {
      stepWalker(w, step, pace.current, rand);
      const pose = walkerPose(w);
      const g = groups.current[i];
      if (!g) return;
      g.position.set(pose.x, FLOOR + 0.0014 + Math.abs(Math.sin(w.phase)) * 0.0022, pose.z); // a little hop with each step
      g.rotation.y = pose.heading;
    });
  });

  return (
    <>
      {walkers.map((_, i) => (
        <group key={i} ref={(el) => { groups.current[i] = el; }}>
          <mesh position-y={0.0085}>
            <capsuleGeometry args={[0.0042, 0.0092, 3, 6]} />
            <meshStandardMaterial color={colors[i]} flatShading />
          </mesh>
          <mesh position-y={0.0196}>
            <sphereGeometry args={[0.0048, 8, 6]} />
            <meshStandardMaterial color={colors[i]} flatShading />
          </mesh>
          <mesh position={[-0.0019, 0.0206, 0.0038]}>
            <sphereGeometry args={[0.001, 5, 4]} />
            <meshBasicMaterial color="#10141c" />
          </mesh>
          <mesh position={[0.0019, 0.0206, 0.0038]}>
            <sphereGeometry args={[0.001, 5, 4]} />
            <meshBasicMaterial color="#10141c" />
          </mesh>
          <mesh position={[0, 0.0262, 0]}>
            <cylinderGeometry args={[0.0004, 0.0004, 0.006, 4]} />
            <meshBasicMaterial color={colors[i]} />
          </mesh>
        </group>
      ))}
    </>
  );
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The little city, on the sun-facing side of the planet: a grassy mesa with a cross of roads, a plaza and fountain, houses,
 * a farm, a landing pad, and aliens walking about. It is drawn in its own space whose up is straight out of the planet.
 */
export function City({ look, data, site }: { look: PlanetLook; data: PlanetSnapshot; site: SurfaceSite }) {
  const layout = useMemo(() => cityLayout(look.seed), [look.seed]);
  const counts = cityCounts(data);
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(site.normal.x, site.normal.y, site.normal.z)), [site]);
  const origin: [number, number, number] = [site.normal.x * look.radius, site.normal.y * look.radius, site.normal.z * look.radius];
  return (
    <group position={origin} quaternion={quaternion}>
      <Plateau />
      <Roads />
      <Plaza layout={layout} />
      <Farm layout={layout} />
      {layout.houses.slice(0, counts.houses).map((h, i) => (
        <HouseBlock key={i} house={h} />
      ))}
      <Aliens count={counts.aliens} speed={counts.walkSpeed} seed={look.seed} />
    </group>
  );
}
