import { AuthControls } from './auth';
import { EventFeed } from './components/EventFeed';
import { GodModePanel } from './components/GodModePanel';
import { MetricsPanel } from './components/MetricsPanel';
import { Scene3D } from './components/Scene3D';
import { useSnapshots } from './data/useSnapshots';

export function App() {
  const { snapshot, role, connected, mode, sendCommand, universeId, universes, selectUniverse, error, playbackPaused, setPlaybackPaused } = useSnapshots();
  return (
    <div className="app">
      <header>
        <strong>Orbital Archipelago</strong>
        <span>universe: {snapshot?.universeId ?? universeId ?? '-'}</span>
        <span>cycle: {snapshot?.cycle ?? '-'}{snapshot?.paused ? ' (paused)' : ''}</span>
        <span className={`badge ${mode}`}>{mode}</span>
        <span className={connected ? 'ok' : 'err'}>{connected ? 'connected' : 'disconnected'}</span>
        {role && <span className="muted">role: {role}</span>}
        {mode === 'fixture' && <button onClick={() => setPlaybackPaused(!playbackPaused)}>{playbackPaused ? 'Play' : 'Pause'} playback</button>}
        <span className="spacer" />
        <AuthControls />
      </header>
      {error && <p className="ack-err">{error}</p>}
      {!snapshot ? (
        <p className="muted">Waiting for data...</p>
      ) : (
        <>
          <main>
            <Scene3D snapshot={snapshot} />
            <MetricsPanel snapshot={snapshot} />
          </main>
          <EventFeed events={snapshot.events} />
          {role === 'operator' ? (
            <GodModePanel snapshot={snapshot} universes={universes} sendCommand={sendCommand} selectUniverse={selectUniverse} />
          ) : (
            mode === 'fixture' && <p className="muted">God mode is disabled: fixtures are read-only.</p>
          )}
        </>
      )}
    </div>
  );
}
