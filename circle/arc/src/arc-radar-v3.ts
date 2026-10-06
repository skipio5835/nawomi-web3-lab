import { decodeEventLog, formatUnits, parseAbi, type Hex } from "viem";
import type { AddressLog, RadarDexAdapter, RadarPool } from "./arc-radar-dex.js";
import type { RadarDexSource, RadarNetwork } from "./arc-radar-networks.js";

export const V3_EVENTS = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  "event Initialize(uint160 sqrtPriceX96, int24 tick)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

function decode(log: AddressLog) {
  if (!/^0x[\da-f]{40}$/i.test(log.address?.hash ?? "") || !/^0x[\da-f]{64}$/i.test(log.transaction_hash ?? "")
    || !Number.isSafeInteger(log.index) || log.index! < 0 || !Number.isSafeInteger(log.block_number) || log.block_number! < 0
    || !Number.isFinite(Date.parse(log.block_timestamp ?? "")) || !/^0x(?:[\da-f]{2})*$/i.test(log.data ?? "")) return null;
  try {
    const topics = log.topics?.filter((topic): topic is Hex => topic !== null && /^0x[\da-f]{64}$/i.test(topic));
    if (!topics?.length || topics.length !== log.topics?.filter(topic => topic !== null).length) return null;
    const event = decodeEventLog({ abi: V3_EVENTS, topics: topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
    const shape = event.eventName === "PoolCreated" ? [4, 64] : event.eventName === "Swap" ? [3, 160] : [1, 64];
    return topics.length === shape[0] && log.data!.length === 2 + shape[1]! * 2 ? event : null;
  } catch { return null; }
}

export function createV3Adapter(source: RadarDexSource, network: RadarNetwork): RadarDexAdapter {
  const factory = source.factoryAddress.toLowerCase(), quote = network.quoteAsset.address.toLowerCase();
  if (source.protocol !== "uniswap-v3" || !/^0x[\da-f]{40}$/.test(factory) || BigInt(factory) === 0n) throw new Error("Invalid v3 factory.");
  function checkPool(pool: RadarPool) {
    if (!pool.v3 || pool.v4 || pool.chainId !== network.chainId || pool.sourceId !== source.id
      || pool.quoteAsset.address.toLowerCase() !== quote || pool.quoteAsset.decimals !== network.quoteAsset.decimals
      || ![pool.token0.toLowerCase(), pool.token1.toLowerCase()].includes(quote)) throw new Error("Pool does not belong to this v3 DEX and network.");
  }
  function eventFor(log: AddressLog, pool: RadarPool) {
    checkPool(pool);
    if (log.address?.hash?.toLowerCase() !== pool.pairAddress.toLowerCase()) return null;
    const event = decode(log);
    return event?.eventName === "Swap" || event?.eventName === "Initialize" ? event : null;
  }
  return {
    source, discoveryPath: `/addresses/${factory}/logs`,
    historyIncomplete: logs => logs.some(log => decode(log) === null),
    pairSeeds(page) {
      const found = new Map<string, RadarPool>();
      for (const log of page.items ?? []) {
        if (log.address?.hash?.toLowerCase() !== factory) continue;
        const event = decode(log);
        if (event?.eventName !== "PoolCreated") continue;
        const { token0, token1, fee, tickSpacing, pool } = event.args;
        if (BigInt(token0) === 0n || BigInt(token0) >= BigInt(token1) || BigInt(pool) === 0n
          || ![token0.toLowerCase(), token1.toLowerCase()].includes(quote) || fee >= 1_000_000 || tickSpacing <= 0 || tickSpacing > 32767) continue;
        found.set(pool.toLowerCase(), { sourceId: source.id, chainId: network.chainId, quoteAsset: network.quoteAsset,
          pairAddress: pool, token0, token1, tokenAddress: token0.toLowerCase() === quote ? token1 : token0,
          createdAt: log.block_timestamp!, creationTx: log.transaction_hash!, v3: { fee, tickSpacing } });
      }
      return [...found.values()];
    },
    latestReserves(_logs, pool) { checkPool(pool); return null; },
    pricePoint(log, pool, decimals) {
      const event = eventFor(log, pool);
      if (!event || decimals === null || !/^\d{1,3}$/.test(decimals) || Number(decimals) > 255 || event.args.sqrtPriceX96 <= 0n) return null;
      const sqrt = event.args.sqrtPriceX96, ratio = Number(sqrt * sqrt) / Number(1n << 192n);
      const price = (pool.token1.toLowerCase() === quote ? ratio : 1 / ratio) * 10 ** (Number(decimals) - pool.quoteAsset.decimals);
      return Number.isFinite(price) && price > 0 ? { price, timestamp: log.block_timestamp!, blockNumber: log.block_number, eventIndex: log.index } : null;
    },
    trade(log, pool) {
      const event = eventFor(log, pool);
      if (event?.eventName !== "Swap") return null;
      const quoteIs0 = pool.token0.toLowerCase() === quote;
      const quoteDelta = quoteIs0 ? event.args.amount0 : event.args.amount1;
      const tokenDelta = quoteIs0 ? event.args.amount1 : event.args.amount0;
      // v3 reports pool balance deltas, the opposite sign convention to v4 caller deltas.
      const direction = quoteDelta > 0n && tokenDelta < 0n ? "buy" : quoteDelta < 0n && tokenDelta > 0n ? "sell" : null;
      if (!direction) return null;
      return { direction, fallbackAddress: null, timestamp: log.block_timestamp!, transactionHash: log.transaction_hash!,
        eventIndex: log.index, usdcValue: Number(formatUnits(quoteDelta < 0n ? -quoteDelta : quoteDelta, pool.quoteAsset.decimals)) };
    },
    liquidityEvents(_logs, pool) { checkPool(pool); return []; },
  };
}
