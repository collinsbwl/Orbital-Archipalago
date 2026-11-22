import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PARTS } from './alien-rig';
import type { PartName } from './alien-rig';
import type { TreeKind } from './trees';

/** One part of a model: a geometry, where it sits, and its colour. */
interface Part {
  geo: THREE.BufferGeometry;
  color: string;
  at?: [number, number, number];
  scale?: [number, number, number];
}

/** Joins coloured parts into one flat-shaded, vertex-coloured geometry (so a whole model is one draw call). */
export function mergeParts(parts: Part[]): THREE.BufferGeometry {
  const prepared = parts.map(({ geo, color, at, scale }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (scale) g.scale(...scale);
    if (at) g.translate(...at);
    const c = new THREE.Color(color);
    const n = g.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    return g;
  });
  const merged = mergeGeometries(prepared)!;
  prepared.forEach((g) => g.dispose());
  merged.computeVertexNormals();
  return merged;
}

const cone = (r: number, h: number, seg = 6) => new THREE.ConeGeometry(r, h, seg);
const cyl = (rt: number, rb: number, h: number, seg = 6) => new THREE.CylinderGeometry(rt, rb, h, seg);
const ico = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);

/** A plant or rock model standing on y = 0, about 2 to 5 metres tall at scale 1. */
export function treeGeometry(kind: TreeKind): THREE.BufferGeometry {
  switch (kind) {
    case 'broadleaf':
      return mergeParts([
        { geo: cyl(0.2, 0.3, 1.8), color: '#6b4a2f', at: [0, 0.9, 0] },
        { geo: ico(1.5, 1), color: '#ffffff', at: [0, 2.7, 0], scale: [1, 0.85, 1] },
      ]);
    case 'conifer':
      return mergeParts([
        { geo: cyl(0.15, 0.25, 1.2), color: '#5a3d28', at: [0, 0.6, 0] },
        { geo: cone(1.5, 2.2, 7), color: '#ffffff', at: [0, 2.1, 0] },
        { geo: cone(1.1, 1.8, 7), color: '#ffffff', at: [0, 3.2, 0] },
        { geo: cone(0.7, 1.5, 7), color: '#ffffff', at: [0, 4.2, 0] },
      ]);
    case 'scrub':
      return mergeParts([
        { geo: ico(0.8, 0), color: '#ffffff', at: [0, 0.5, 0], scale: [1.2, 0.7, 1.2] },
        { geo: ico(0.55, 0), color: '#ffffff', at: [0.6, 0.35, 0.3], scale: [1, 0.7, 1] },
      ]);
    case 'rock':
      return mergeParts([
        { geo: new THREE.DodecahedronGeometry(0.9, 0), color: '#ffffff', at: [0, 0.7, 0], scale: [1.2, 0.8, 1] },
        { geo: new THREE.DodecahedronGeometry(0.5, 0), color: '#ffffff', at: [0.9, 0.45, 0.3] },
      ]);
    case 'spire':
      return mergeParts([
        { geo: cone(0.8, 5, 5), color: '#ffffff', at: [0, 2.5, 0] },
        { geo: cone(0.5, 3, 5), color: '#ffffff', at: [0.9, 1.5, 0.4] },
        { geo: cone(0.4, 2.2, 5), color: '#ffffff', at: [-0.7, 1.1, -0.5] },
      ]);
  }
}

/** Base colour per kind; each instance gets a small shade shift from this. */
export const TREE_COLORS: Record<TreeKind, string> = {
  broadleaf: '#4f9a44',
  conifer: '#2f6f46',
  scrub: '#9a8a4a',
  rock: '#8a7468',
  spire: '#cfe8f4',
};

