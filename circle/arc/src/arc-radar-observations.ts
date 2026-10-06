import type { RadarPool, DexTrade, DexLiquidityEvent } from "./arc-radar-dex.js";
import { priceFreshness } from "./arc-radar-freshness.js";
import type { AnalysisOwnership } from "./arc-radar-analysis.js";

export const OBSERVATION_LIMITS = { pools: 150, samples: 24, events: 32, days: 30, intervalMs: 300_000, bytes: 3_000_000 };
export type ObservationMarket = RadarPool & {
  stale: boolean; periodsAsOf: number; priceFetchedAt: number | null; priceEventAt: string | null;
  reserveSource: string; currentPrice: number; usdcReserve: number | null;
  token: { holders_count: string | null }; trades: DexTrade[]; liquidityEvents: DexLiquidityEvent[];
};
export type ObservationSnapshot = {
  at: number; price: number | null; reserve: number | null; holders: number | null;
  top10: number | null; scope: string | null;
};
export type ObservationEvent = {
  at: number; observedAt: number; hash: string; index: number;
  kind: "buy" | "sell" | "add" | "remove"; amount: number;
};
export type PoolObservation = {
  identity: string; first: ObservationSnapshot; latest: ObservationSnapshot;
  history: ObservationSnapshot[]; events: ObservationEvent[];
};
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const DAY = 86_400_000;
const hashPattern = /^0x[0-9a-f]{64}$/;
const numberOrNull = (value: unknown): value is number | null => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
const timeValid = (value: unknown, now: number): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now;

export function observationFresh(market: ObservationMarket, now: number): boolean {
  return !market.stale && timeValid(market.periodsAsOf, now) && now - market.periodsAsOf <= 120_000
    && timeValid(market.priceFetchedAt, now) && now - market.priceFetchedAt <= 300_000;
}

function validSnapshot(value: any, now: number): value is ObservationSnapshot {
  return value && timeValid(value.at, now) && [value.price, value.reserve, value.holders, value.top10].every(numberOrNull)
    && (value.price === null || value.price > 0) && (value.holders === null || Number.isSafeInteger(value.holders))
    && (value.top10 === null || value.top10 <= 100) && (value.scope === null || typeof value.scope === "string" && value.scope.length <= 10_000)
    && (value.top10 === null || Boolean(value.scope));
}
function validEvent(value: any, now: number): value is ObservationEvent {
  return value && timeValid(value.at, now) && timeValid(value.observedAt, now) && value.observedAt >= value.at
    && typeof value.hash === "string" && hashPattern.test(value.hash) && Number.isSafeInteger(value.index) && value.index >= 0
    && ["buy", "sell", "add", "remove"].includes(value.kind) && typeof value.amount === "number" && Number.isFinite(value.amount) && value.amount > 0;
}
function cleanSnapshot(value: ObservationSnapshot): ObservationSnapshot {
  return { at: value.at, price: value.price, reserve: value.reserve, holders: value.holders, top10: value.top10, scope: value.scope };
}
function cleanEvent(value: ObservationEvent): ObservationEvent {
  return { at: value.at, observedAt: value.observedAt, hash: value.hash, index: value.index, kind: value.kind, amount: value.amount };
}

export function decodeObservations(raw: string | null, now: number): PoolObservation[] {
  if (!raw || raw.length > OBSERVATION_LIMITS.bytes) return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.pools) || parsed.pools.length > OBSERVATION_LIMITS.pools) return [];
    const unique = new Map<string, PoolObservation>();
    for (const value of parsed.pools) {
      if (!value || typeof value.identity !== "string" || value.identity.length > 400 || !validSnapshot(value.first, now)
        || !validSnapshot(value.latest, now) || value.first.at > value.latest.at || now - value.latest.at > OBSERVATION_LIMITS.days * DAY
        || !Array.isArray(value.history) || value.history.length > OBSERVATION_LIMITS.samples
        || !value.history.every((sample: unknown) => validSnapshot(sample, now))
        || !Array.isArray(value.events) || value.events.length > OBSERVATION_LIMITS.events
        || !value.events.every((event: unknown) => validEvent(event, now))) continue;
      if (value.history.some((s: ObservationSnapshot, i: number) => s.at <= value.first.at || s.at > value.latest.at || i > 0 && s.at <= value.history[i - 1].at)) continue;
      if (new Set(value.events.map((e: ObservationEvent) => `${e.hash}:${e.index}`)).size !== value.events.length) continue;
      unique.set(value.identity, { identity: value.identity, first: cleanSnapshot(value.first), latest: cleanSnapshot(value.latest),
        history: value.history.map(cleanSnapshot), events: value.events.map(cleanEvent).sort((a: ObservationEvent, b: ObservationEvent) => a.at - b.at || a.index - b.index) });
    }
    return [...unique.values()];
  } catch { return []; }
}

