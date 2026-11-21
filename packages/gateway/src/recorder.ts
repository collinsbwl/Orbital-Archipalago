// Recorder and ReplayGateway (architecture.md §3.7). Every gateway call is
// written to runs/<universe>/calls.jsonl keyed by (cycle, agentId, turn), with
// enough information to reproduce the call. ReplayGateway loads the file into
// a map and returns the recorded result; ForkGateway replays the parent's
// calls up to a fork cycle and goes live after it.

import type { AgentId, GatewayRequest, GatewayResult, ModelGateway } from '@orbital/contracts';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RecorderRow {
  cycle: number;
  agentId: AgentId;
  /** Sub-step within a cycle: tool loops bump this; structured mode is always 0. */
  turn: number;
  universeId: string;
  /** Snapshot of the request, minus the `runTool` closure (not serialisable). */
  request: Omit<GatewayRequest, 'runTool'>;
  result: GatewayResult;
}

/** Strip non-serialisable fields from a request before writing. */
export function serialisableRequest(req: GatewayRequest): Omit<GatewayRequest, 'runTool'> {
  const { runTool: _runTool, ...rest } = req;
  return rest;
}

/** Writes JSONL rows for every call. Pass to `RecordingGateway`. */
export interface RecorderSink {
  write(row: RecorderRow): void;
  close?(): void;
}

export class FileRecorderSink implements RecorderSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
  }
  write(row: RecorderRow): void {
    appendFileSync(this.path, JSON.stringify(row) + '\n');
  }
}

/** For tests. */
export class MemoryRecorderSink implements RecorderSink {
  readonly rows: RecorderRow[] = [];
  write(row: RecorderRow): void {
    this.rows.push(row);
  }
}

export function recordingPath(runsDir: string, universeId: string): string {
  return join(runsDir, universeId, 'calls.jsonl');
}

export class RecordingGateway implements ModelGateway {
  private readonly turnCounter = new Map<string, number>();

  constructor(private readonly inner: ModelGateway, private readonly sink: RecorderSink) {}

  async invoke(req: GatewayRequest, signal: AbortSignal): Promise<GatewayResult> {
    const result = await this.inner.invoke(req, signal);
    const key = `${req.universeId}:${req.cycle}:${req.agentId}`;
    const turn = this.turnCounter.get(key) ?? 0;
    this.turnCounter.set(key, turn + 1);
    this.sink.write({
      cycle: req.cycle,
      agentId: req.agentId,
      turn,
      universeId: req.universeId,
      request: serialisableRequest(req),
      result,
    });
    return result;
  }
}

export class ReplayGateway implements ModelGateway {
  private readonly rows = new Map<string, RecorderRow>();
  private readonly turnCounter = new Map<string, number>();

  constructor(private readonly loader?: () => Iterable<RecorderRow>) {}

  /** Load rows from a JSONL file. Missing file → empty replay (every call misses). */
  loadFile(path: string): this {
    if (!existsSync(path)) return this;
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as RecorderRow;
      this.rows.set(keyOf(row), row);
    }
    return this;
  }

  /** Load rows from an iterable (tests). */
  loadRows(rows: Iterable<RecorderRow>): this {
    for (const row of rows) this.rows.set(keyOf(row), row);
    return this;
  }

  async invoke(req: GatewayRequest, _signal: AbortSignal): Promise<GatewayResult> {
    if (this.loader && this.rows.size === 0) this.loadRows(this.loader());
    const callKey = `${req.universeId}:${req.cycle}:${req.agentId}`;
    const turn = this.turnCounter.get(callKey) ?? 0;
    this.turnCounter.set(callKey, turn + 1);
    const row = this.rows.get(`${req.universeId}:${req.cycle}:${req.agentId}:${turn}`);
    if (!row) return { ok: false, failure: 'error', message: `no recorded call for ${callKey} turn ${turn}` };
    return row.result;
  }
}

function keyOf(row: RecorderRow): string {
  return `${row.universeId}:${row.cycle}:${row.agentId}:${row.turn}`;
}

/** Replay the parent run up to `forkCycle`, then switch to the live gateway (architecture.md §3.7). */
export class ForkGateway implements ModelGateway {
  constructor(
    private readonly parent: ModelGateway,
    private readonly live: ModelGateway,
    private readonly forkCycle: number,
  ) {}
  invoke(req: GatewayRequest, signal: AbortSignal): Promise<GatewayResult> {
    return req.cycle < this.forkCycle
      ? this.parent.invoke(req, signal)
      : this.live.invoke(req, signal);
  }
}
