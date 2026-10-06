import type { RadarNetwork } from "./arc-radar-networks.js";
import { validPoolRef } from "./arc-radar-pool-id.js";

export type RecorderSnapshot = {
  version: number; network: string; chainId: number; generatedAt: number; leaseUntil: number; lastAttempt: number; lastSuccess: number;
  error: string | null; poolCount: number; poolLimitReached: boolean; eventCount: number;
  streams: Array<{ id: string; sourceId: string; pool: string | null; completedAt: number | null; lastAttempt: number;
    pending: boolean; initialized: boolean; bootstrapPartial: boolean; gaps: number; error: string | null }>;
  events: Array<{ pool: string; hash: string; index: number; block: number; blockHash: string; at: string; observedAt: number; kind: string; amount: string | null }>;
};
export const localRecorderAvailable = (url: URL): boolean => url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);

export function parseRecorderSnapshot(value: unknown, network: RadarNetwork, pool?: string, now = Date.now()): RecorderSnapshot {
  const data = value as RecorderSnapshot;
  const natural = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const time = (v: unknown) => natural(v) && (v as number) <= now;
  if (!data || data.version !== 1 || data.network !== network.id || data.chainId !== network.chainId || !time(data.generatedAt)
    || now - data.generatedAt > 30_000 || !time(data.lastAttempt) || !time(data.lastSuccess) || !natural(data.leaseUntil)
    || data.leaseUntil > now + 180_000 || typeof data.error !== "string" && data.error !== null || typeof data.poolLimitReached !== "boolean"
    || !natural(data.poolCount) || data.poolCount > 150 || !natural(data.eventCount) || data.eventCount > 100_000
    || !Array.isArray(data.streams) || data.streams.length > 154 || !Array.isArray(data.events) || data.events.length > 20) throw new Error("Invalid recorder response");
  for (const stream of data.streams) {
    if (!stream || typeof stream.id !== "string" || !network.sources.some(s => s.id === stream.sourceId) || stream.pool !== null && !validPoolRef(stream.pool)
      || stream.completedAt !== null && !time(stream.completedAt) || !time(stream.lastAttempt) || !natural(stream.gaps)
      || [stream.pending, stream.initialized, stream.bootstrapPartial].some(v => typeof v !== "boolean") || stream.error !== null && typeof stream.error !== "string") throw new Error("Invalid recorder stream");
  }
  for (const event of data.events) {
    if (!event || !validPoolRef(event.pool) || pool && event.pool !== pool || !/^0x[0-9a-f]{64}$/i.test(event.hash)
      || !/^0x[0-9a-f]{64}$/i.test(event.blockHash) || !natural(event.index) || !natural(event.block)
      || !time(event.observedAt) || !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) > event.observedAt
      || !["pool-created", "buy", "sell", "liquidity-add", "liquidity-remove"].includes(event.kind)
      || event.amount !== null && (typeof event.amount !== "string" || !/^\d{1,80}(\.\d{1,18})?$/.test(event.amount))) throw new Error("Invalid recorder event");
  }
  return data;
}

export async function readRecorderSnapshot(network: RadarNetwork, pageUrl: URL, pool?: string): Promise<RecorderSnapshot | null> {
  if (network.dataMode === "rpc-dex" || !localRecorderAvailable(pageUrl)) return null;
  if (pool && !validPoolRef(pool)) throw new Error("Invalid pool reference");
  const url = new URL("/api/arcrow/collector", pageUrl);
  url.searchParams.set("network", network.id); if (pool) url.searchParams.set("pool", pool);
  const response = await fetch(url, { credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000), headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const text = await response.text(); if (text.length > 200_000) throw new Error("Recorder response too large");
  return parseRecorderSnapshot(JSON.parse(text), network, pool);
}