function indexedEvents(market: ObservationMarket, now: number): Map<string, ObservationEvent | null> {
  const swaps = market.trades.map(trade => ({ at: Date.parse(trade.timestamp), observedAt: now,
    hash: typeof trade.transactionHash === "string" ? trade.transactionHash.toLowerCase() : "", index: trade.eventIndex!, kind: trade.direction, amount: trade.usdcValue }));
  const liquidity = market.v4 || market.v3 ? [] : market.liquidityEvents.map(event => ({ at: Date.parse(event.timestamp), observedAt: now,
    hash: typeof event.transactionHash === "string" ? event.transactionHash.toLowerCase() : "", index: event.eventIndex!, kind: event.direction, amount: event.usdcAmount }));
  const groups = new Map<string, ObservationEvent[]>();
  for (const event of [...swaps, ...liquidity]) {
    if (!hashPattern.test(event.hash) || !Number.isSafeInteger(event.index) || event.index < 0) continue;
    const key = `${event.hash}:${event.index}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return new Map([...groups.entries()].map(([key, events]) => [key, events.every(event => validEvent(event, now)
    && (!Number.isFinite(Date.parse(market.createdAt)) || event.at >= Date.parse(market.createdAt))
    && event.at === events[0].at && event.kind === events[0].kind && event.amount === events[0].amount) ? events[0] : null]));
}

export function observePool(identity: string, market: ObservationMarket, previous?: PoolObservation, now = Date.now()): PoolObservation | undefined {
  if (!observationFresh(market, now)) return previous;
  if (previous?.identity !== identity) previous = undefined;
  if (previous && (previous.latest.at > market.periodsAsOf || now - previous.latest.at > OBSERVATION_LIMITS.days * DAY)) {
    return previous.latest.at > market.periodsAsOf ? previous : observePool(identity, market, undefined, now);
  }
  const recentPrice = priceFreshness(market.priceEventAt, market.reserveSource, now) === "recent";
  const count = typeof market.token.holders_count === "string" ? market.token.holders_count.trim() : null;
  const holders = count && /^\d+$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null;
  const latest: ObservationSnapshot = {
    at: market.periodsAsOf,
    price: recentPrice && Number.isFinite(market.currentPrice) && market.currentPrice > 0 ? market.currentPrice : null,
    reserve: !market.v4 && !market.v3 && recentPrice && numberOrNull(market.usdcReserve) ? market.usdcReserve : null,
    holders, top10: null, scope: null,
  };
  const record: PoolObservation = previous ? { ...previous, latest, history: [...previous.history] }
    : { identity, first: { ...latest }, latest, history: [], events: [] };
  // Persist five-minute checkpoints plus the latest read; refreshes do not inflate history.
  if (previous && previous.latest.at - (record.history.at(-1)?.at ?? record.first.at) >= OBSERVATION_LIMITS.intervalMs) {
    record.history.push(previous.latest);
    record.history = record.history.slice(-OBSERVATION_LIMITS.samples);
  }
  if (previous?.latest.at === latest.at) { latest.top10 = previous.latest.top10; latest.scope = previous.latest.scope; }
  const merged = new Map(record.events.map(event => [`${event.hash}:${event.index}`, event]));
  for (const [key, event] of indexedEvents(market, now)) {
    if (!event) { merged.delete(key); continue; }
    const previousEvent = merged.get(key);
    if (!previousEvent || previousEvent.at !== event.at || previousEvent.kind !== event.kind || previousEvent.amount !== event.amount) merged.set(key, event);
  }
  const events = [...merged.values()].sort((a, b) => a.at - b.at || a.index - b.index);
  const earliestSwap = events.find(event => event.kind === "buy" || event.kind === "sell");
  record.events = events.slice(-OBSERVATION_LIMITS.events);
  if (earliestSwap && !record.events.includes(earliestSwap)) record.events = [earliestSwap, ...record.events.slice(1)];
  return record;
}

export function observeOwnership(record: PoolObservation, detail: AnalysisOwnership, now = Date.now()): PoolObservation {
  if (detail.sources.holders !== "fresh" || detail.holderHistoryPartial || !timeValid(detail.checkedAt, now)
    || now - detail.checkedAt > 120_000 || detail.checkedAt < record.latest.at || now - record.latest.at > 120_000
    || !detail.poolScope || !numberOrNull(detail.top10Share) || detail.top10Share === null || detail.top10Share > 100) return record;
  const latest = { ...record.latest, top10: detail.top10Share, scope: detail.poolScope };
  return { ...record, latest, first: record.first.at === latest.at ? { ...latest } : record.first };
}

export function observationActivity(market: ObservationMarket, now = Date.now()): { windows: number; swaps: number } | null {
  if (!observationFresh(market, now)) return null;
  const swaps = [...indexedEvents(market, now).values()].filter((event): event is ObservationEvent => event !== null
    && (event.kind === "buy" || event.kind === "sell") && event.at > now - 3_600_000);
  return { swaps: swaps.length, windows: new Set(swaps.map(event => Math.floor((now - event.at) / 300_000))).size };
}

export function observationDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before <= 0) return null;
  const value = (after / before - 1) * 100;
  return Number.isFinite(value) ? value : null;
}

export class ObservationStore {
  private records: Map<string, PoolObservation>;
  persistent: boolean;
  constructor(private storage: StorageLike | null, private key: string, now = Date.now()) {
    let raw: string | null = null;
    try { raw = storage?.getItem(key) ?? null; } catch { storage = null; }
    this.storage = storage;
    this.persistent = storage !== null;
    this.records = new Map(decodeObservations(raw, now).map(record => [record.identity, record]));
  }
  get(identity: string): PoolObservation | undefined { return this.records.get(identity); }
  set(record: PoolObservation): void { this.records.set(record.identity, record); }
  save(now = Date.now()): void {
    const pools = [...this.records.values()].filter(record => record.latest.at <= now && now - record.latest.at <= OBSERVATION_LIMITS.days * DAY)
      .sort((a, b) => b.latest.at - a.latest.at || a.identity.localeCompare(b.identity)).slice(0, OBSERVATION_LIMITS.pools);
    this.records = new Map(pools.map(record => [record.identity, record]));
    try {
      const raw = JSON.stringify({ version: 1, pools });
      if (!this.storage || raw.length > OBSERVATION_LIMITS.bytes) throw new Error("Observation storage unavailable");
      this.storage.setItem(this.key, raw);
      this.persistent = true;
    } catch { this.persistent = false; }
  }
}
