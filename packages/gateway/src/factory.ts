// One-stop constructor. Wires a profile to the right ModelGateway, with the
// recorder on and an optional replay source.

import type { DecisionGateway, ModelGateway, Profile } from '@orbital/contracts';
import { StubDecisionGateway, StubGateway, type StubDecisionResponder, type StubResponder } from './stub.js';
import { GeminiDecisionGateway, type GeminiDecisionGatewayConfig } from './decisions.js';
import { GeminiGateway, type GeminiGatewayConfig } from './gemini.js';
import {
  FileDecisionRecorderSink, FileRecorderSink, RecordingDecisionGateway, RecordingGateway, ReplayDecisionGateway, ReplayGateway,
  recordingPath,
} from './recorder.js';

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

export interface CreateDecisionGatewayOpts {
  /** Required for `cheap` and `full`. */
  gemini?: GeminiDecisionGatewayConfig;
  /** Required for `stub`. */
  stub?: StubDecisionResponder;
  /** If set, decision calls are appended to the same `calls.jsonl` as model calls. */
  recording?: { runsDir: string; universeId: string };
  /** If set, decisions replay from this JSONL file. */
  replayFrom?: string;
}

export function createDecisionGateway(profile: Profile, opts: CreateDecisionGatewayOpts): DecisionGateway {
  if (opts.replayFrom) return new ReplayDecisionGateway().loadFile(opts.replayFrom);
  let inner: DecisionGateway;
  if (profile === 'stub') {
    if (!opts.stub) throw new Error('stub profile needs a StubDecisionResponder');
    inner = new StubDecisionGateway(opts.stub);
  } else {
    if (!opts.gemini) throw new Error(`profile ${profile} needs a GeminiDecisionGatewayConfig`);
    inner = new GeminiDecisionGateway(opts.gemini);
  }
  if (opts.recording) {
    const sink = new FileDecisionRecorderSink(recordingPath(opts.recording.runsDir, opts.recording.universeId));
    return new RecordingDecisionGateway(inner, sink);
  }
  return inner;
}
