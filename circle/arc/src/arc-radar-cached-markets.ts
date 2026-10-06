import type { DexLogPage, RadarDexAdapter, RadarPool } from "./arc-radar-dex.js";
import { poolRef } from "./arc-radar-pool-id.js";

export const MARKET_CACHE_MAX_AGE = 86_400_000;
export const dataCacheKey = (path: string) => path.replace(/[^a-z0-9]+/gi, "-");

export function usableCacheTime(savedAt: unknown, now = Date.now()): savedAt is number {
  return typeof savedAt === "number" && Number.isFinite(savedAt) && savedAt > 0
    && savedAt <= now && now - savedAt <= MARKET_CACHE_MAX_AGE;
}

export function writeMarketCache(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">,
  prefix: string, key: string, serialized: string): void {
  try { storage.setItem(prefix + key, serialized); return; }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
  }
  // Evict only disposable API responses. Never touch watchlists, observations,
  // preferences, other networks, or another application's storage.
  const entries: Array<{ key: string; size: number; savedAt: number; cursor: boolean }> = [];
  for (let index = 0; index < Math.min(storage.length, 10_000); index++) {
    const candidate = storage.key(index);
    if (!candidate?.startsWith(prefix) || candidate === prefix + key) continue;
    const suffix = candidate.slice(prefix.length);
    if (!/^-(?:addresses|tokens|transactions|smart-contracts)-0x[\da-f]{40}(?:[\da-f]{24})?(?:-|$)/i.test(suffix)) continue;
    const raw = storage.getItem(candidate);
    if (!raw) continue;
    let savedAt = 0;
    try { savedAt = Number(JSON.parse(raw)?.savedAt) || 0; } catch { /* Corrupt cache is disposable. */ }
    entries.push({ key: candidate, size: raw.length, savedAt, cursor: suffix.includes("-before-") });
  }
  entries.sort((a, b) => Number(b.cursor) - Number(a.cursor) || a.savedAt - b.savedAt);
  let freed = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    storage.removeItem(entry.key); freed += entry.size;
    if (freed < Math.max(16_000, serialized.length) && index < entries.length - 1) continue;
    try { storage.setItem(prefix + key, serialized); return; }
    catch (error) {
      if (!(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
      freed = 0;
    }
  }
  throw new Error("Market cache storage is full.");
}

export function rememberFactoryPage(storage: Storage, prefix: string, adapter: RadarDexAdapter, page: DexLogPage, now = Date.now()): void {
  const key = `factory-events:v1:${adapter.source.id}`;
  let previous: DexLogPage = {};
  try {
    const entry = JSON.parse(storage.getItem(prefix + key) ?? "null");
    if (usableCacheTime(entry?.savedAt, now) && Array.isArray(entry?.data?.items)) previous = entry.data;
  } catch { /* Start a new discovery journal when the old cache is invalid. */ }
  const events = new Map<string, NonNullable<DexLogPage["items"]>[number]>();
  for (const log of [...(previous.items ?? []).slice(0, 150), ...(page.items ?? []).slice(0, 160)]) {
    const seed = adapter.pairSeeds({ items: [log] })[0];
    if (seed && Date.parse(seed.createdAt) <= now) events.set(poolRef(seed), log);
  }
  const items = [...events.values()].sort((a, b) => Date.parse(b.block_timestamp!) - Date.parse(a.block_timestamp!)).slice(0, 150);
  writeMarketCache(storage, prefix, key, JSON.stringify({ savedAt: now, data: { items } }));
}

// Re-decode saved factory events, not stored computed prices or arbitrary pool URLs.
export function cachedPoolSeeds(storage: Pick<Storage, "length" | "key" | "getItem">,
  prefix: string, adapters: readonly RadarDexAdapter[], now = Date.now(),
  retainPage?: (adapter: RadarDexAdapter, page: DexLogPage) => void): RadarPool[] {
  const pages: Array<{ adapter: RadarDexAdapter; key: string }> = [];
  try {
    for (let index = 0; index < Math.min(storage.length, 10_000) && pages.length < 200; index++) {
      const key = storage.key(index);
      if (!key) continue;
      const adapter = adapters.find(value => {
        const base = prefix + dataCacheKey(value.discoveryPath);
        return key === `${prefix}factory-events:v1:${value.source.id}` || key === base
          || key.startsWith(`${base}-before-`) && !key.includes("-pool-");
      });
      if (adapter) pages.push({ adapter, key });
    }
  } catch { return []; }
  const pools = new Map<string, RadarPool>();
  for (const { adapter, key } of pages) {
    try {
      const raw = storage.getItem(key);
      if (!raw || raw.length > 2_000_000) continue;
      const entry = JSON.parse(raw) as { savedAt?: unknown; data?: DexLogPage };
      if (!usableCacheTime(entry?.savedAt, now) || !Array.isArray(entry.data?.items) || entry.data.items.length > 160) continue;
      for (const seed of adapter.pairSeeds(entry.data)) {
        if (Date.parse(seed.createdAt) > now) continue;
        pools.set(poolRef(seed), seed);
      }
      if (!key.includes("factory-events:v1:")) retainPage?.(adapter, entry.data);
    } catch { /* Ignore corrupt or unavailable pages independently. */ }
  }
  return [...pools.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 150);
}
