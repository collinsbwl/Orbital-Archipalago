import { useTweenedList } from './motion';

/** A small line chart. When a point is added the axes glide to their new range, so the line slides instead of jumping. */
export function Sparkline({ points, width = 140, height = 36, label }: { points: ReadonlyArray<readonly [number, number]>; width?: number; height?: number; label: string }) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const bounds = points.length < 2 ? [] : [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [x0 = 0, x1 = 0, y0 = 0, y1 = 0] = useTweenedList(bounds);
  if (points.length < 2) return <svg width={width} height={height} role="img" aria-label={`${label} (no data)`} />;
  const pad = 2;
  const sx = (x: number) => pad + ((x - x0) / Math.max(1, x1 - x0)) * (width - 2 * pad);
  const sy = (y: number) => (y1 === y0 ? height / 2 : height - pad - ((y - y0) / (y1 - y0)) * (height - 2 * pad));
  const d = points.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="sparkline">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
