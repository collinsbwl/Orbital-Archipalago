// Per-model limiter: semaphore for in-flight requests + token buckets for RPM,
// input TPM and output TPM. One Limiter per model; one gateway instance shares
// its Limiters with every universe (architecture.md §3.6).

export interface LimiterConfig {
  /** Max in-flight requests on this model. */
  concurrency: number;
  /** Requests per minute. */
  rpm: number;
  /** Input tokens per minute (prompt bytes). */
  inputTpm: number;
  /** Output tokens per minute (completion + thinking). */
  outputTpm: number;
}

interface Bucket {
  capacity: number;
  tokens: number;
  lastRefillMs: number;
}

function refill(b: Bucket, nowMs: number): void {
  const elapsed = nowMs - b.lastRefillMs;
  if (elapsed <= 0) return;
  // Refill is `capacity` tokens per minute.
  const add = (elapsed / 60_000) * b.capacity;
  b.tokens = Math.min(b.capacity, b.tokens + add);
  b.lastRefillMs = nowMs;
}

function take(b: Bucket, amount: number, nowMs: number): number {
  refill(b, nowMs);
  if (b.tokens >= amount) {
    b.tokens -= amount;
    return 0;
  }
  const missing = amount - b.tokens;
  // ms until the bucket has `amount`.
  return Math.ceil((missing / b.capacity) * 60_000);
}

export interface LimiterTicket {
  /** Caller invokes this once the request completes (success or failure). */
  release(actual?: { outputTokens?: number }): void;
}

export class Limiter {
  private readonly cfg: LimiterConfig;
  private readonly req: Bucket;
  private readonly inTok: Bucket;
  private readonly outTok: Bucket;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(cfg: LimiterConfig, now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
    const t = now();
    this.req = { capacity: cfg.rpm, tokens: cfg.rpm, lastRefillMs: t };
    this.inTok = { capacity: cfg.inputTpm, tokens: cfg.inputTpm, lastRefillMs: t };
    this.outTok = { capacity: cfg.outputTpm, tokens: cfg.outputTpm, lastRefillMs: t };
  }

  /**
   * Acquire a slot and reserve the estimated tokens. Rejects if `signal` fires.
   * Reserved output tokens are refunded on `release({ outputTokens })` if the
   * caller completed with fewer than estimated.
   */
  async acquire(
    est: { inputTokens: number; outputTokens: number },
    signal: AbortSignal,
  ): Promise<LimiterTicket> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');

    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      while (true) {
        const nowMs = this.now();
        if (this.inFlight < this.cfg.concurrency) {
          const waitReq = take(this.req, 1, nowMs);
          const waitIn = take(this.inTok, est.inputTokens, nowMs);
          const waitOut = take(this.outTok, est.outputTokens, nowMs);
          const wait = Math.max(waitReq, waitIn, waitOut);
          if (wait <= 0) {
            this.inFlight++;
            let released = false;
            const release: LimiterTicket['release'] = (actual) => {
              if (released) return;
              released = true;
              this.inFlight--;
              // Refund over-reserved output tokens.
              if (actual && typeof actual.outputTokens === 'number') {
                const overshoot = est.outputTokens - actual.outputTokens;
                if (overshoot > 0) {
                  this.outTok.tokens = Math.min(
                    this.outTok.capacity,
                    this.outTok.tokens + overshoot,
                  );
                }
              }
              const next = this.waiters.shift();
              if (next) next();
            };
            return { release };
          }
          // Not enough tokens — restore and wait.
          await Promise.race([sleep(wait, signal), abortPromise]);
          continue;
        }
        // At concurrency cap — queue.
        await Promise.race([
          new Promise<void>((resolve) => this.waiters.push(resolve)),
          abortPromise,
        ]);
      }
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
