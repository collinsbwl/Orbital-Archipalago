import type { SimEvent } from '@orbital/contracts';

/** A reserve-bank rate move this large (in basis points) makes the news; smaller moves are routine. */
export const BIG_RATE_MOVE_BP = 100;

type Vars = Record<string, string>;
type Template = (v: Vars) => string;

/** Big-event types, each with several headline templates. One is picked per event. */
export const HEADLINE_TEMPLATES = {
  recession: [
    (v) => `${v.planet} slides into recession as output falls ${v.pct}%`,
    (v) => `Hard times on ${v.planet}: economy shrinks ${v.pct}%`,
    (v) => `${v.planet} GDP down ${v.pct}%, and economists say the R-word`,
    (v) => `Factories go quiet as ${v.planet} enters recession`,
  ],
  confidence: [
    (v) => `${v.planet} ${v.who} lose faith: confidence plunges ${v.pts} points`,
    (v) => `Mood sours on ${v.planet} as ${v.who} confidence craters`,
    (v) => `"We're worried," say ${v.planet} ${v.who} after a ${v.pts}-point slump`,
    (v) => `${v.planet} confidence in freefall, down ${v.pts} points`,
  ],
  currency: [
    (v) => `${v.currency} in freefall: ${v.pct}% swing rattles markets`,
    (v) => `Currency crisis! ${v.currency} tumbles ${v.pct}% in ${v.cycles} cycles`,
    (v) => `Traders flee the ${v.currency} after a ${v.pct}% plunge`,
    (v) => `${v.pair} shock: ${v.currency} loses ground fast`,
  ],
  tradeWar: [
    (v) => `Trade war erupts between ${v.a} and ${v.b}`,
    (v) => `${v.a} and ${v.b} trade blows with tit-for-tat tariffs`,
    (v) => `Tariff battle: ${v.a} vs ${v.b} escalates`,
    (v) => `Shipping lanes tense as ${v.a} and ${v.b} go to trade war`,
  ],
  tradeDiversion: [
    (v) => `${v.planet} turns to new suppliers after ${v.cause}`,
    (v) => `Trade routes redrawn: ${v.planet} shifts its ${v.what}`,
    (v) => `Winners and losers as ${v.planet} reroutes ${v.what}`,
  ],
  famine: [
    (v) => `FAMINE FEARS on ${v.planet} as ${v.good} supply crashes ${v.pct}`,
    (v) => `${v.planet} faces hunger: ${v.cause} cuts ${v.good} ${v.pct}`,
    (v) => `Empty shelves, long queues: ${v.planet} ${v.good} crisis deepens`,
    (v) => `"We cannot feed everyone": ${v.planet} rations ${v.good} after ${v.cause}`,
  ],
  drought: [
    (v) => `Drought grips ${v.planet}: ${v.good} harvest collapses ${v.pct}`,
    (v) => `Fields crack on ${v.planet} as ${v.good} output dries up`,
    (v) => `${v.planet} prays for rain: ${v.good} down ${v.pct}`,
  ],
  strike: [
    (v) => `Workers walk out on ${v.planet}, ${v.good} output down ${v.pct}`,
    (v) => `General strike halts ${v.good} production on ${v.planet}`,
    (v) => `Picket lines across ${v.planet}: ${v.good} supply squeezed`,
  ],
  windfall: [
    (v) => `Bumper year on ${v.planet}: ${v.good} output up ${v.pct}`,
    (v) => `${v.planet} strikes it rich as ${v.good} production soars`,
    (v) => `Boom times for ${v.planet} ${v.good} producers`,
  ],
  blight: [
    (v) => `Blight sweeps ${v.planet}, ${v.good} crops wither`,
    (v) => `Mystery rot ravages ${v.planet}'s ${v.good}, output ${v.pct}`,
    (v) => `${v.planet} battles blight as ${v.good} supply crashes`,
  ],
  demandSurge: [
    (v) => `${v.good} craze sweeps ${v.planet}: demand ${v.pct}`,
    (v) => `Shoppers mob ${v.planet} markets for ${v.good}`,
    (v) => `${v.planet} can't get enough ${v.good}`,
  ],
  tariff: [
    (v) => `${v.planet} slaps a ${v.rate}% tariff on ${v.good} imports`,
    (v) => `New duties: ${v.planet} taxes foreign ${v.good} at ${v.rate}%`,
    (v) => `${v.planet} shields ${v.good} farmers with a ${v.rate}% tariff`,
  ],
  embargo: [
    (v) => `${v.planet} bans all trade with ${v.target}`,
    (v) => `Embargo! ${v.planet} cuts off ${v.target}`,
    (v) => `${v.planet} closes its ports to ${v.target}`,
  ],
  embargoLifted: [
    (v) => `${v.planet} lifts its embargo on ${v.target}`,
    (v) => `Thaw: ${v.planet} reopens trade with ${v.target}`,
    (v) => `Ports reopen as ${v.planet} ends its ${v.target} embargo`,
  ],
  rateHike: [
    (v) => `${v.planet} central bank hikes rates to ${v.rate}%`,
    (v) => `Money gets dearer on ${v.planet}: rates jump to ${v.rate}%`,
    (v) => `${v.planet} moves to tame prices, raising rates to ${v.rate}%`,
  ],
  rateCut: [
    (v) => `${v.planet} slashes rates to ${v.rate}%`,
    (v) => `Cheap money: ${v.planet} cuts rates to ${v.rate}%`,
    (v) => `${v.planet} central bank cuts to ${v.rate}% to revive growth`,
  ],
  rateSet: [
    (v) => `${v.planet} government overrides central bank, sets rates at ${v.rate}%`,
    (v) => `Emergency move: ${v.planet} rates fixed at ${v.rate}%`,
    (v) => `${v.planet} takes the reins on rates: ${v.rate}% by decree`,
  ],
} satisfies Record<string, Template[]>;

