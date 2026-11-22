import { describe, expect, it } from 'vitest';
import type { SimEvent } from '@orbital/contracts';
import { classify, HEADLINE_TEMPLATES, toHeadline, toNews } from './headlines';

const ev = (text: string, kind: SimEvent['kind'] = 'crisis', id = 'e1'): SimEvent => ({ id, cycle: 5, kind, text });

describe('classify', () => {
  it.each([
    ['Recession: Helion GDP fell 36.4% over 2 consecutive 5-cycle periods', 'recession', { planet: 'Helion', pct: '36.4' }],
    ['Confidence collapse: Tethys business confidence fell 23 points in 10 cycles', 'confidence', { planet: 'Tethys', who: 'businesses', pts: '23' }],
    ['Currency crisis: HLN/TTH moved +25% in 5 cycles (TTH depreciated)', 'currency', { pair: 'HLN/TTH', pct: '25', cycles: '5', currency: 'TTH' }],
    ['Trade war: Helion and Verdan raised tariffs within 3 cycles', 'tradeWar', { a: 'Helion', b: 'Verdan' }],
    ["Trade diversion: Helion's grain imports shifted from Verdan (80%) to Tethys (60%) after raising its tariff", 'tradeDiversion', { planet: 'Helion', what: 'grain imports', cause: 'a tariff hike' }],
    ['[god mode] drought on Verdan: grain output -50% for 15 cycles', 'famine', { planet: 'Verdan', good: 'grain', pct: '-50%', cause: 'drought' }],
    ['[god mode] drought on Verdan: grain output -10% for 15 cycles', 'drought', { planet: 'Verdan', good: 'grain', pct: '-10%' }],
    ['[god mode] strike on Helion: iron output -60% for 5 cycles', 'strike', { planet: 'Helion', good: 'iron', pct: '-60%' }],
    ['[god mode] demand_surge on Helion: ore demand +30% for 5 cycles', 'demandSurge', { planet: 'Helion', good: 'ore', pct: '+30%' }],
    ['[god mode] Helion sets a 15% tariff on grain', 'tariff', { planet: 'Helion', rate: '15', good: 'grain' }],
    ['[god mode] Helion embargoes Verdan', 'embargo', { planet: 'Helion', target: 'Verdan' }],
    ['[god mode] Helion lifts the embargo on Verdan', 'embargoLifted', { planet: 'Helion', target: 'Verdan' }],
    ['[god mode] Helion policy rate set to 500 bp (reserve-bank rule suspended 20 cycles)', 'rateSet', { planet: 'Helion', rate: '5' }],
    ['Verdan policy rate 0 -> 370 bp (inflation 1111 bp, output gap 1659 bp)', 'rateHike', { planet: 'Verdan', from: '0', rate: '3.7' }],
    ['Helion policy rate 220 -> 0 bp (inflation 0 bp, output gap -2012 bp)', 'rateCut', { planet: 'Helion', from: '2.2', rate: '0' }],
    ['Exodus: 4 colonists leave Helion for Verdan (hungry for grain and water); Helion population 22, Verdan 38', 'exodus', { n: '4', people: '4 colonists', from: 'Helion', to: 'Verdan', goods: 'grain and water' }],
    ['Exodus: 1 colonist leaves Tethys for Verdan (hungry for grain); Tethys population 26, Verdan 31', 'exodus', { n: '1', people: '1 colonist', from: 'Tethys', to: 'Verdan', goods: 'grain' }],
  ])('%s', (text, type, vars) => {
    expect(classify(ev(text))).toEqual({ type, vars });
  });

  it('treats small rate moves and loan defaults as routine', () => {
    expect(classify(ev('Tethys policy rate 0 -> 15 bp (inflation 0 bp, output gap -505 bp)', 'policy'))).toBeNull();
    expect(classify(ev('Loan l3 of a7 defaulted (120 HLN unpaid)', 'system'))).toBeNull();
  });
});

describe('toHeadline', () => {
  it('picks one of the templates, the same one every time for the same event', () => {
    const e = ev('Recession: Helion GDP fell 36.4% over 2 consecutive 5-cycle periods', 'crisis', 'e42');
    const options = HEADLINE_TEMPLATES.recession.map((t) => t({ planet: 'Helion', pct: '36.4' }));
    expect(options).toContain(toHeadline(e));
    expect(toHeadline(e)).toBe(toHeadline(e));
  });

  it('varies the template across events', () => {
    const seen = new Set<string | null>();
    for (let i = 0; i < 40; i++) seen.add(toHeadline(ev('[god mode] Helion embargoes Verdan', 'policy', `e${i}`)));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('covers every engine event in the recorded fixtures without leaving template holes', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(`${process.cwd()}/public/fixtures/snapshots.json`, 'utf8');
    const texts = new Set([...raw.matchAll(/"kind":"(crisis|shock)","planet":"[^"]*","text":"([^"]*)"/g)].map((m) => m[2]!));
    expect(texts.size).toBeGreaterThan(0);
    for (const text of texts) {
      const h = toHeadline(ev(text));
      expect(h, text).toBeTruthy();
      expect(h, text).not.toContain('undefined');
    }
  });
});

describe('toNews glance', () => {
  it.each([
    ['Recession: Helion GDP fell 36.4% over 2 consecutive 5-cycle periods', { planets: ['Helion'], what: 'GDP', direction: 'down', change: '-36.4%', tone: 'bad', category: 'Economy', breaking: true }],
    ['Verdan policy rate 0 -> 370 bp (inflation 1111 bp, output gap 1659 bp)', { planets: ['Verdan'], what: 'Interest rate', direction: 'up', change: '0% → 3.7%', tone: 'neutral', category: 'Central bank', breaking: false }],
    ['[god mode] drought on Verdan: grain output -50% for 15 cycles', { planets: ['Verdan'], what: 'Grain supply', direction: 'down', change: '-50%', tone: 'bad', category: 'Famine', breaking: true }],
    ['[god mode] drought on Verdan: grain output -10% for 15 cycles', { planets: ['Verdan'], what: 'Grain output', direction: 'down', change: '-10%', tone: 'bad', category: 'Disaster', breaking: false }],
    ['[god mode] Helion embargoes Verdan', { planets: ['Helion', 'Verdan'], what: 'Trade', direction: 'down', change: 'blocked', tone: 'bad', category: 'Trade', breaking: true }],
    ['Currency crisis: HLX/VRD moved +25% in 5 cycles (VRD depreciated)', { planets: [], currency: 'VRD', what: 'VRD value', direction: 'down', change: '-25%', tone: 'bad', category: 'Markets', breaking: true }],
    ['Confidence collapse: Tethys business confidence fell 23 points in 10 cycles', { planets: ['Tethys'], what: 'Business confidence', direction: 'down', change: '-23 pts', tone: 'bad', category: 'Economy', breaking: false }],
    ['Exodus: 4 colonists leave Helion for Verdan (hungry for grain and water); Helion population 22, Verdan 38', { planets: ['Helion', 'Verdan'], what: 'Helion population', direction: 'down', change: '-4', tone: 'bad', category: 'Migration', breaking: true }],
    ['Exodus: 1 colonist leaves Tethys for Verdan (hungry for grain); Tethys population 26, Verdan 31', { planets: ['Tethys', 'Verdan'], what: 'Tethys population', direction: 'down', change: '-1', tone: 'bad', category: 'Migration', breaking: false }],
  ])('%s', (text, glance) => {
    expect(toNews(ev(text))?.glance).toEqual(glance);
  });
});
