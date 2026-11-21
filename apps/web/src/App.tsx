import { useState } from 'react';
import { AuthControls } from './auth';
import { EventFeed } from './components/EventFeed';
import { GodModePanel } from './components/GodModePanel';
import { MetricsPanel } from './components/MetricsPanel';
import { Panel } from './components/Panel';
import { PlanetLegend } from './components/PlanetLegend';
import { PlaybackControls } from './components/PlaybackControls';
import { Scene3D } from './components/Scene3D';
import { useSnapshots } from './data/useSnapshots';

/** Wide enough for the panels to sit beside the scene. In a narrow window they start folded so the scene stays visible. */
const isWide = () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 901px)').matches;

export function App() {
  const [wide] = useState(isWide);
  const {
    snapshot, role, connected, mode, sendCommand, universeId, universes, selectUniverse, error, playbackPaused, setPlaybackPaused,
    playbackSpeed, setPlaybackSpeed,
  } = useSnapshots();
  // Hold the scene still while playback is paused or the engine itself is paused.
  const frozen = playbackPaused || (snapshot?.paused ?? false);
  return (
    <div className="app">
      <div className="scene-layer">{snapshot && <Scene3D snapshot={snapshot} frozen={frozen} />}</div>
      <div className="hud">
        <header className="hud-top glass">
          <strong>Orbital Archipelago</strong>
          <span>universe: {snapshot?.universeId ?? universeId ?? '-'}</span>
          <span>cycle: {snapshot?.cycle ?? '-'}{snapshot?.paused ? ' (paused)' : ''}</span>
          <span className={`badge ${mode}`}>{mode}</span>
          <span className={connected ? 'ok' : 'err'}>{connected ? 'connected' : 'disconnected'}</span>
          {role && <span className="muted">role: {role}</span>}
          <span className="spacer" />
          <AuthControls />
        </header>
        {error && <p className="ack-err glass hud-note">{error}</p>}
        {!snapshot ? (
          <p className="muted glass hud-note">Waiting for data...</p>
        ) : (
          <>
            <div className="hud-left">
              <Panel title="Planets and charts" defaultOpen={false}>
                <MetricsPanel snapshot={snapshot} />
              </Panel>
            </div>
            <div className="hud-right">
              <Panel title="Events" defaultOpen={wide}>
                <EventFeed events={snapshot.events} />
              </Panel>
              {role === 'operator' ? (
                <Panel title="Operator controls" defaultOpen={false}>
                  <GodModePanel snapshot={snapshot} universes={universes} sendCommand={sendCommand} selectUniverse={selectUniverse} />
                </Panel>
              ) : (
                mode === 'fixture' && <p className="muted glass hud-note">God mode is disabled: fixtures are read-only.</p>
              )}
            </div>
            <div className="hud-bottom">
              <PlanetLegend snapshot={snapshot} />
              {mode === 'fixture' && (
                <PlaybackControls playbackPaused={playbackPaused} setPlaybackPaused={setPlaybackPaused} playbackSpeed={playbackSpeed} setPlaybackSpeed={setPlaybackSpeed} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
