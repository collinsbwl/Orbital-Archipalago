// Shared plumbing for the Gemini gateways: typed errors, deadline signals and
// the 429/5xx retry loop. GeminiGateway and GeminiDecisionGateway both use it.

import type { GatewayFailure } from '@orbital/contracts';

export interface RetriableError extends Error {
  retriable: boolean;
  /** HTTP-ish classification for mapping onto GatewayFailure. */
  kind: Extract<GatewayFailure, 'rate_limited' | 'error' | 'refused' | 'invalid_output'>;
}

export function mkError(kind: RetriableError['kind'], retriable: boolean, message: string): RetriableError {
  const err = new Error(message) as RetriableError;
  err.kind = kind;
  err.retriable = retriable;
  return err;
}

export function isTypedError(err: unknown): err is RetriableError {
  return err instanceof Error && typeof (err as RetriableError).retriable === 'boolean' && 'kind' in err;
}

/** Block codes the Decisions API returns on HTTP 400 for filtered input. */
const BLOCK_CODES = new Set(['safety', 'prohibited_content', 'blocklist', 'image_safety']);

export function classifyError(err: unknown): RetriableError {
  if (isTypedError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  const anyErr = err as { status?: number; code?: number; name?: string; error?: unknown } | null;
  const status = anyErr?.status ?? anyErr?.code ?? 0;
  if (anyErr?.name === 'AbortError' || anyErr?.name === 'TimeoutError') {
    return mkError('error', false, message);
  }
  if (status === 429) return mkError('rate_limited', true, message);
  if (status >= 500 && status < 600) return mkError('error', true, message);
  if (status === 400 && BLOCK_CODES.has(errorCode(anyErr?.error) ?? '')) return mkError('refused', false, message);
  // Explicit safety markers from SDK errors we might see.
  if (/safety|blocked|prohibited/i.test(message)) return mkError('refused', false, message);
  return mkError('error', false, message);
}

/** Pull `code` out of `{code}` or `{error: {code}}` error bodies. */
function errorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as { code?: unknown; error?: { code?: unknown } };
  const code = b.code ?? b.error?.code;
  return typeof code === 'string' ? code.toLowerCase() : undefined;
}

export function isAbort(err: unknown, mySignal: AbortSignal, callerSignal: AbortSignal): boolean {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true;
  return mySignal.aborted || callerSignal.aborted;
}

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Caller signal + per-task deadline, combined. Always call `cleanup`. */
export function combinedSignal(caller: AbortSignal, deadlineMs: number): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  if (caller.aborted) ctrl.abort(caller.reason);
  const onCaller = () => ctrl.abort(caller.reason);
  caller.addEventListener('abort', onCaller);
  const timer = setTimeout(() => ctrl.abort(new DOMException('deadline', 'TimeoutError')), Math.max(0, deadlineMs));
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      caller.removeEventListener('abort', onCaller);
    },
  };
}

/** Retry 429/5xx with jittered backoff while the signal (deadline) still allows it. */
export async function withRetries<T>(fn: () => Promise<T>, signal: AbortSignal, maxRetries: number): Promise<T> {
  let lastErr: RetriableError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal.aborted) throw mkError('error', false, 'aborted');
    try {
      return await fn();
    } catch (err) {
      const typed = classifyError(err);
      lastErr = typed;
      if (!typed.retriable || attempt === maxRetries) throw typed;
      const backoff = Math.min(2_000, 2 ** attempt * 100) + Math.floor(Math.random() * 100);
      try {
        await sleepWithAbort(backoff, signal);
      } catch {
        throw mkError('error', false, 'aborted during backoff');
      }
    }
  }
  // Unreachable because the loop throws.
  throw lastErr ?? mkError('error', false, 'unknown');
}
