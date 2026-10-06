import { decodeEventLog, encodeAbiParameters, formatUnits, keccak256, parseAbi, toEventSelector, type Address, type Hex } from "viem";
import type { AddressLog, DexPricePoint, RadarDexAdapter, RadarPool } from "./arc-radar-dex.js";
import type { RadarDexSource, RadarNetwork } from "./arc-radar-networks.js";
import { poolRef } from "./arc-radar-pool-id.js";

// IPoolManager events; decoded explorer labels alone are not protocol evidence.
export const V4_EVENTS = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const V4_TOPICS = new Set(V4_EVENTS.map(event => toEventSelector(event)));

export function v4PoolId(currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Hex {
  return keccak256(encodeAbiParameters([
    { type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" },
  ], [currency0, currency1, fee, tickSpacing, hooks]));
}

export function comparePricePoints(a: DexPricePoint, b: DexPricePoint): number {
  if (a.blockNumber !== undefined && b.blockNumber !== undefined) {
    return a.blockNumber - b.blockNumber || (a.eventIndex ?? 0) - (b.eventIndex ?? 0);
  }
  return Date.parse(a.timestamp) - Date.parse(b.timestamp) || (a.eventIndex ?? 0) - (b.eventIndex ?? 0);
}

export function createV4Adapter(source: RadarDexSource, network: RadarNetwork): RadarDexAdapter {
  const manager = source.poolManagerAddress?.toLowerCase();
  if (!manager || !/^0x[\da-f]{40}$/.test(manager) || BigInt(manager) === 0n
    || manager !== source.factoryAddress.toLowerCase()) throw new Error("Invalid v4 PoolManager configuration");
  const quotes = [network.quoteAsset, ...(network.nativeQuoteAsset ? [network.nativeQuoteAsset] : [])];
  function decode(log: AddressLog) {
    if (log.address?.hash?.toLowerCase() !== manager || !/^0x[\da-f]{64}$/i.test(log.transaction_hash ?? "")
      || !Number.isSafeInteger(log.index) || log.index! < 0
      || !Number.isSafeInteger(log.block_number) || log.block_number! < 0
      || !Number.isFinite(Date.parse(log.block_timestamp ?? ""))) return null;
    try {
      const topics = log.topics?.filter((topic): topic is Hex => topic !== null && /^0x[\da-f]{64}$/i.test(topic));
      if (!topics?.length || topics.length !== log.topics?.filter(topic => topic !== null).length
        || !/^0x(?:[\da-f]{2})*$/i.test(log.data ?? "")) return null;
      const result = decodeEventLog({ abi: V4_EVENTS, data: log.data as Hex, topics: topics as [Hex, ...Hex[]], strict: true });
      const expectedTopics = result.eventName === "Initialize" ? 4 : 3;
      const expectedBytes = result.eventName === "Initialize" ? 160 : 192;
      return topics.length === expectedTopics && log.data!.length === 2 + expectedBytes * 2 ? result : null;
    } catch { return null; }
  }
  function checkPool(pool: RadarPool) {
    const quote = quotes.find(value => value.address.toLowerCase() === pool.quoteAsset.address.toLowerCase());
    if (!pool.v4 || pool.chainId !== network.chainId || pool.sourceId !== source.id || pool.pairAddress.toLowerCase() !== manager
      || quote?.decimals !== pool.quoteAsset.decimals
      || v4PoolId(pool.token0 as Address, pool.token1 as Address, pool.v4.fee, pool.v4.tickSpacing, pool.v4.hooks as Address) !== pool.v4.poolId.toLowerCase()) {
      throw new Error("Pool does not belong to this v4 DEX and network");
    }
  }
  function eventFor(log: AddressLog, pool: RadarPool) {
    checkPool(pool);
    const event = decode(log);
    return event?.args.id.toLowerCase() === pool.v4!.poolId.toLowerCase() ? event : null;
  }
  return {
    source,
    discoveryPath: `/addresses/${manager}/logs`,
    historyIncomplete(logs) {
      return logs.some(log => log.address?.hash?.toLowerCase() !== manager
        || !/^0x[\da-f]{64}$/i.test(log.transaction_hash ?? "")
        || !Number.isSafeInteger(log.index) || log.index! < 0
        || !Number.isSafeInteger(log.block_number) || log.block_number! < 0
        || !Number.isFinite(Date.parse(log.block_timestamp ?? ""))
        || !Array.isArray(log.topics) || !/^0x[\da-f]{64}$/i.test(log.topics[0] ?? "")
        || !/^0x(?:[\da-f]{2})*$/i.test(log.data ?? "")
        || (V4_TOPICS.has(log.topics[0] as Hex) && decode(log) === null));
    },
    pairSeeds(page) {
      const found = new Map<string, RadarPool>();
      for (const log of page.items ?? []) {
        const event = decode(log);
        if (event?.eventName !== "Initialize") continue;
        const { currency0, currency1, id, fee, tickSpacing, hooks, sqrtPriceX96 } = event.args;
        const quote0 = quotes.find(quote => quote.address.toLowerCase() === currency0.toLowerCase());
        const quote1 = quotes.find(quote => quote.address.toLowerCase() === currency1.toLowerCase());
        const quoteAsset = quote0 ?? quote1;
        if (!quoteAsset || (quote0 && quote1) || BigInt(currency0) >= BigInt(currency1)
          || tickSpacing < 1 || tickSpacing > 32767 || (fee > 1_000_000 && fee !== 0x800000)
          || sqrtPriceX96 <= 0n || v4PoolId(currency0, currency1, fee, tickSpacing, hooks) !== id) continue;
        const pool: RadarPool = {
          sourceId: source.id, chainId: network.chainId, quoteAsset, pairAddress: manager,
          createdAt: log.block_timestamp!, creationTx: log.transaction_hash!,
          token0: currency0, token1: currency1, tokenAddress: quote0 ? currency1 : currency0,
          v4: { poolId: id, fee, tickSpacing, hooks },
        };
        found.set(poolRef(pool), pool);
      }
      return [...found.values()];
    },
    latestReserves(_logs, pool) { checkPool(pool); return null; },
    pricePoint(log, pool, decimals) {
      const event = eventFor(log, pool);
      if (!event || decimals === null || !/^\d{1,3}$/.test(decimals) || Number(decimals) > 255) return null;
      const sqrt = event.args.sqrtPriceX96;
      if (sqrt <= 0n) return null;
      const ratio = Number(sqrt * sqrt) / Number(1n << 192n);
      const quoteIs1 = pool.token1.toLowerCase() === pool.quoteAsset.address.toLowerCase();
      const price = (quoteIs1 ? ratio : 1 / ratio) * 10 ** (Number(decimals) - pool.quoteAsset.decimals);
      return Number.isFinite(price) && price > 0
        ? { price, timestamp: log.block_timestamp!, blockNumber: log.block_number, eventIndex: log.index } : null;
    },
    trade(log, pool) {
      const event = eventFor(log, pool);
      if (event?.eventName !== "Swap") return null;
      const quoteIs0 = pool.token0.toLowerCase() === pool.quoteAsset.address.toLowerCase();
      const quoteDelta = quoteIs0 ? event.args.amount0 : event.args.amount1;
      const tokenDelta = quoteIs0 ? event.args.amount1 : event.args.amount0;
      // PoolManager emits caller deltas before hook adjustments: negative input, positive output.
      const direction = quoteDelta < 0n && tokenDelta > 0n ? "buy" : quoteDelta > 0n && tokenDelta < 0n ? "sell" : null;
      if (!direction) return null;
      return { direction, fallbackAddress: null, timestamp: log.block_timestamp!, transactionHash: log.transaction_hash!,
        eventIndex: log.index, usdcValue: Number(formatUnits(quoteDelta < 0n ? -quoteDelta : quoteDelta, pool.quoteAsset.decimals)) };
    },
    // Concentrated-liquidity deltas are not token amounts or a proof of per-pool TVL.
    liquidityEvents(_logs, pool) { checkPool(pool); return []; },
  };
}
