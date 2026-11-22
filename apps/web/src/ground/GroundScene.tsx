import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { PerspectiveCamera, Vector3 } from 'three';
import type { Shipment, Snapshot } from '@orbital/contracts';
import type { FrameState } from '../scene/frame';
import { AlienChatter } from './AlienChatter';
import { Aliens } from './AlienCrowd';
import { Camp } from './Camp';
import { CAMP_SITE_RADIUS, isCampPlanet } from './camp-layout';
import { City } from './City';
import { CITY_FLAT_RADIUS, layoutCity, populationTier } from './city-layout';
import { Crops } from './CropFields';
import { clampAboveTerrain, clampPanTarget, clampTargetY, GROUND_LIMITS, landingPose } from './ground-camera';
import { initialAtmosphere } from './atmosphere-ref';
import type { AtmosphereState } from './atmosphere-ref';
import { Festival } from './FestivalShow';
import { goodsOf, groundLookFor } from './ground-look';
import { IceLandmarks } from './IceLandmarks';
import { Industry, useIndustryModels } from './IndustrySites';
import { streetLampPieces } from './lamps';
import { Pieces } from './PieceMeshes';
import { Precipitation } from './Precipitation';
import { SkyRig } from './SkyRig';
import type { MoodView } from './SkyRig';
import { industryEmitters } from './industry';
import { lifeLevels } from './life';
import { Market } from './MarketStalls';
import { layoutStalls } from './market';
import { PowerLines } from './PowerLines';
import { layoutPylons, pickRoad } from './power-line';
import { Spaceport } from './Spaceport';
import { layoutPort, portClearance } from './port';
import { PortShips } from './PortShips';
import { portTraffic, retainShipments } from './port-traffic';
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
  enableDamping?: boolean;
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
  /** 0 to 1 multiplier on how many people, vehicles, stalls and puffs there are, on top of the mood's own (a storm or crisis empties the streets). Default 1. */
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
  const camp = isCampPlanet(planet);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as ControlsLike | null;

  const goodsKey = (goods ?? goodsOf(planet)).join(',');
  // The city only rebuilds when the population moves to a new tier, not every cycle.
  const tier = populationTier(population);
  const layout = useMemo(() => layoutCity({ planet, population, goods: goodsKey.split(',') }), [planet, goodsKey, tier]); // eslint-disable-line react-hooks/exhaustive-deps
  // Land and trees do not change as the city grows, so they depend on the planet and goods only (not the tier).
  const terrain = useMemo(
    () => makeTerrain({ planet, goods: goodsKey.split(','), flatRadius: CITY_FLAT_RADIUS, siteRadius: camp ? CAMP_SITE_RADIUS : undefined, relief: look.relief }),
    [planet, goodsKey, look, camp],
  );
  const streets = useMemo(() => layoutCity({ planet }), [planet]);
  const lamps = useMemo(() => streetLampPieces(layout), [layout]);

  // The shared frame, or a still one made from the snapshot when the caller has none.
  const still = useRef<FrameState>({ cycle: snapshot?.cycle ?? 0, planets: {} });
  still.current.cycle = snapshot?.cycle ?? 0;
  const frameRef = frame ?? still;

  // One shared sky/light state, written each frame by SkyRig and read by the sky, weather, windows and lamps. The mood
  // reaches React only as a coarse view (busyness steps, festive on/off).
  const atmo = useRef<AtmosphereState>(null as unknown as AtmosphereState);
  if (!atmo.current) atmo.current = initialAtmosphere(look);
  const [moodView, setMoodView] = useState<MoodView>({ kind: 'calm', busyness: 1, festive: false });
  const otherPlanets = (snapshot?.planets ?? []).map((p) => p.planet).filter((id) => id !== planet).join(',');
  const planetIds = useMemo(() => (otherPlanets ? otherPlanets.split(',') : []), [otherPlanets]);

  const levels = lifeLevels(snapshot?.planets.find((p) => p.planet === planet)?.metrics, busyness * moodView.busyness);
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
  // Landed ships stay in view (parked, then lifting off again) after the engine stops reporting them.
  const shipMemory = useRef<Map<string, Shipment>>(new Map());
  const shipments = useMemo(() => {
    shipMemory.current = retainShipments(shipMemory.current, snapshot?.shipments ?? NO_SHIPMENTS, snapshot?.cycle ?? 0);
    return [...shipMemory.current.values()];
  }, [snapshot]);
  const portShips = useMemo(() => portTraffic(shipments, planet, snapshot?.cycle ?? 0, port.pads.length).length, [shipments, planet, snapshot?.cycle, port]);

  // The sky dome and far mountains need a far plane beyond the map's.
  useLayoutEffect(() => {
    const cam = camera as PerspectiveCamera;
    const [oldFar, oldNear] = [cam.far, cam.near];
    cam.far = SKY_RADIUS * 1.8;
    cam.near = Math.max(cam.near, 0.1); // the map uses a much nearer plane; on the ground that would waste depth precision
    cam.updateProjectionMatrix();
    return () => {
      cam.far = oldFar;
      cam.near = oldNear;
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

  // Each frame: keep the pan target inside the city and between the surface and a sensible height (moving the camera by
  // the same amount so the view just slides), and keep the camera above the ground or the water. Not during a
  // transition, when the view director is placing the camera itself.
  useFrame(() => {
    if (controls && !controls.enabled) return;
    if (controls) {
      const t = controls.target;
      const c = clampPanTarget(t.x, t.z, layout.radius);
      const ty = clampTargetY(terrain, c.x, t.y, c.z);
      if (c.x !== t.x || c.z !== t.z || ty !== t.y) {
        camera.position.x += c.x - t.x;
        camera.position.y += ty - t.y;
        camera.position.z += c.z - t.z;
        t.set(c.x, ty, c.z);
      }
    }
    camera.position.y = clampAboveTerrain(terrain, camera.position.x, camera.position.y, camera.position.z);
  });

  return (
    <>
      <SkyRig key={planet} planet={planet} look={look} snapshot={snapshot} frame={frameRef} atmo={atmo} onMood={setMoodView} />
      <Sky atmo={atmo} planetIds={planetIds} />
      <Precipitation kind={look.precip} atmo={atmo} />
      <Terrain terrain={terrain} look={look} />
      <WaterBodies terrain={terrain} mirror={look.style === 'crystal'} />
      {look.style === 'crystal' && <IceLandmarks planet={planet} layout={streets} terrain={terrain} port={port} atmo={atmo} />}
      <Industry models={models} />
      <Smoke planet={planet} emitters={emitters} density={levels.smoke} />
      <Crops planet={planet} fields={terrain.fields} events={snapshot?.events ?? NO_EVENTS} frame={frameRef} />
      <Trees planet={planet} terrain={treeField} layout={streets} />
      {camp ? (
        <Camp layout={layout} planet={planet} stalls={stalls} share={levels.stalls} atmo={atmo} />
      ) : (
        <>
          <City layout={layout} look={look} atmo={atmo} />
          <Pieces pieces={lamps} atmo={atmo} />
          {moodView.festive && <Festival planet={planet} layout={layout} atmo={atmo} />}
          <Market stalls={stalls} share={levels.stalls} />
          <PowerLines pylons={pylons} />
        </>
      )}
      <Spaceport port={port} atmo={atmo} />
      <PortShips planet={planet} port={port} shipments={shipments} frame={frameRef} />
      {!camp && <Vehicles planet={planet} streets={streets} port={port} traffic={levels.traffic} portShips={portShips} />}
      <Aliens planet={planet} layout={layout} />
      <AlienChatter planet={planet} layout={layout} />
    </>
  );
}
