import { decodeEventLog, formatUnits, parseAbi, toEventSelector, type Hex } from "viem";
import { createDexAdapter, type AddressLog, type RadarPool } from "../src/arc-radar-dex.js";
import { V4_EVENTS } from "../src/arc-radar-v4.js";
import { poolRef } from "../src/arc-radar-pool-id.js";
import type { RadarDexSource, RadarNetwork } from "../src/arc-radar-networks.js";

export const V2_COLLECTOR_EVENTS = parseAbi([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 count)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
]);
const V2_TOPICS = new Map(V2_COLLECTOR_EVENTS.map(event => [toEventSelector(event), event.name]));
export const HASH = /^0x[0-9a-f]{64}$/i;
export const ADDRESS = /^0x[0-9a-f]{40}$/i;
export type CollectorLog = AddressLog & { block_hash: string; block_number: number; index: number; transaction_hash: string; block_timestamp: string };
export type CollectorEvent = { pool: string; hash: string; index: number; block: number; blockHash: string; at: string; observedAt: number;
  kind: "pool-created" | "buy" | "sell" | "liquidity-add" | "liquidity-remove"; amount: string | null };
export type CollectorPage = { items: CollectorLog[]; cursor: string | null };
export function logKey(log: CollectorLog): string { return `${log.transaction_hash.toLowerCase()}:${log.index}:${log.block_hash.toLowerCase()}`; }

export function validateCursor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pagination cursor");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 8 || entries.some(([key, val]) => !/^[a-z_]{1,40}$/.test(key)
    || !["string", "number"].includes(typeof val) || !/^[a-zA-Z0-9_-]{1,160}$/.test(String(val)))) throw new Error("Invalid pagination cursor");
  return new URLSearchParams(entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, String(val)])).toString();
}

export function collectorPage(input: unknown, emitter: string, now = Date.now()): CollectorPage {
  const page = input as { items?: unknown; next_page_params?: unknown } | null;
  if (!page || !Array.isArray(page.items) || page.items.length > 100) throw new Error("Invalid log page");
  const items = page.items as CollectorLog[];
  const seen = new Map<string, string>();
  for (const log of items) {
    if (!log || log.address?.hash?.toLowerCase() !== emitter.toLowerCase() || !HASH.test(log.transaction_hash ?? "") || !HASH.test(log.block_hash ?? "")
      || !Number.isSafeInteger(log.index) || log.index < 0 || !Number.isSafeInteger(log.block_number) || log.block_number < 0
      || !Number.isFinite(Date.parse(log.block_timestamp)) || Date.parse(log.block_timestamp) <= 0 || Date.parse(log.block_timestamp) > now
      || !Array.isArray(log.topics) || !log.topics.length || log.topics.length > 4
      || log.topics.filter(t => t !== null).some(t => typeof t !== "string" || !HASH.test(t))
      || typeof log.topics[0] !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data ?? "") || log.data!.length > 20_000) throw new Error("Invalid indexed event identity");
    const key = `${log.transaction_hash.toLowerCase()}:${log.index}`;
    const fingerprint = JSON.stringify([log.block_hash, log.block_number, log.block_timestamp, log.data, log.topics]);
    if (seen.has(key) && seen.get(key) !== fingerprint) throw new Error("Conflicting indexed events");
    seen.set(key, fingerprint);
  }
  const unique = [...new Map(items.map(log => [logKey(log), log])).values()];
  for (let i = 1; i < unique.length; i++) {
    if (unique[i].block_number > unique[i - 1].block_number || unique[i].block_number === unique[i - 1].block_number && unique[i].index >= unique[i - 1].index) throw new Error("Unordered indexed page");
  }
  return { items: unique, cursor: validateCursor(page.next_page_params) };
}

