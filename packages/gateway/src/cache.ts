// Explicit context-caching layout (architecture.md §3.5).
//
// One cache per (model, role, planet, cycle) holds tools + frozen system text +
// planet-cycle context. 30 colonists on a planet then reference it. A
// longer-lived role cache for (model, role) holds system + tools only.
//
// Single-flight is the whole point: without it, 30 parallel callers each build
// the prefix and pay for it. Here concurrent callers in the same group await
// the same promise.

import type { ToolDeclaration } from '@orbital/contracts';
import type { Role } from '@orbital/contracts';
import { createHash } from 'node:crypto';

/** Minimal surface the GeminiGateway needs from the Google SDK's caches client. */
export interface CacheCreateArgs {
  model: string;
  systemInstruction: string;
  tools: ToolDeclaration[];
  /** Optional planet/cycle context text. Role-level caches pass an empty string. */
  context: string;
  ttlSeconds: number;
}

export interface CacheClient {
  create(args: CacheCreateArgs): Promise<{ name: string }>;
}

export interface CacheLookupArgs {
  model: string;
  role: Role;
  planet: string;
  cycle: number;
  prefix: { system: string; tools: ToolDeclaration[] };
  /** Planet/cycle text, uncached when `scope: 'role'`. */
  context: string;
}

export interface CacheRecord {
  name: string;
  tokens: number;
}

export interface CacheManagerConfig {
  client: CacheClient;
  /** Below this, Gemini refuses to cache. DEFAULT: 1024 tokens (gemini-2.5). */
  minTokens?: number;
  /** TTL seconds for planet/cycle caches. DEFAULT: 300 (matches §3.5). */
  planetCycleTtlSec?: number;
  /** TTL seconds for role-level caches. DEFAULT: 3600 (reused across planets and cycles). */
  roleTtlSec?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Recreate a cache this long before its server-side TTL ends. DEFAULT: 30 s. */
  expirySafetySec?: number;
  /** Optional observer for cache hits/misses. */
  onEvent?: (ev: { kind: 'created' | 'hit' | 'skipped' | 'warning'; key: string; detail?: string }) => void;
}

/** Sort tool declarations by name so the byte stream is stable across callers. */
export function sortedTools(tools: ToolDeclaration[]): ToolDeclaration[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Cheap digit-based lint: a system prefix must not carry cycle numbers or ISO timestamps. */
export function lintPrefix(system: string): string[] {
  const warnings: string[] = [];
  if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(system)) {
    warnings.push('system prefix contains an ISO timestamp; move it to the context block');
  }
  if (/\bcycle[\s:#=]*\d+/i.test(system)) {
    warnings.push('system prefix mentions a cycle number; move it to the context block');
  }
  return warnings;
}

interface InFlight {
  record: Promise<CacheRecord | null>;
  /** Local expiry (ms epoch); past this the entry is recreated instead of reused. */
  expiresAt: number;
}

/** Rough token count of everything a cache holds: system text, tool declarations, context. */
export function estimateCacheTokens(system: string, tools: ToolDeclaration[], context: string): number {
  const toolChars = tools.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.parameters).length, 0);
  return Math.ceil((system.length + toolChars + context.length) / 4);
}

export class CacheManager {
  private readonly client: CacheClient;
  private readonly minTokens: number;
  private readonly planetCycleTtlSec: number;
  private readonly roleTtlSec: number;
  private readonly onEvent: CacheManagerConfig['onEvent'];
  private readonly now: () => number;
  private readonly safetyMs: number;
  private readonly planetCycle = new Map<string, InFlight>();
  private readonly roleLevel = new Map<string, InFlight>();
  /** Per-cycle cached-token tally, used by the "zero hits" warning. */
  private readonly cycleHits = new Map<string, number>();

  constructor(cfg: CacheManagerConfig) {
    this.client = cfg.client;
    this.minTokens = cfg.minTokens ?? 1024;
    this.planetCycleTtlSec = cfg.planetCycleTtlSec ?? 300;
    this.roleTtlSec = cfg.roleTtlSec ?? 3600;
    this.onEvent = cfg.onEvent;
    this.now = cfg.now ?? Date.now;
    this.safetyMs = (cfg.expirySafetySec ?? 30) * 1000;
  }

  /** A live (not locally expired) entry, or undefined. Expired entries are dropped. */
  private live(map: Map<string, InFlight>, key: string): InFlight | undefined {
    const e = map.get(key);
    if (!e) return undefined;
    if (this.now() < e.expiresAt) return e;
    map.delete(key);
    return undefined;
  }

  private expiry(ttlSec: number): number {
    return this.now() + Math.max(0, ttlSec * 1000 - this.safetyMs);
  }

