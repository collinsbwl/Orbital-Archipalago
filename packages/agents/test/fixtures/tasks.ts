// AgentTask fixtures covering every role. Built against DEFAULT_WORLD
// (helion / verdan / tethys).

import type { AgentTask } from '@orbital/contracts';

const policy = { tariffsBp: { iron: 500 }, quotas: {}, embargoes: [], policyRateBp: 100 };

export const FIXTURES: AgentTask[] = [
  {
    universeId: 'u0', cycle: 3, agentId: 'helion:colonist:1', role: 'colonist', planet: 'helion',
    observation: {
      purse: { HLX: 1_000 }, inventory: { grain: 0, water: 0 }, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'grain', bids: [{ price: 38, qty: 3 }], asks: [{ price: 42, qty: 5 }], lastPrice: 40, trend: [41, 40, 40] },
        { good: 'water', bids: [{ price: 18, qty: 2 }], asks: [{ price: 22, qty: 4 }], lastPrice: 20, trend: [19, 20, 20] },
      ],
      fx: [{ base: 'HLX', quote: 'VRD', lastRatePpm: 1_250_000 }],
      policy, headlines: ['Iron prices steady'],
    },
    allowedActions: ['place_order', 'pass'], deadlineMs: 5_000,
  },
  {
    universeId: 'u0', cycle: 3, agentId: 'helion:colonist:7', role: 'colonist', planet: 'helion',
    observation: {
      purse: { HLX: 500 }, inventory: { grain: 2, iron: 6 }, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'iron', bids: [{ price: 95, qty: 3 }], asks: [{ price: 105, qty: 2 }], lastPrice: 100, trend: [98, 99, 100] },
      ],
      fx: [{ base: 'HLX', quote: 'VRD', lastRatePpm: 1_250_000 }],
      policy, headlines: [],
    },
    allowedActions: ['place_order', 'pass'], deadlineMs: 5_000,
  },
  {
    universeId: 'u0', cycle: 4, agentId: 'helion:trader:1', role: 'trader', planet: 'helion',
    observation: {
      purse: { HLX: 10_000 }, inventory: { iron: 20 }, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'iron', bids: [{ price: 90, qty: 4 }], asks: [{ price: 95, qty: 10 }], lastPrice: 92, trend: [88, 90, 92] },
      ],
      fx: [
        { base: 'HLX', quote: 'VRD', lastRatePpm: 1_250_000 },
        { base: 'HLX', quote: 'TTH', lastRatePpm: 800_000 },
      ],
      policy, headlines: [],
    },
    allowedActions: ['ship', 'place_order', 'pass'], deadlineMs: 6_000,
  },
  {
    universeId: 'u0', cycle: 4, agentId: 'verdan:trader:2', role: 'trader', planet: 'verdan',
    observation: {
      purse: { VRD: 10_000 }, inventory: { grain: 25 }, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'grain', bids: [{ price: 35, qty: 5 }], asks: [{ price: 40, qty: 8 }], lastPrice: 38, trend: [40, 39, 38] },
      ],
      fx: [{ base: 'VRD', quote: 'HLX', lastRatePpm: 800_000 }],
      policy, headlines: [],
    },
    allowedActions: ['ship', 'place_order', 'pass'], deadlineMs: 6_000,
  },
  {
    universeId: 'u0', cycle: 5, agentId: 'helion:government:1', role: 'government', planet: 'helion',
    observation: {
      purse: { HLX: 100_000 }, inventory: {}, openOrders: [], loans: [], shipments: [],
      markets: [], fx: [], policy, headlines: ['Tariff debate on iron'],
      briefing: 'Pro: a tariff on iron shields miners from a demand shock. Con: it raises tool costs for Tethys.',
    },
    allowedActions: ['set_tariff', 'set_quota', 'pass'], deadlineMs: 8_000,
  },
  {
    universeId: 'u0', cycle: 5, agentId: 'verdan:reserve_bank:1', role: 'reserve_bank', planet: 'verdan',
    observation: {
      purse: { VRD: 1_000_000 }, inventory: {}, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'grain', bids: [{ price: 42, qty: 5 }], asks: [{ price: 46, qty: 8 }], lastPrice: 44, trend: [40, 42, 44] },
      ],
      fx: [], policy, headlines: [],
    },
    allowedActions: ['set_policy_rate', 'pass'], deadlineMs: 2_000,
  },
  {
    universeId: 'u0', cycle: 5, agentId: 'news:1', role: 'news', planet: 'helion',
    observation: {
      purse: {}, inventory: {}, openOrders: [], loans: [], shipments: [],
      markets: [], fx: [], policy, headlines: [],
    },
    allowedActions: ['publish_headlines'], deadlineMs: 3_000,
  },
  {
    universeId: 'u0', cycle: 200, agentId: 'economist:1', role: 'economist', planet: 'helion',
    observation: {
      purse: {}, inventory: {}, openOrders: [], loans: [], shipments: [],
      markets: [], fx: [], policy, headlines: [],
    },
    allowedActions: ['write_report'], deadlineMs: 10_000,
  },
  {
    universeId: 'u0', cycle: 10, agentId: 'tethys:colonist:5', role: 'colonist', planet: 'tethys',
    observation: {
      purse: { TTH: 2_000 }, inventory: { water: 4, grain: 0 }, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'grain', bids: [{ price: 50, qty: 2 }], asks: [{ price: 55, qty: 4 }], lastPrice: 52, trend: [48, 50, 52] },
        { good: 'water', bids: [{ price: 18, qty: 2 }], asks: [{ price: 22, qty: 5 }], lastPrice: 20, trend: [20, 20, 20] },
      ],
      fx: [], policy, headlines: [],
    },
    allowedActions: ['place_order', 'pass'], deadlineMs: 5_000,
  },
  {
    universeId: 'u0', cycle: 10, agentId: 'tethys:trader:3', role: 'trader', planet: 'tethys',
    observation: {
      purse: { TTH: 20_000 }, inventory: { tools: 10 }, openOrders: [], loans: [], shipments: [],
      markets: [
        { good: 'tools', bids: [{ price: 290, qty: 2 }], asks: [{ price: 305, qty: 3 }], lastPrice: 300, trend: [295, 298, 300] },
      ],
      fx: [
        { base: 'TTH', quote: 'HLX', lastRatePpm: 1_250_000 },
        { base: 'TTH', quote: 'VRD', lastRatePpm: 1_500_000 },
      ],
      policy, headlines: [],
    },
    allowedActions: ['ship', 'place_order', 'pass'], deadlineMs: 6_000,
  },
];