export type HeadlineType = keyof typeof HEADLINE_TEMPLATES;

const SHOCK_TYPE: Record<string, HeadlineType> = {
  drought: 'drought', strike: 'strike', windfall: 'windfall', blight: 'blight', demand_surge: 'demandSurge',
};

/** Goods colonists need to live: a big supply hit to one of these is a famine, not just a bad harvest. */
export const STAPLE_GOODS = new Set(['grain', 'water']);
/** A supply cut this large (percent) on a staple goods is a famine. */
export const FAMINE_CUT_PCT = 25;

/** Rate in bp as a short percent string: 220 -> "2.2". */
const pctOf = (bp: number) => String(Math.round(bp) / 100);

/** Works out which big event an engine event is, and its headline variables. Null means routine (not news). */
export function classify(e: SimEvent): { type: HeadlineType; vars: Vars } | null {
  const text = e.text.replace(/^\[god mode\]\s*/, '');
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^Recession: (.+?) GDP fell ([\d.]+)%/))) return { type: 'recession', vars: { planet: m[1]!, pct: m[2]! } };
  if ((m = text.match(/^Confidence collapse: (.+?) (consumer|business) confidence fell (\d+) points/)))
    return { type: 'confidence', vars: { planet: m[1]!, who: m[2] === 'consumer' ? 'shoppers' : 'businesses', pts: m[3]! } };
  if ((m = text.match(/^Currency crisis: (\S+) moved [+-](\d+)% in (\d+) cycles \((\S+) depreciated\)/)))
    return { type: 'currency', vars: { pair: m[1]!, pct: m[2]!, cycles: m[3]!, currency: m[4]! } };
  if ((m = text.match(/^Trade war: (.+?) and (.+?) raised tariffs/))) return { type: 'tradeWar', vars: { a: m[1]!, b: m[2]! } };
  if ((m = text.match(/^Trade diversion: (.+?)'s (.+?) (?:shifted|mix moved).* after (raising its tariff|adding an embargo)/)))
    return { type: 'tradeDiversion', vars: { planet: m[1]!, what: m[2]!, cause: m[3] === 'raising its tariff' ? 'a tariff hike' : 'an embargo' } };

  if ((m = text.match(/^(\w+) on (.+?): (\w+) (?:output|demand) ([+-][\d.]+%)/)) && SHOCK_TYPE[m[1]!]) {
    const vars = { planet: m[2]!, good: m[3]!, pct: m[4]! };
    const cut = -parseFloat(vars.pct);
    if (m[1] !== 'demand_surge' && m[1] !== 'windfall' && STAPLE_GOODS.has(vars.good) && cut >= FAMINE_CUT_PCT)
      return { type: 'famine', vars: { ...vars, cause: m[1]! } };
    return { type: SHOCK_TYPE[m[1]!]!, vars };
  }
  if ((m = text.match(/^(.+?) sets a ([\d.]+)% tariff on (\w+)/))) return { type: 'tariff', vars: { planet: m[1]!, rate: m[2]!, good: m[3]! } };
  if ((m = text.match(/^(.+?) lifts the embargo on (.+)$/))) return { type: 'embargoLifted', vars: { planet: m[1]!, target: m[2]! } };
  if ((m = text.match(/^(.+?) embargoes (.+)$/))) return { type: 'embargo', vars: { planet: m[1]!, target: m[2]! } };
  if ((m = text.match(/^(.+?) policy rate set to (-?\d+) bp/))) // god-mode override: always news
    return { type: 'rateSet', vars: { planet: m[1]!, rate: pctOf(Number(m[2])) } };
  if ((m = text.match(/^(.+?) policy rate (-?\d+) -> (-?\d+) bp/))) {
    const from = Number(m[2]), to = Number(m[3]);
    if (Math.abs(to - from) < BIG_RATE_MOVE_BP) return null;
    return { type: to > from ? 'rateHike' : 'rateCut', vars: { planet: m[1]!, from: pctOf(from), rate: pctOf(to) } };
  }
  return null;
}

/** good/bad news for the player's economy; neutral when it depends on who you are. */
export type Tone = 'good' | 'bad' | 'neutral';
export type Direction = 'up' | 'down' | 'none';

/** The at-a-glance facts for a headline: which planets, what changed, which way, by how much. */
export interface Glance {
  /** Planet display names (first is the one the news is about). Empty when only a currency is named. */
  planets: string[];
  /** Currency code, for currency news, which names no planet. */
  currency?: string;
  /** What changed, e.g. "GDP", "grain output", "Interest rate". */
  what: string;
  direction: Direction;
  /** Size of the change, e.g. "-36.4%", "2.2% → 3.7%", "blocked". */
  change: string;
  tone: Tone;
  /** Newsroom desk, shown as a tag: ECONOMY, TRADE, FAMINE, ... */
  category: string;
  /** Breaking news is the really big stuff: it gets a banner and stands out in the feed. */
  breaking: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const CATEGORY: Record<HeadlineType, string> = {
  recession: 'Economy', confidence: 'Economy', currency: 'Markets', tradeWar: 'Trade', tradeDiversion: 'Trade',
  tariff: 'Trade', embargo: 'Trade', embargoLifted: 'Trade', famine: 'Famine', drought: 'Disaster', strike: 'Disaster',
  blight: 'Disaster', windfall: 'Business', demandSurge: 'Business', rateHike: 'Central bank', rateCut: 'Central bank', rateSet: 'Central bank',
};

/** Thresholds for breaking news among event types that are only sometimes huge. Rate moves and tariffs are never breaking. */
export const BREAKING = { recessionPct: 10, confidencePts: 30, shockPct: 50 } as const;

function isBreaking(type: HeadlineType, v: Vars): boolean {
  switch (type) {
    case 'tradeWar': case 'currency': case 'embargo': case 'famine': return true;
    case 'recession': return Number(v.pct) >= BREAKING.recessionPct;
    case 'confidence': return Number(v.pts) >= BREAKING.confidencePts;
    case 'drought': case 'strike': case 'blight': case 'windfall': case 'demandSurge': return Math.abs(parseFloat(v.pct!)) >= BREAKING.shockPct;
    default: return false;
  }
}

export function glanceFor(type: HeadlineType, v: Vars): Glance {
  return { ...facts(type, v), category: CATEGORY[type], breaking: isBreaking(type, v) };
}

function facts(type: HeadlineType, v: Vars): Omit<Glance, 'category' | 'breaking'> {
  const one = [v.planet!];
  switch (type) {
    case 'recession': return { planets: one, what: 'GDP', direction: 'down', change: `-${v.pct}%`, tone: 'bad' };
    case 'confidence': return { planets: one, what: v.who === 'shoppers' ? 'Shopper confidence' : 'Business confidence', direction: 'down', change: `-${v.pts} pts`, tone: 'bad' };
    case 'currency': return { planets: [], currency: v.currency!, what: `${v.currency} value`, direction: 'down', change: `-${v.pct}%`, tone: 'bad' };
    case 'tradeWar': return { planets: [v.a!, v.b!], what: 'Tariffs', direction: 'up', change: 'both sides', tone: 'bad' };
    case 'tradeDiversion': return { planets: one, what: cap(v.what!), direction: 'none', change: 'rerouted', tone: 'neutral' };
    case 'famine': return { planets: one, what: `${cap(v.good!)} supply`, direction: 'down', change: v.pct!, tone: 'bad' };
    case 'drought': case 'strike': case 'blight': return { planets: one, what: `${cap(v.good!)} output`, direction: 'down', change: v.pct!, tone: 'bad' };
    case 'windfall': return { planets: one, what: `${cap(v.good!)} output`, direction: 'up', change: v.pct!, tone: 'good' };
    case 'demandSurge': return { planets: one, what: `${cap(v.good!)} demand`, direction: 'up', change: v.pct!, tone: 'neutral' };
    case 'tariff': return { planets: one, what: `${cap(v.good!)} tariff`, direction: 'up', change: `${v.rate}%`, tone: 'neutral' };
    case 'embargo': return { planets: [v.planet!, v.target!], what: 'Trade', direction: 'down', change: 'blocked', tone: 'bad' };
    case 'embargoLifted': return { planets: [v.planet!, v.target!], what: 'Trade', direction: 'up', change: 'reopened', tone: 'good' };
    case 'rateHike': return { planets: one, what: 'Interest rate', direction: 'up', change: `${v.from}% → ${v.rate}%`, tone: 'neutral' };
    case 'rateCut': return { planets: one, what: 'Interest rate', direction: 'down', change: `${v.from}% → ${v.rate}%`, tone: 'neutral' };
    case 'rateSet': return { planets: one, what: 'Interest rate', direction: 'none', change: `set to ${v.rate}%`, tone: 'neutral' };
  }
}

/** A big event ready to show: the headline plus its glance facts. Null if the event is routine. */
export function toNews(e: SimEvent): { headline: string; glance: Glance } | null {
  const c = classify(e);
  if (!c) return null;
  const options: Template[] = HEADLINE_TEMPLATES[c.type];
  return { headline: options[pick(e.id, options.length)]!(c.vars), glance: glanceFor(c.type, c.vars) };
}

/** Stable hash of the event id, so an event keeps the same randomly chosen template on every render. */
function pick(id: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % n;
}

/** The news headline for a big event, or null if the event is routine. */
export function toHeadline(e: SimEvent): string | null {
  return toNews(e)?.headline ?? null;
}
