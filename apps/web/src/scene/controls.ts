/** The few OrbitControls fields the map and ground scenes touch. */
export interface OrbitLike {
  enabled: boolean;
  enableDamping?: boolean;
  update: () => void;
}

/**
 * Throws away any leftover damping momentum. With damping on, the controls keep sliding after a drag; if the camera was
 * placed by hand (or the controls were switched off mid-slide), that stored motion would resume and make the view drift.
 * One update with damping off applies and zeroes it.
 */
export function settleControls(controls: OrbitLike): void {
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = damping ?? true;
}