function v2Decode(log: CollectorLog): CollectorLog {
  const name = V2_TOPICS.get(log.topics![0] as Hex);
  if (!name) return { ...log, decoded: null };
  const topics = log.topics!.filter((topic): topic is Hex => topic !== null) as [Hex, ...Hex[]];
  const event = decodeEventLog({ abi: V2_COLLECTOR_EVENTS, topics, data: log.data as Hex, strict: true });
  const expected = name === "Swap" ? [3, 128] : name === "Mint" ? [2, 64] : [3, 64];
  if (topics.length !== expected[0] || log.data!.length !== expected[1] * 2 + 2) throw new Error("Invalid v2 event encoding");
  return { ...log, decoded: { method_call: `${event.eventName}(...)`, parameters: Object.entries(event.args).map(([name, value]) => ({ name, value: String(value) })) } };
}

export function collectDecoded(network: RadarNetwork, source: RadarDexSource, logs: CollectorLog[], known: RadarPool[], now: number) {
  const adapter = createDexAdapter(source, network);
  const normalized = source.protocol === "uniswap-v2" ? logs.map(v2Decode) : logs;
  if (source.protocol === "uniswap-v4" && adapter.historyIncomplete?.(normalized)) throw new Error("Invalid v4 indexed event");
  const discovered = adapter.pairSeeds({ items: normalized.filter(log => log.address?.hash?.toLowerCase() === source.factoryAddress.toLowerCase()) });
  const pools = [...new Map([...known, ...discovered].map(pool => [poolRef(pool), pool])).values()];
  const events: CollectorEvent[] = [];
  for (const log of normalized) {
    const base = { hash: log.transaction_hash.toLowerCase(), index: log.index, block: log.block_number, blockHash: log.block_hash.toLowerCase(), at: new Date(log.block_timestamp).toISOString(), observedAt: now };
    const createdHere = new Set(adapter.pairSeeds({ items: [log].filter(item => item.address?.hash?.toLowerCase() === source.factoryAddress.toLowerCase()) }).map(poolRef));
    for (const pool of pools) {
      if (pool.sourceId !== source.id) continue;
      if (pool.creationTx.toLowerCase() === base.hash && createdHere.has(poolRef(pool))) {
        if (log.decoded?.method_call?.startsWith("PairCreated(") || pool.v4 && log.topics?.[0] === toEventSelector(V4_EVENTS[0])) events.push({ ...base, pool: poolRef(pool), kind: "pool-created", amount: null });
      }
      if (log.address?.hash?.toLowerCase() !== pool.pairAddress.toLowerCase()) continue;
      if (pool.v4) {
        const trade = adapter.trade(log, pool);
        if (trade) {
          const parsed = decodeEventLog({ abi: V4_EVENTS, topics: log.topics!.filter((v): v is Hex => v !== null) as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
          if (parsed.eventName !== "Swap") continue;
          const raw = pool.token0.toLowerCase() === pool.quoteAsset.address.toLowerCase() ? parsed.args.amount0 : parsed.args.amount1;
          events.push({ ...base, pool: poolRef(pool), kind: trade.direction, amount: formatUnits(raw < 0n ? -raw : raw, pool.quoteAsset.decimals) });
        }
      } else {
        const parameter = (name: string) => BigInt(log.decoded?.parameters?.find(p => p.name === name)?.value ?? "0");
        const quote = pool.token0.toLowerCase() === pool.quoteAsset.address.toLowerCase() ? "0" : "1";
        const trade = adapter.trade(log, pool);
        if (trade) events.push({ ...base, pool: poolRef(pool), kind: trade.direction,
          amount: formatUnits(parameter(`amount${quote}${trade.direction === "buy" ? "In" : "Out"}`), pool.quoteAsset.decimals) });
        else if (/^(Mint|Burn)\(/.test(log.decoded?.method_call ?? "")) events.push({ ...base, pool: poolRef(pool),
          kind: log.decoded!.method_call!.startsWith("Mint(") ? "liquidity-add" : "liquidity-remove", amount: formatUnits(parameter(`amount${quote}`), pool.quoteAsset.decimals) });
      }
    }
  }
  return { discovered, events };
}
