import { useLayoutEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { PerspectiveCamera, Vector3 } from 'three';
import { Aliens } from './AlienCrowd';
import { City } from './City';
import { CITY_FLAT_RADIUS, layoutCity, populationTier } from './city-layout';
import { clampAboveTerrain, clampPanTarget, GROUND_LIMITS, landingPose } from './ground-camera';
import { goodsOf, groundLookFor, sunDirection } from './ground-look';
import { Industry } from './IndustrySites';
import { Sky, SKY_RADIUS } from './Sky';
import { makeTerrain } from './terrain';
import { Terrain } from './TerrainMesh';
import { Trees } from './Forest';
import { WaterBodies } from './WaterBodies';

export { GROUND_LIMITS };

/** The bits of OrbitControls this scene touches. */
export interface ControlsLike {
  enabled: boolean;
  target: Vector3;
  minDistance: number;
  maxDistance: number;
  maxPolarAngle: number;
  update: () => void;
}

export interface GroundSceneProps {
  planet: string;
  /** Planet population; sets building height and how many aliens walk about. */
  population?: number;
  /** Goods the planet makes. Defaults to the planet's known goods. */
  goods?: string[];
}

/**
 * A planet's surface: gradient sky and sun, fogged terrain with hills and a mountain ring, trees, and a city with a
 * plaza, roads, buildings and aliens. On mount it lands the camera at the end of a road, looking at the plaza.
 */
export function GroundScene({ planet, population, goods }: GroundSceneProps) {
  const look = groundLookFor(planet);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;

  const goodsKey = (goods ?? goodsOf(planet)).join(',');
  // The city only rebuilds when the population moves to a new tier, not every cycle.
  const tier = populationTier(population);
  const layout = useMemo(() => layoutCity({ planet, population, goods: goodsKey.split(',') }), [planet, goodsKey, tier]); // eslint-disable-line react-hooks/exhaustive-deps
  // Land and trees do not change as the city grows, so they depend on the planet and goods only (not the tier).
  const terrain = useMemo(
    () => makeTerrain({ planet, goods: goodsKey.split(','), flatRadius: CITY_FLAT_RADIUS, relief: look.relief }),
    [planet, goodsKey, look],
  );
  const streets = useMemo(() => layoutCity({ planet }), [planet]);
  const sunDir = useMemo(() => sunDirection(planet, look), [planet, look]);
  const alienPopulation = 10 ** (layout.tier / 4);

  // The sky dome and far mountains need a far plane beyond the map's.
  useLayoutEffect(() => {
    const cam = camera as PerspectiveCamera;
    const oldFar = cam.far;
    cam.far = SKY_RADIUS * 1.8;
    cam.updateProjectionMatrix();
    return () => {
      cam.far = oldFar;
      cam.updateProjectionMatrix();
    };
  }, [camera]);

  // Land at a road end, looking down it at the plaza. Only when arriving (or the planet changes), never when the city
  // rebuilds for a new population tier, or the view would jump.
  useLayoutEffect(() => {
    const pose = landingPose(layout, terrain);
    camera.position.set(...pose.position);
    if (controls) {
      controls.target.set(...pose.target);
      Object.assign(controls, GROUND_LIMITS);
    }
    camera.lookAt(...pose.target);
    controls?.update();
  }, [camera, controls, planet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each frame: keep the pan target inside the city (moving the camera by the same amount so the view just slides), and
  // keep the camera above the ground. Not during a transition, when the view director is placing the camera itself.
  useFrame(() => {
    if (controls && !controls.enabled) return;
    if (controls) {
      const t = controls.target;
      const c = clampPanTarget(t.x, t.z, layout.radius);
      if (c.x !== t.x || c.z !== t.z) {
        camera.position.x += c.x - t.x;
        camera.position.z += c.z - t.z;
        t.x = c.x;
        t.z = c.z;
      }
    }
    camera.position.y = clampAboveTerrain(terrain, camera.position.x, camera.position.y, camera.position.z);
  });

  return (
    <>
      <color attach="background" args={[look.sky]} />
      <fog attach="fog" args={[look.sky, look.fogNear, look.fogFar]} />
      <Sky look={look} sunDir={sunDir} />
      <hemisphereLight args={[look.skyTop, look.ground, 0.85]} />
      <directionalLight position={[sunDir[0] * 200, sunDir[1] * 200, sunDir[2] * 200]} color={look.sunColor} intensity={1.5} />
      <Terrain terrain={terrain} look={look} />
      <WaterBodies terrain={terrain} />
      <Industry terrain={terrain} />
      <Trees planet={planet} terrain={terrain} layout={streets} />
      <City layout={layout} look={look} />
      <Aliens planet={planet} layout={layout} population={alienPopulation} />
    </>
  );
}