/** The alien's parts in model space at rest (y up, faces +z), as zim-like shapes: a wedge head with huge eyes, a striped body, thin limbs. */
function alienPartSpecs(): Record<PartName, Part[]> {
  const SKIN = '#ffffff'; // tinted per instance
  const DARK = '#16161d';
  const GLOVE = '#2b2b36';
  const sq = (rt: number, rb: number, h: number) => cyl(rt, rb, h, 4).rotateY(Math.PI / 4); // a four-sided frustum with flat faces on the axes
  // Thin limbs are 3-sided tubes with no end caps (the ends are hidden in the body, a boot or a glove): a fraction of the triangles.
  const tube = (rt: number, rb: number, h: number) => new THREE.CylinderGeometry(rt, rb, h, 3, 1, true);
  const antenna = (side: 1 | -1): Part[] => {
    // Rooted on the top corner of the head, one straight stalk leaning outward.
    const lean = 0.4 * side;
    return [{ geo: tube(0.012, 0.012, 0.3).rotateZ(-lean), color: DARK, at: [0.15 * side + Math.sin(lean) * 0.15, 1.72 + Math.cos(lean) * 0.15, 0] }];
  };
  const stripe = (i: number): Part => {
    const rb = 0.2 - 0.05 * ((i * 0.15) / 0.45);
    return { geo: cyl(rb - 0.017, rb, 0.15, 6), color: i % 2 === 1 ? '#b8b8b8' : '#ffffff', at: [0, 0.72 + 0.075 + i * 0.15, 0] };
  };
  const leg = (x: number): Part[] => [
    { geo: tube(0.03, 0.025, 0.64), color: DARK, at: [x, 0.4, 0] },
    { geo: box(0.1, 0.08, 0.2), color: '#2a2a33', at: [x, 0.04, 0.04] },
  ];
  const arm = (x: number): Part[] => [
    { geo: tube(0.02, 0.02, 0.42), color: GLOVE, at: [x, 0.91, 0] },
    { geo: ico(0.04, 0), color: GLOVE, at: [x, 0.68, 0] },
  ];
  const eye = (x: number): Part[] => [
    { geo: ico(0.14, 1), color: '#d6246e', at: [x, 1.5, 0.19], scale: [1, 1.3, 0.55] },
    { geo: ico(0.045, 0), color: '#ffd0e4', at: [x - 0.03 * Math.sign(x), 1.57, 0.255] },
  ];
  return {
    legL: leg(-0.1),
    legR: leg(0.1),
    torso: [stripe(0), stripe(1), stripe(2)],
    head: [{ geo: sq(0.46, 0.22, 0.55), color: SKIN, at: [0, 1.445, 0], scale: [1, 1, 0.75] }, ...antenna(-1), ...antenna(1)],
    face: [...eye(-0.16), ...eye(0.16)],
    mouth: [{ geo: box(0.1, 0.015, 0.02), color: '#2a1520', at: [0, 1.29, 0.15] }],
    armL: arm(-0.19),
    armR: arm(0.19),
  };
}

/** The whole alien at rest in one geometry, about 2 m tall including antennae. Stands on y = 0, faces +z. */
export function alienGeometry(): THREE.BufferGeometry {
  return mergeParts(Object.values(alienPartSpecs()).flat());
}

/** Each moving part as its own geometry with its pivot at the origin (see `PARTS` for where the pivot sits on the alien). */
export function alienPartGeometries(): Record<PartName, THREE.BufferGeometry> {
  const specs = alienPartSpecs();
  const out = {} as Record<PartName, THREE.BufferGeometry>;
  for (const def of PARTS) {
    const [px, py, pz] = def.pivot;
    out[def.name] = mergeParts(specs[def.name].map((p) => ({ ...p, at: [p.at![0] - px, p.at![1] - py, p.at![2] - pz] as [number, number, number] })));
  }
  return out;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** A wheel: a short cylinder lying on its side (axis along x). */
const tyre = (r: number, width: number) => new THREE.CylinderGeometry(r, r, width, 6).rotateZ(Math.PI / 2);

/** A small car, about 4 m long, nose along +z, on y = 0. Body and cabin are white so an instance colour tints them. */
export function carGeometry(): THREE.BufferGeometry {
  const wheel = (x: number, z: number) => ({ geo: tyre(0.34, 0.3), color: '#1d1f24', at: [x, 0.34, z] as [number, number, number] });
  return mergeParts([
    { geo: box(1.9, 0.7, 4.2), color: '#ffffff', at: [0, 0.65, 0] },
    { geo: box(1.6, 0.6, 2.1), color: '#dfe6ee', at: [0, 1.25, -0.3] },
    ...[wheel(-0.95, 1.3), wheel(0.95, 1.3), wheel(-0.95, -1.3), wheel(0.95, -1.3)],
  ]);
}

/** A hauler truck, about 7 m long: a cab at the front (+z) and a big cargo box. Cab is white (tinted per instance); the box is fixed. */
export function haulerGeometry(): THREE.BufferGeometry {
  const wheel = (x: number, z: number) => ({ geo: tyre(0.45, 0.4), color: '#1d1f24', at: [x, 0.45, z] as [number, number, number] });
  return mergeParts([
    { geo: box(2.3, 1.7, 1.9), color: '#ffffff', at: [0, 1.15, 2.4] },
    { geo: box(2.1, 0.7, 0.1), color: '#9fb4c8', at: [0, 1.6, 3.4] },
    { geo: box(2.5, 2.3, 4.6), color: '#c9c2ae', at: [0, 1.6, -0.6] },
    ...[wheel(-1.2, 2.4), wheel(1.2, 2.4), wheel(-1.2, -1.6), wheel(1.2, -1.6)],
  ]);
}

/** A 1 x 1 x 1 box that sits on y = 0 (not centred), so scaling an instance by (w, h, d) stands it on the ground. */
export function groundedBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

/** Unit cylinder (diameter 1, height 1) standing on y = 0. Scale an instance by (diameter, height, diameter). */
export function groundedCylinder(segments = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.5, 0.5, 1, segments);
  g.translate(0, 0.5, 0);
  return g;
}

/** Unit cone (base diameter 1, height 1) standing on y = 0. A 4-sided one is a square pyramid (turn it 45 degrees to match a box). */
export function groundedCone(segments = 10): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.5, 1, segments);
  g.translate(0, 0.5, 0);
  return g;
}

/** Half a sphere of diameter 1 (so 0.5 tall) on y = 0, for tank lids and silo caps. Scale y by twice the height you want. */
export function groundedDome(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(0.5, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2);
}
