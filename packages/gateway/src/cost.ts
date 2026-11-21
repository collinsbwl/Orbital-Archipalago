// Cost meter: sum per run, role and model, with a hard budget (architecture.md §3.6).
// Track A reads the running total for the Snapshot and writes the raw rows to Tiger.

import type { Role, Usage } from '@orbital/contracts';

export interface CostEvent {
  universeId: string;
  cycle: number;
  agentId: string;
  role: Role;
  usage: Usage;
}

export interface CostTotals {
  totalUsd: number;
  byRole: Partial<Record<Role, number>>;
  byModel: Record<string, number>;
  /** Per-user USD for the advisor cap. */
  byUser: Record<string, number>;
}

export interface CostMeterConfig {
  /** Hard per-run cap. Default $15 (architecture.md §3.6). */
  runBudgetUsd?: number;
  /** Per-user cap for the spectator advisor. */
  advisorPerUserUsd?: number;
  /** Called for every recorded call. Track A pipes this into `call_usage` on Tiger. */
  onUsage?: (ev: CostEvent) => void;
  /** Called the first time the run budget is exceeded. */
  onBudgetExhausted?: (totals: CostTotals) => void;
  /** Called the first time a user hits the advisor cap. */
  onAdvisorCap?: (userSub: string, totals: CostTotals) => void;
}

export class CostMeter {
  private readonly cfg: Required<Pick<CostMeterConfig, 'runBudgetUsd' | 'advisorPerUserUsd'>> &
    Pick<CostMeterConfig, 'onUsage' | 'onBudgetExhausted' | 'onAdvisorCap'>;
  private totals: CostTotals = { totalUsd: 0, byRole: {}, byModel: {}, byUser: {} };
  private budgetFired = false;
  private advisorFired = new Set<string>();

  constructor(cfg: CostMeterConfig = {}) {
    this.cfg = {
      runBudgetUsd: cfg.runBudgetUsd ?? 15,
      advisorPerUserUsd: cfg.advisorPerUserUsd ?? 1,
      onUsage: cfg.onUsage,
      onBudgetExhausted: cfg.onBudgetExhausted,
      onAdvisorCap: cfg.onAdvisorCap,
    };
  }

  /** Record a successful call. Returns the running total. */
  record(ev: CostEvent, userSub?: string): CostTotals {
    this.totals.totalUsd += ev.usage.costUsd;
    this.totals.byRole[ev.role] = (this.totals.byRole[ev.role] ?? 0) + ev.usage.costUsd;
    this.totals.byModel[ev.usage.model] =
      (this.totals.byModel[ev.usage.model] ?? 0) + ev.usage.costUsd;
    if (userSub) {
      this.totals.byUser[userSub] = (this.totals.byUser[userSub] ?? 0) + ev.usage.costUsd;
    }
    this.cfg.onUsage?.(ev);
    if (!this.budgetFired && this.totals.totalUsd >= this.cfg.runBudgetUsd) {
      this.budgetFired = true;
      this.cfg.onBudgetExhausted?.(this.snapshot());
    }
    if (userSub && !this.advisorFired.has(userSub)) {
      const u = this.totals.byUser[userSub] ?? 0;
      if (u >= this.cfg.advisorPerUserUsd) {
        this.advisorFired.add(userSub);
        this.cfg.onAdvisorCap?.(userSub, this.snapshot());
      }
    }
    return this.snapshot();
  }

  /** True once the run budget is spent. New sim calls should short-circuit to stub. */
  isBudgetExhausted(): boolean {
    return this.totals.totalUsd >= this.cfg.runBudgetUsd;
  }

  /** True once this user has spent their advisor cap. */
  isAdvisorCapped(userSub: string): boolean {
    return (this.totals.byUser[userSub] ?? 0) >= this.cfg.advisorPerUserUsd;
  }

  snapshot(): CostTotals {
    // Caller cannot mutate our internal state.
    return {
      totalUsd: this.totals.totalUsd,
      byRole: { ...this.totals.byRole },
      byModel: { ...this.totals.byModel },
      byUser: { ...this.totals.byUser },
    };
  }
}
