import { encodeAbiParameters, encodeEventTopics, type Address } from "viem";
import { V4_EVENTS, v4PoolId } from "../../src/arc-radar-v4.js";
import { ARC_RADAR_TESTNET, type RadarDexSource } from "../../src/arc-radar-networks.js";

// Synthetic protocol fixtures, never a live deployment or market-data source.
export const manager = "0x9900000000000000000000000000000000000000";
export const token = "0x1000000000000000000000000000000000000000";
export const hooks = "0x0000000000000000000000000000000000000000";
export const source: RadarDexSource = { id: "fixture-v4", label: "Fixture v4", protocol: "uniswap-v4", factoryAddress: manager, poolManagerAddress: manager };
export function initialize(options: { fee?: number; currency0?: Address; currency1?: Address; sqrt?: bigint; hooks?: Address; index?: number } = {}) {
  const currency0 = options.currency0 ?? token;
  const currency1 = options.currency1 ?? ARC_RADAR_TESTNET.quoteAsset.address as Address;
  const fee = options.fee ?? 3000;
  const hook = options.hooks ?? hooks;
  const id = v4PoolId(currency0, currency1, fee, 60, hook);
  return {
    address: { hash: manager }, block_number: 100, index: options.index ?? 1,
    block_timestamp: "2026-09-14T00:00:00Z", transaction_hash: `0x${"ab".repeat(32)}`,
    topics: encodeEventTopics({ abi: V4_EVENTS, eventName: "Initialize", args: { id, currency0, currency1 } }).filter((topic): topic is `0x${string}` => typeof topic === "string"),
    data: encodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }], [fee, 60, hook, options.sqrt ?? 1n << 96n, 0]),
  };
}
export function swap(id: `0x${string}`, amount0 = 1_000_000n, amount1 = -2_000_000n, sqrt = 1n << 96n, index = 2) {
  return {
    address: { hash: manager }, block_number: 101, index,
    block_timestamp: "2026-09-14T00:00:01Z", transaction_hash: `0x${"cd".repeat(32)}`,
    topics: encodeEventTopics({ abi: V4_EVENTS, eventName: "Swap", args: { id, sender: manager } }).filter((topic): topic is `0x${string}` => typeof topic === "string"),
    data: encodeAbiParameters([{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }], [amount0, amount1, sqrt, 10n ** 12n, 0, 3000]),
  };
}
