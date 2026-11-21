// One-stop constructor. Wires a profile to the right ModelGateway, with the
// recorder on and an optional replay source.

import type { ModelGateway, Profile } from '@orbital/contracts';
import { StubGateway, type StubResponder } from './stub.js';
import { GeminiGateway, type GeminiGatewayConfig } from './gemini.js';
import { RecordingGateway, FileRecorderSink, ReplayGateway, recordingPath } from './recorder.js';

export interface CreateGatewayOpts {
  /** Required for `cheap` and `full`. Ignored for `stub`. */
  gemini?: GeminiGatewayConfig;
  /** Required for `stub`. */
  stub?: StubResponder;
  /** If set, every call is appended to `<runsDir>/<universeId>/calls.jsonl`. */
  recording?: { runsDir: string; universeId: string };
  /** If set, invocations replay from this JSONL file instead of hitting the model. */
  replayFrom?: string;
}

export function createGateway(profile: Profile, opts: CreateGatewayOpts): ModelGateway {
  if (opts.replayFrom) {
    return new ReplayGateway().loadFile(opts.replayFrom);
  }
  let inner: ModelGateway;
  if (profile === 'stub') {
    if (!opts.stub) throw new Error('stub profile needs a StubResponder');
    inner = new StubGateway(opts.stub);
  } else {
    if (!opts.gemini) throw new Error(`profile ${profile} needs a GeminiGatewayConfig`);
    inner = new GeminiGateway(opts.gemini);
  }
  if (opts.recording) {
    const sink = new FileRecorderSink(recordingPath(opts.recording.runsDir, opts.recording.universeId));
    return new RecordingGateway(inner, sink);
  }
  return inner;
}
