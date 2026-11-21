// StubGateway: a ModelGateway that never talks to a model.
// Used by the `stub` profile, tests, and B1 before GeminiGateway lands.

import type { GatewayRequest, GatewayResult, ModelGateway, Usage } from '@orbital/contracts';

export type StubResponder = (req: GatewayRequest) => unknown | Promise<unknown>;

const ZERO_USAGE: Usage = {
  model: 'stub',
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyMs: 0,
};

export class StubGateway implements ModelGateway {
  constructor(private readonly respond: StubResponder) {}

  async invoke(req: GatewayRequest, signal: AbortSignal): Promise<GatewayResult> {
    if (signal.aborted) return { ok: false, failure: 'timeout', message: 'aborted before invoke' };
    try {
      const output = await this.respond(req);
      if (signal.aborted) return { ok: false, failure: 'timeout', message: 'aborted during invoke' };
      return { ok: true, output, usage: { ...ZERO_USAGE }, turns: 1 };
    } catch (err) {
      return {
        ok: false,
        failure: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
