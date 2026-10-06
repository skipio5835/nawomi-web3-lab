import { copy, type UiCopy } from "./arc-radar-i18n.js";
import { priceFreshness } from "./arc-radar-freshness.js";
import type { SourceState } from "./arc-radar-quality.js";

const HOUR = 3_600_000;
export const ANALYSIS_RULES = { freshnessMs: 120_000, priceMovePct: 5, removalPct: 10, top10Pct: 50, top10DeltaPp: 3 } as const;

export type AnalysisOwnership = {
  checkedAt: number; poolScope: string; top10Share: number | null;
  sources: { holders: SourceState }; holderHistoryPartial: boolean;
};
export type AnalysisMarket = {
  periodsAsOf: number;
  stale: boolean; historyTruncated: boolean; reserveSource: "sync" | "balance" | "v3" | "v4";
  priceEventAt: string | null; priceFetchedAt: number | null;
  periods: { h1: { priceChange: number | null } };
  trades: Array<{ direction: string; usdcValue: number; timestamp: string; transactionHash: string; eventIndex?: number }>;
  liquidityEvents: Array<{ direction: string; usdcAmount: number; changePercent: number | null; timestamp: string; transactionHash: string }>;
};
export type AnalysisEvidence = { text: UiCopy; source: "pool" | "holders" | "transaction"; transactionHash?: string };
export type TokenAnalysis = {
  headline: UiCopy; summary: UiCopy; tone: "info" | "warning" | "unknown";
  evidence: AnalysisEvidence[]; limits: UiCopy[]; asOf: number;
};

const validHash = (value: string) => /^0x[0-9a-f]{64}$/i.test(value);
const finiteShare = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
const number = (value: number) => value !== 0 && Math.abs(value) < 0.001 ? `${value < 0 ? "-" : ""}<0.001`
  : new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
const signed = (value: number) => `${value > 0 ? "+" : ""}${number(value)}`;
export const formatAnalysisTime = (value: number) => new Intl.DateTimeFormat("en-GB", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "shortOffset",
}).format(new Date(value));

