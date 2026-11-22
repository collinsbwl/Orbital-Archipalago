import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { PerspectiveCamera, Vector3 } from 'three';
import type { Snapshot } from '@orbital/contracts';
import type { FrameState } from '../scene/frame';
import { Aliens } from './AlienCrowd';
import { City } from './City';
import { CITY_FLAT_RADIUS, layoutCity, populationTier } from './city-layout';
import { Crops } from './CropFields';
import { clampAboveTerrain, clampPanTarget, GROUND_LIMITS, landingPose } from './ground-camera';
import { goodsOf, groundLookFor, sunDirection } from './ground-look';
import { Industry, useIndustryModels } from './IndustrySites';
import { industryEmitters } from './industry';
import { lifeLevels } from './life';
import { Market } from './MarketStalls';
import { layoutStalls } from './market';
import { PowerLines } from './PowerLines';
import { layoutPylons, pickRoad } from './power-line';
import { Spaceport } from './Spaceport';
import { layoutPort, portClearance } from './port';
import { PortShips } from './PortShips';
import { portTraffic } from './port-traffic';
import { Smoke } from './SmokeEmitters';
import { Vehicles } from './Vehicles';
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
  /** The latest snapshot: its confidence readings set how busy the market, roads and chimneys are, its shipments fill the spaceport, its events can blight the crops. */
  snapshot?: Snapshot;
  /** The shared frame (smooth cycle). Without it the scene uses the snapshot's whole cycle and nothing glides. */
  frame?: { current: FrameState };
  /** 0 to 1 multiplier on how many people, vehicles, stalls and puffs there are. The mood system turns it down in a storm or crisis. Default 1. */
  busyness?: number;
}

const NO_SHIPMENTS: Snapshot['shipments'] = [];
const NO_EVENTS: Snapshot['events'] = [];

/**
 * A planet's surface: gradient sky and sun, fogged terrain with hills and a mountain ring, trees, and a city with a
 * plaza, roads, buildings and aliens. On mount it lands the camera at the end of a road, looking at the plaza.
 */
export function GroundScene({ planet, population, goods, snapshot, frame, busyness = 1 }: GroundSceneProps) {
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

  // The shared frame, or a still one made from the snapshot when the caller has none.
  const still = useRef<FrameState>({ cycle: snapshot?.cycle ?? 0, planets: {} });
  still.current.cycle = snapshot?.cycle ?? 0;
  const frameRef = frame ?? still;

  const levels = lifeLevels(snapshot?.planets.find((p) => p.planet === planet)?.metrics, busyness);
  const models = useIndustryModels(terrain);
  const emitters = useMemo(() => industryEmitters(models), [models]);
  const port = useMemo(() => layoutPort(streets, terrain), [streets, terrain]);
  // Trees keep off the port as well as off fields and mines.
  const treeField = useMemo(() => ({ ...terrain, siteClearance: (x: number, z: number) => Math.min(terrain.siteClearance(x, z), portClearance(port, x, z)) }), [terrain, port]);
  const stalls = useMemo(() => layoutStalls(planet, streets.roads), [planet, streets]);
  const pylons = useMemo(() => {
    const near = terrain.sites[0] ? ([terrain.sites[0].x, terrain.sites[0].z] as [number, number]) : null;
    return layoutPylons(streets, pickRoad(streets, near, [0, port.road]), terrain);
  }, [streets, terrain, port]);
  const shipments = snapshot?.shipments ?? NO_SHIPMENTS;
  const portShips = useMemo(() => portTraffic(shipments, planet, snapshot?.cycle ?? 0, port.pads.length).length, [shipments, planet, snapshot?.cycle, port]);

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
      <Industry models={models} />
      <Smoke planet={planet} emitters={emitters} density={levels.smoke} />
      <Crops planet={planet} fields={terrain.fields} events={snapshot?.events ?? NO_EVENTS} frame={frameRef} />
      <Trees planet={planet} terrain={treeField} layout={streets} />
      <City layout={layout} look={look} />
      <Market stalls={stalls} share={levels.stalls} />
      <PowerLines pylons={pylons} />
      <Spaceport port={port} />
      <PortShips planet={planet} port={port} shipments={shipments} frame={frameRef} />
      <Vehicles planet={planet} streets={streets} port={port} traffic={levels.traffic} portShips={portShips} />
      <Aliens planet={planet} layout={layout} population={alienPopulation} busyness={levels.busyness} />
    </>
  );
}
