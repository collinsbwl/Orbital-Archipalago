import { useState } from 'react';
import { GodModeCommandSchema, SHOCK_TYPES } from '@orbital/contracts';
import type { GodModeCommand, Snapshot, UniverseId } from '@orbital/contracts';
import type { CommandAck } from '../data/types';

export interface GodModePanelProps {
  snapshot: Snapshot;
  universes: UniverseId[];
  sendCommand: (universeId: UniverseId, command: GodModeCommand) => Promise<CommandAck>;
  selectUniverse: (id: UniverseId) => void;
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return <select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select>;
}

export function GodModePanel({ snapshot, universes, sendCommand, selectUniverse }: GodModePanelProps) {
  const planets = snapshot.planets.map((p) => p.planet);
  const goods = Object.keys(snapshot.planets[0]?.prices ?? {});
  const [planet, setPlanet] = useState(planets[0] ?? '');
  const [target, setTarget] = useState(planets[1] ?? '');
  const [good, setGood] = useState(goods[0] ?? '');
  const [shock, setShock] = useState<string>(SHOCK_TYPES[0]);
  const [magnitudeBp, setMagnitudeBp] = useState(-3000);
  const [durationCycles, setDuration] = useState(10);
  const [rateBp, setRateBp] = useState(500);
  const [active, setActive] = useState(true);
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<{ text: string; ok: boolean; forked?: UniverseId } | null>(null);

  const run = async (raw: unknown) => {
    const parsed = GodModeCommandSchema.safeParse(raw);
    if (!parsed.success) return setResult({ ok: false, text: `invalid: ${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}` });
    const ack = await sendCommand(snapshot.universeId, parsed.data);
    setResult({
      ok: ack.ok,
      text: ack.ok ? (ack.forkedUniverseId ? `ok, forked universe ${ack.forkedUniverseId}` : 'ok') : `error: ${ack.error ?? 'unknown'}`,
      ...(ack.forkedUniverseId ? { forked: ack.forkedUniverseId } : {}),
    });
  };
  const submit = (command: unknown) => (e: React.FormEvent) => {
    e.preventDefault();
    void run(command);
  };
  const num = (set: (n: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => set(Number(e.target.value));

  return (
    <section className="god-panel">
      <h2>God mode</h2>
      <div className="row">
        <label>Universe <Select value={snapshot.universeId} onChange={selectUniverse} options={universes.includes(snapshot.universeId) ? universes : [snapshot.universeId, ...universes]} /></label>
        <label>Planet <Select value={planet} onChange={setPlanet} options={planets} /></label>
        <label>Good <Select value={good} onChange={setGood} options={goods} /></label>
      </div>
      <form className="row" onSubmit={submit({ kind: 'shock', planet, shock, good, magnitudeBp, durationCycles })}>
        <strong>Shock</strong>
        <Select value={shock} onChange={setShock} options={[...SHOCK_TYPES]} />
        <label>bp <input type="number" value={magnitudeBp} onChange={num(setMagnitudeBp)} /></label>
        <label>cycles <input type="number" value={durationCycles} onChange={num(setDuration)} /></label>
        <button type="submit">Apply shock</button>
      </form>
      <form className="row" onSubmit={submit({ kind: 'tariff', planet, good, rateBp })}>
        <strong>Tariff</strong>
        <label>bp <input type="number" value={rateBp} onChange={num(setRateBp)} /></label>
        <button type="submit">Set tariff</button>
      </form>
      <form className="row" onSubmit={submit({ kind: 'embargo', planet, target, active })}>
        <strong>Embargo</strong>
        <label>target <Select value={target} onChange={setTarget} options={planets} /></label>
        <label><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> active</label>
        <button type="submit">Set embargo</button>
      </form>
      <form className="row" onSubmit={submit({ kind: 'policy_rate', planet, rateBp })}>
        <strong>Policy rate</strong>
        <label>bp <input type="number" value={rateBp} onChange={num(setRateBp)} /></label>
        <button type="submit">Set rate</button>
      </form>
      <form className="row" onSubmit={submit({ kind: 'fork', ...(label ? { label } : {}) })}>
        <strong>Fork</strong>
        <input placeholder="label (optional)" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit">Fork universe</button>
      </form>
      <div className="row">
        <strong>Run</strong>
        <button onClick={() => void run({ kind: snapshot.paused ? 'resume' : 'pause' })}>{snapshot.paused ? 'Resume' : 'Pause'}</button>
      </div>
      {result && (
        <p className={result.ok ? 'ack-ok' : 'ack-err'} role="status">
          {result.text}{' '}
          {result.forked && <button onClick={() => selectUniverse(result.forked as string)}>Switch to {result.forked}</button>}
        </p>
      )}
    </section>
  );
}
