import type { AddressLog, RadarPool } from "./arc-radar-dex.js";
import type { PoolState } from "./arc-radar-pool-state.js";
import { poolRef } from "./arc-radar-pool-id.js";

export type SnapshotToken = {
  address_hash: string; decimals: string | null; holders_count: string | null;
  name: string | null; symbol: string | null; total_supply: string | null; type: string;
};
export type MarketBundle = {
  seed: RadarPool;
  token: SnapshotToken;
  logs: AddressLog[];
  state: PoolState;
  fetchedAt: number;
};
export type CollectionFailure = {
  at: number;
  stage: "discovery" | "lookup" | "pool" | "collector";
  target: string;
  reason: "rate-limit" | "request-timeout" | "upstream-error" | "invalid-data" | "unknown";
};
export type CollectionReport = {
  completedAt: number; budgetReached: boolean; failureCount: number;
  updatedPools: number; failures: CollectionFailure[];
};
export type MarketFeed = {
  version: 1; network: string; chainId: number; collecting: boolean;
  lastAttempt: number; lastSuccess: number; error: boolean;
  discovered: number; queued: number; bundles: MarketBundle[];
  collection?: CollectionReport;
};
export const SNAPSHOT_LIMITS = { pools: 150, logs: 32, bytes: 8_000_000, staleMs: 180_000 } as const;

export function snapshotIsStale(fetchedAt: number, now = Date.now()): boolean {
  return !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0 || fetchedAt > now || now - fetchedAt > SNAPSHOT_LIMITS.staleMs;
}

export function linkedMarketBundles(feed: MarketFeed, link: { pool: string | null; token: string | null }): MarketBundle[] {
  if (!link.pool && !link.token) return [];
  return feed.bundles.filter(bundle => link.pool ? poolRef(bundle.seed).toLowerCase() === link.pool.toLowerCase()
    : bundle.seed.tokenAddress.toLowerCase() === link.token!.toLowerCase());
}

export async function readMarketFeed(network: string, chainId: number): Promise<MarketFeed> {
  const response = await fetch(`/api/arcrow/markets?network=${encodeURIComponent(network)}`, {
    signal: AbortSignal.timeout(4000), headers: { Accept: "application/json" }, credentials: "omit", redirect: "error",
  });
  if (!response.ok) throw new Error("Local market feed unavailable. Saved rows have been retained.");
  if (Number(response.headers.get("content-length")) > SNAPSHOT_LIMITS.bytes) throw new Error("Market feed too large.");
  const text = await response.text();
  if (text.length > SNAPSHOT_LIMITS.bytes) throw new Error("Market feed too large.");
  const feed = JSON.parse(text) as MarketFeed;
  if (feed.version !== 1 || feed.network !== network || feed.chainId !== chainId || !Array.isArray(feed.bundles)
    || feed.bundles.length > SNAPSHOT_LIMITS.pools || feed.bundles.some(bundle =>
      bundle.seed?.chainId !== chainId || !Array.isArray(bundle.logs) || bundle.logs.length > SNAPSHOT_LIMITS.logs
      || bundle.token?.address_hash?.toLowerCase() !== bundle.seed.tokenAddress?.toLowerCase()
      || !Number.isSafeInteger(bundle.fetchedAt))) throw new Error("Invalid local market feed.");
  return feed;
}
