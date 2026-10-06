import { poolRef } from "./arc-radar-pool-id.js";

export type MarketSort = "default" | "newest" | "volume" | "fdv" | "liquidity" | "recent";

type DiscoveryMarket = {
  pairAddress: string;
  createdAt: string;
  lastTradeAt: string | null;
  totalLiquidity: number | null;
  fdv?: number | null;
  sellCount: number;
  periods: { h24: { swapCount: number; volumeUsdc: number } };
};

export type DiscoveryOptions = {
  sort: MarketSort;
  minimumLiquidity: number;
  minimumFdv?: number;
  traded24h: boolean;
  sellSeen: boolean;
};

function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortableNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : -1;
}

export function refineMarkets<T extends DiscoveryMarket>(markets: T[], options: DiscoveryOptions): T[] {
  const result = markets.filter((market) =>
    (options.minimumLiquidity <= 0 || (market.totalLiquidity !== null && Number.isFinite(market.totalLiquidity) && market.totalLiquidity >= options.minimumLiquidity))
    && (!(options.minimumFdv && options.minimumFdv > 0) || (typeof market.fdv === "number" && Number.isFinite(market.fdv) && market.fdv >= options.minimumFdv))
    && (!options.traded24h || market.periods.h24.swapCount > 0)
    && (!options.sellSeen || market.sellCount > 0));
  if (options.sort === "default") return result;
  return result.sort((a, b) => {
    const difference = options.sort === "volume" ? sortableNumber(b.periods.h24.volumeUsdc) - sortableNumber(a.periods.h24.volumeUsdc)
      : options.sort === "fdv" ? sortableNumber(b.fdv) - sortableNumber(a.fdv)
      : options.sort === "liquidity" ? sortableNumber(b.totalLiquidity) - sortableNumber(a.totalLiquidity)
      : options.sort === "recent" ? timestamp(b.lastTradeAt) - timestamp(a.lastTradeAt) : 0;
    return difference || timestamp(b.createdAt) - timestamp(a.createdAt) || a.pairAddress.localeCompare(b.pairAddress);
  });
}

// Read one extra seed to distinguish a full result page from the end of history.
export async function discoverSeeds<T extends { pairAddress: string }>(
  firstPath: string,
  limit: number,
  readPage: (path: string) => Promise<{ seeds: T[]; nextPath: string | null; stale: boolean }>,
  maxPages = 10,
): Promise<{ seeds: T[]; hasMore: boolean; stale: boolean; limited: boolean }> {
  const found = new Map<string, T>();
  const visited = new Set<string>();
  let path: string | null = firstPath;
  let stale = false;
  while (path && visited.size < maxPages && found.size <= limit && !visited.has(path)) {
    visited.add(path);
    const page = await readPage(path);
    stale ||= page.stale;
    for (const seed of page.seeds) {
      const key = poolRef(seed);
      if (!found.has(key)) found.set(key, seed);
    }
    path = page.nextPath;
  }
  return {
    seeds: [...found.values()].slice(0, limit),
    hasMore: found.size > limit,
    stale,
    limited: Boolean(path) && found.size <= limit,
  };
}
