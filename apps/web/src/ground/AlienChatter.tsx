import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { chatterLine, distanceFade, HEAD_CLEARANCE, stopIndex, turnFade, turnIndex } from './alien-chatter';
import { alienCount, alienPose, isConversing, makeAliens } from './aliens';
import type { AlienSpec } from './aliens';
import type { CityLayout, Loop } from './city-layout';

/** Html's own wrapper ignores the pointer; only the bubble takes it, so hovering reveals the English but drags still orbit. */
const PASS_THROUGH = { pointerEvents: 'none' } as const;
const Z_RANGE: [number, number] = [20, 0];
const scratch = new THREE.Vector3();

/**
 * Speech bubbles over the aliens' talking pairs, written in the Standard Galactic Alphabet. A bubble shows while a pair are
 * stopped to chat, sits over whichever one is speaking, and fades across as they take turns. Rebuilds the same seeded crowd
 * as `Aliens`, so the bubbles follow the very walkers drawn there.
 */
export function AlienChatter({ planet, layout }: { planet: string; layout: CityLayout }) {
  const pairs = useMemo(() => {
    const specs = makeAliens(layout.gatherLoops, alienCount(), planet);
    const out: [AlienSpec, AlienSpec][] = [];
    for (let i = 0; i + 1 < specs.length; i++) {
      if (specs[i]!.role === 1 && specs[i + 1]!.role === -1) out.push([specs[i]!, specs[++i]!]);
    }
    return out;
  }, [layout, planet]);

  return (
    <group>
      {pairs.map(([a, b], k) => (
        <ChatBubble key={k} planet={planet} loops={layout.gatherLoops} pairIndex={k} a={a} b={b} />
      ))}
    </group>
  );
}

interface BubbleProps {
  planet: string;
  loops: Loop[];
  pairIndex: number;
  /** The pair's first member (`role` +1), who speaks on even turns, and its partner. */
  a: AlienSpec;
  b: AlienSpec;
}

/** One pair's bubble. Moved and refilled straight on the DOM every frame, so it never re-renders React. */
function ChatBubble({ planet, loops, pairIndex, a, b }: BubbleProps) {
  const group = useRef<THREE.Group>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const shown = useRef('');

  useFrame(({ clock, camera }) => {
    const g = group.current;
    const el = bubble.current;
    const span = text.current;
    if (!g || !el || !span) return;
    const t = clock.elapsedTime;
    // Both members stop and start together, so the first member's pose says whether the pair is talking.
    const first = alienPose(loops, a, t);
    if (!isConversing(first)) {
      if (el.style.display !== 'none') el.style.display = 'none';
      return;
    }
    const turn = turnIndex(t, a);
    const speakerIsFirst = turn % 2 === 0;
    const spec = speakerIsFirst ? a : b;
    const pose = speakerIsFirst ? first : alienPose(loops, b, t);
    g.position.set(pose.x, HEAD_CLEARANCE * spec.scale + pose.bob, pose.z);

    const opacity = first.talk * turnFade(t, a) * distanceFade(camera.position.distanceTo(g.getWorldPosition(scratch)));
    if (opacity < 0.01) {
      if (el.style.display !== 'none') el.style.display = 'none';
      return;
    }
    if (el.style.display === 'none') el.style.display = '';
    el.style.opacity = opacity.toFixed(2);

    const stop = stopIndex(t, a);
    const key = `${stop}:${turn}`;
    if (shown.current !== key) {
      shown.current = key;
      span.textContent = chatterLine(planet, pairIndex, stop, turn);
    }
  });

  return (
    <group ref={group}>
      <Html zIndexRange={Z_RANGE} style={PASS_THROUGH}>
        <div ref={bubble} className="alien-chat" style={{ display: 'none' }}>
          <span ref={text} />
        </div>
      </Html>
    </group>
  );
}
