import { fullyDilutedValue } from "./arc-radar-core.js";
import type { DexPricePoint, DexTrade } from "./arc-radar-dex.js";

export type ChartSample = { time: number; price?: number; valuation?: number; volume?: number };
export type ChartInput = {
  pricePoints: DexPricePoint[];
  trades: DexTrade[];
  token: { total_supply: string | null; decimals: string | null };
  periodsAsOf: number;
};

// Observations, not OHLC candles. Missing buckets remain whitespace.
export function observedChartData(input: ChartInput): { samples: ChartSample[]; supply: number | null; priceCount: number; interval: number } {
  const observedTimes = [...input.pricePoints, ...input.trades].map(entry => Date.parse(entry.timestamp))
    .filter(ms => Number.isFinite(ms) && ms > 0 && ms <= input.periodsAsOf);
  const interval = observedTimes.length && Math.max(...observedTimes) - Math.min(...observedTimes) <= 600_000 ? 5 : 60;
  const bucketTime = (timestamp: string) => {
    const ms = Date.parse(timestamp);
    return Number.isFinite(ms) && ms > 0 && ms <= input.periodsAsOf ? Math.floor(ms / (interval * 1000)) * interval : null;
  };
  const prices = input.pricePoints.filter(point => bucketTime(point.timestamp) !== null && Number.isFinite(point.price) && point.price > 0)
    .slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
      || (a.blockNumber ?? 0) - (b.blockNumber ?? 0) || (a.eventIndex ?? 0) - (b.eventIndex ?? 0));
  const trades = input.trades.filter(trade => bucketTime(trade.timestamp) !== null && Number.isFinite(trade.usdcValue) && trade.usdcValue >= 0);
  const times = [...prices, ...trades].map(entry => bucketTime(entry.timestamp)!);
  const rawSupply = fullyDilutedValue(1, input.token.total_supply, input.token.decimals);
  let supply = rawSupply !== null && rawSupply > 0 ? rawSupply : null;
  if (!times.length) return { samples: [], supply, priceCount: 0, interval };
  const end = Math.max(...times);
  const start = Math.max(Math.min(...times), end - 86_400);
  const buckets = new Map<number, ChartSample>();
  for (let time = start; time <= end; time += interval) buckets.set(time, { time });
  let priceCount = 0;
  for (const point of prices) {
    const sample = buckets.get(bucketTime(point.timestamp)!);
    if (!sample) continue;
    sample.price = point.price;
    priceCount++;
  }
  const seen = new Set<string>();
  for (const trade of trades) {
    const key = `${trade.transactionHash.toLowerCase()}:${trade.eventIndex ?? `${trade.timestamp}:${trade.direction}:${trade.usdcValue}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sample = buckets.get(bucketTime(trade.timestamp)!);
    if (sample) {
      const volume = (sample.volume ?? 0) + trade.usdcValue;
      // An overflowing bucket is unknown, not a misleading finite subtotal.
      sample.volume = volume;
    }
  }
  const samples = [...buckets.values()];
  if (supply !== null && samples.some(sample => sample.price !== undefined && (!Number.isFinite(sample.price * supply!) || sample.price * supply! <= 0))) supply = null;
  for (const sample of samples) {
    if (sample.volume !== undefined && !Number.isFinite(sample.volume)) delete sample.volume;
    if (supply !== null && sample.price !== undefined) sample.valuation = sample.price * supply;
  }
  return { samples, supply, priceCount, interval };
}

export function chartNumber(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (value === 0) return "0";
  if (Math.abs(value) < 0.000001) return value.toExponential(3);
  return new Intl.NumberFormat("en-US", { notation: Math.abs(value) >= 1_000 ? "compact" : "standard", maximumSignificantDigits: 5 }).format(value);
}
