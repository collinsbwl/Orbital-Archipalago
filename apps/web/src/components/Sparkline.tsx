export function Sparkline({ points, width = 140, height = 36, label }: { points: ReadonlyArray<readonly [number, number]>; width?: number; height?: number; label: string }) {
  if (points.length < 2) return <svg width={width} height={height} role="img" aria-label={`${label} (no data)`} />;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const pad = 2;
  const sx = (x: number) => pad + ((x - x0) / Math.max(1, x1 - x0)) * (width - 2 * pad);
  const sy = (y: number) => (y1 === y0 ? height / 2 : height - pad - ((y - y0) / (y1 - y0)) * (height - 2 * pad));
  const d = points.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label={label}>
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