  /** Planet-cycle cache. Single-flight: concurrent callers in a group share one create(). */
  async getOrCreatePlanetCycle(args: CacheLookupArgs): Promise<CacheRecord | null> {
    const key = this.planetCycleKey(args);
    const existing = this.live(this.planetCycle, key);
    if (existing) {
      this.onEvent?.({ kind: 'hit', key });
      return existing.record;
    }
    const promise = this.createOrSkip({
      model: args.model,
      systemInstruction: args.prefix.system,
      tools: sortedTools(args.prefix.tools),
      context: args.context,
      ttlSeconds: this.planetCycleTtlSec,
      eventKey: key,
    }).then((rec) => {
      if (rec) {
        const tally = this.cycleHits.get(args.role + ':' + args.cycle) ?? 0;
        this.cycleHits.set(args.role + ':' + args.cycle, tally + rec.tokens);
      }
      return rec;
    });
    this.planetCycle.set(key, { record: promise, expiresAt: this.expiry(this.planetCycleTtlSec) });
    return promise;
  }

  /**
   * Role-level cache: system + tools only, longer TTL, reused across planets and cycles.
   * Keyed by the prefix content too, so a role whose tools differ by cycle (a government's
   * submit_turn schema on policy cycles) gets one cache per variant, never a stale one.
   */
  async getOrCreateRole(args: Omit<CacheLookupArgs, 'planet' | 'cycle' | 'context'>): Promise<CacheRecord | null> {
    const key = `${args.model}:${args.role}:${prefixHash(args.prefix)}`;
    const existing = this.live(this.roleLevel, key);
    if (existing) {
      this.onEvent?.({ kind: 'hit', key });
      return existing.record;
    }
    const promise = this.createOrSkip({
      model: args.model,
      systemInstruction: args.prefix.system,
      tools: sortedTools(args.prefix.tools),
      context: '',
      ttlSeconds: this.roleTtlSec,
      eventKey: key,
    });
    this.roleLevel.set(key, { record: promise, expiresAt: this.expiry(this.roleTtlSec) });
    return promise;
  }

  /** End-of-cycle hook: Track A calls this so roles with zero hits trip a warning. */
  reportCycle(cycle: number, roles: Role[]): void {
    for (const role of roles) {
      const key = role + ':' + cycle;
      const hits = this.cycleHits.get(key) ?? 0;
      if (hits === 0) {
        this.onEvent?.({ kind: 'warning', key, detail: `role ${role} got zero cached tokens for cycle ${cycle}` });
      }
      this.cycleHits.delete(key);
    }
  }

  private planetCycleKey(args: CacheLookupArgs): string {
    const hash = createHash('sha256');
    hash.update(args.model + '\n');
    hash.update(args.role + '\n');
    hash.update(args.planet + '\n');
    hash.update(String(args.cycle) + '\n');
    hash.update(args.prefix.system + '\n');
    for (const t of sortedTools(args.prefix.tools)) hash.update(t.name + '|' + JSON.stringify(t.parameters) + '\n');
    hash.update(args.context);
    return hash.digest('hex').slice(0, 32);
  }

  private async createOrSkip(
    args: CacheCreateArgs & { eventKey: string },
  ): Promise<CacheRecord | null> {
    const warnings = lintPrefix(args.systemInstruction);
    for (const w of warnings) this.onEvent?.({ kind: 'warning', key: args.eventKey, detail: w });
    // Tools count: a submit_turn decision schema alone is ~1k tokens.
    const roughTokens = estimateCacheTokens(args.systemInstruction, args.tools, args.context);
    if (roughTokens < this.minTokens) {
      this.onEvent?.({ kind: 'skipped', key: args.eventKey, detail: `prefix is ~${roughTokens} tokens (< ${this.minTokens})` });
      return null;
    }
    try {
      const { name } = await this.client.create({
        model: args.model,
        systemInstruction: args.systemInstruction,
        tools: args.tools,
        context: args.context,
        ttlSeconds: args.ttlSeconds,
      });
      this.onEvent?.({ kind: 'created', key: args.eventKey });
      return { name, tokens: roughTokens };
    } catch (err) {
      this.onEvent?.({ kind: 'skipped', key: args.eventKey, detail: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
}

function prefixHash(prefix: { system: string; tools: ToolDeclaration[] }): string {
  const hash = createHash('sha256');
  hash.update(prefix.system + '\n');
  for (const t of sortedTools(prefix.tools)) hash.update(t.name + '|' + JSON.stringify(t.parameters) + '\n');
  return hash.digest('hex').slice(0, 16);
}