export function analyzeToken(
  market: AnalysisMarket, detail: AnalysisOwnership & { analysisPrevious?: AnalysisOwnership }, now = Date.now(),
): TokenAnalysis {
  const evidence: AnalysisEvidence[] = [];
  const limits: UiCopy[] = [];
  const freshTime = (time: number | null, ttl = ANALYSIS_RULES.freshnessMs as number) => time !== null && Number.isFinite(time) && time > 0 && time <= now && now - time < ttl;
  const asOf = Number.isFinite(market.periodsAsOf) && market.periodsAsOf <= now ? market.periodsAsOf : now;
  const inHour = (time: string) => Date.parse(time) > asOf - HOUR && Date.parse(time) <= asOf;
  const marketFresh = !market.stale && freshTime(market.periodsAsOf) && freshTime(market.priceFetchedAt, 300_000);
  const change = market.periods.h1.priceChange;
  const priceKnown = marketFresh && !market.historyTruncated && market.reserveSource !== "balance"
    && priceFreshness(market.priceEventAt, market.reserveSource, asOf) === "recent"
    && change !== null && Number.isFinite(change) && change >= -100;

  // Never interpret a Transfer as a swap, or count repeated copies of the same swap.
  const swaps = new Map<string, AnalysisMarket["trades"][number]>();
  let invalidSwaps = false;
  for (const trade of market.trades) {
    if (!Number.isFinite(Date.parse(trade.timestamp)) || Date.parse(trade.timestamp) > asOf) { invalidSwaps = true; continue; }
    if (!inHour(trade.timestamp)) continue;
    if (!validHash(trade.transactionHash) || !Number.isSafeInteger(trade.eventIndex) || trade.eventIndex! < 0
      || !["buy", "sell"].includes(trade.direction) || !Number.isFinite(trade.usdcValue) || trade.usdcValue <= 0) {
      invalidSwaps = true; continue;
    }
    const key = `${trade.transactionHash.toLowerCase()}:${trade.eventIndex}`;
    const previous = swaps.get(key);
    if (previous && (previous.direction !== trade.direction || previous.usdcValue !== trade.usdcValue || previous.timestamp !== trade.timestamp)) invalidSwaps = true;
    else swaps.set(key, trade);
  }
  const buys = [...swaps.values()].filter(trade => trade.direction === "buy");
  const sells = [...swaps.values()].filter(trade => trade.direction === "sell");
  const buyValue = buys.reduce((sum, trade) => sum + trade.usdcValue, 0);
  const sellValue = sells.reduce((sum, trade) => sum + trade.usdcValue, 0);
  const flowKnown = marketFresh && !market.historyTruncated && !invalidSwaps && Number.isFinite(buyValue + sellValue);
  const removal = marketFresh && market.reserveSource === "sync" ? market.liquidityEvents
    .filter(event => event.direction === "remove" && inHour(event.timestamp) && validHash(event.transactionHash)
      && finiteShare(event.changePercent) && event.changePercent >= ANALYSIS_RULES.removalPct
      && Number.isFinite(event.usdcAmount) && event.usdcAmount > 0)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] : undefined;
  const holdersKnown = detail.sources.holders === "fresh" && freshTime(detail.checkedAt)
    && !detail.holderHistoryPartial && finiteShare(detail.top10Share);
  const previous = detail.analysisPrevious;
  const comparisonKnown = holdersKnown && previous?.sources.holders === "fresh" && !previous.holderHistoryPartial
    && finiteShare(previous.top10Share) && previous.poolScope === detail.poolScope
    && Number.isFinite(previous.checkedAt) && previous.checkedAt > 0 && previous.checkedAt < detail.checkedAt
    && detail.checkedAt - previous.checkedAt <= 24 * HOUR;
  const concentrationDelta = comparisonKnown ? detail.top10Share! - previous!.top10Share! : null;

  if (priceKnown) evidence.push({ text: copy("1H pool price {change}%.", { change: signed(change!) }), source: "pool" });
  if (flowKnown) evidence.push({ text: copy("1H indexed swaps: {buys} buys / {buyValue} USDC; {sells} sells / {sellValue} USDC.", {
    buys: buys.length, buyValue: number(buyValue), sells: sells.length, sellValue: number(sellValue),
  }), source: "pool" });
  if (removal) evidence.push({ text: copy("1H removal event: {amount} USDC, {share}% of the prior quote reserve. Not a net liquidity change.", {
    amount: number(removal.usdcAmount), share: number(removal.changePercent!),
  }), source: "transaction", transactionHash: removal.transactionHash });
  if (holdersKnown) {
    evidence.push({ text: copy("Top 10 indexed non-pool, non-burn addresses hold {share}% of supply.", { share: number(detail.top10Share!) }), source: "holders" });
    if (comparisonKnown) evidence.push({ text: copy("Top 10 share changed {delta} percentage points versus the snapshot at {time}.", {
      delta: signed(concentrationDelta!), time: formatAnalysisTime(previous!.checkedAt),
    }), source: "holders" });
  }

  if (!marketFresh) limits.push(copy("Market inputs are cached, expired, or undated. Current market interpretation is on hold."));
  else if (!priceKnown) limits.push(copy("A recent event price and a complete 1H baseline are not both available; price direction is unassessed."));
  if (market.historyTruncated || invalidSwaps) limits.push(copy("The indexed event history is incomplete or inconsistent; 1H flow conclusions are withheld."));
  if (market.reserveSource === "v4") limits.push(copy("v4 per-pool liquidity and hook-adjusted execution are not assessed."));
  if (market.reserveSource === "v3") limits.push(copy("Concentrated liquidity positions and exit estimates are not assessed."));
  else if (!removal) limits.push(copy("No qualifying removal is used here; this does not establish stable liquidity or an executable exit."));
  if (!holdersKnown) limits.push(copy("Holder coverage is partial, cached, or unavailable; concentration is unassessed."));
  else if (!comparisonKnown) limits.push(copy("No comparable prior holder snapshot; concentration change is unassessed."));

  let headline = "Limited evidence";
  let summary = "The available inputs do not support a combined price-and-flow interpretation.";
  let tone: TokenAnalysis["tone"] = "unknown";
  if (!marketFresh) {
    headline = "Analysis on hold";
    summary = "Fresh market inputs are required before combining these observations.";
  } else if (removal) {
    headline = priceKnown && change! >= ANALYSIS_RULES.priceMovePct ? "Price rising; liquidity removal observed" : "Liquidity removal observed";
    summary = "A qualifying withdrawal occurred within the last hour. Later deposits and swaps may have changed the remaining liquidity.";
    tone = "warning";
  } else if (priceKnown && flowKnown && sells.length > 0 && sellValue > buyValue && change! >= ANALYSIS_RULES.priceMovePct) {
    headline = "Price rising; indexed sell value leads";
    summary = "Price direction and indexed swap flow disagree. These pool events do not establish net capital inflow or independent trader demand.";
    tone = "warning";
  } else if (flowKnown && buys.length > 0 && sells.length === 0) {
    headline = "Buying observed; sell evidence missing";
    summary = "No sells appear in the fetched 1H swap window. This does not prove that selling is restricted.";
  } else if (holdersKnown && (detail.top10Share! >= ANALYSIS_RULES.top10Pct || concentrationDelta !== null && concentrationDelta >= ANALYSIS_RULES.top10DeltaPp)) {
    headline = "Holder concentration merits review";
    summary = "Ranked addresses hold a large or increasing share. Contracts and multiple addresses belonging to one owner can affect the interpretation.";
    tone = "warning";
  } else if (priceKnown && flowKnown && buys.length > 0 && sells.length > 0) {
    headline = change! >= ANALYSIS_RULES.priceMovePct ? "Price rising with two-way swaps"
      : change! <= -ANALYSIS_RULES.priceMovePct ? "Price falling with two-way swaps" : "Two-way swaps observed";
    summary = "Both swap directions appear in the last hour. This alone does not establish sustained demand, fair pricing, or a future sell outcome.";
    tone = "info";
  } else if (flowKnown && swaps.size === 0) {
    headline = "Recent trading not established";
    summary = "No valid swaps appear in the fetched 1H window. Quiet trading and indexing delays are not distinguished.";
  }
  return { headline: copy(headline), summary: copy(summary), tone, evidence, limits, asOf };
}
