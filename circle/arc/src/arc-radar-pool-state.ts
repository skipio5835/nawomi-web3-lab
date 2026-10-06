import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import type { RadarPool } from "./arc-radar-dex.js";

export type PoolState = {
  address: string; poolId: string | null; sqrtPriceX96: string;
  blockNumber: number; blockHash: string; timestamp: string;
};
export const V3_SLOT0 = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"]);
const EXTSLOAD = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);
// Uniswap v4-core StateLibrary.POOLS_SLOT, checked 2026-09-16. Restricted to
// configured canonical managers; never read a pool manager's shared balances.
// https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol
export function v4Slot0Call(poolId: string): Hex {
  if (!/^0x[0-9a-f]{64}$/i.test(poolId)) throw new Error("Invalid pool ID.");
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId as Hex, 6n]));
  return encodeFunctionData({ abi: EXTSLOAD, functionName: "extsload", args: [slot] });
}
export function decodePoolSqrt(value: unknown, v4: boolean): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)
    || value.length !== 2 + (v4 ? 32 : 224) * 2) throw new Error("Invalid RPC pool state.");
  if (v4) return BigInt(value) & ((1n << 160n) - 1n);
  const [sqrt] = decodeAbiParameters(V3_SLOT0[0].outputs, value as Hex);
  if (sqrt >= 1n << 160n) throw new Error("Invalid RPC pool price.");
  return sqrt;
}

export function poolStatePrice(state: PoolState | null | undefined, pool: RadarPool, decimals: string | null, now = Date.now()): number | null {
  if (!state || state.address?.toLowerCase() !== pool.pairAddress.toLowerCase()
    || (state.poolId?.toLowerCase() !== pool.v4?.poolId.toLowerCase() && !(state.poolId === null && !pool.v4))
    || !/^[0-9]+$/.test(state.sqrtPriceX96) || state.sqrtPriceX96.length > 49
    || !/^0x[0-9a-f]{64}$/i.test(state.blockHash) || !Number.isSafeInteger(state.blockNumber) || state.blockNumber < 0
    || !Number.isFinite(Date.parse(state.timestamp)) || Date.parse(state.timestamp) > now
    || typeof decimals !== "string" || !/^\d{1,3}$/.test(decimals) || Number(decimals) > 255) return null;
  const quoteIs0 = pool.token0.toLowerCase() === pool.quoteAsset.address.toLowerCase();
  const quoteIs1 = pool.token1.toLowerCase() === pool.quoteAsset.address.toLowerCase();
  if (quoteIs0 === quoteIs1 || pool.tokenAddress.toLowerCase() !== (quoteIs0 ? pool.token1 : pool.token0).toLowerCase()) return null;
  const sqrt = BigInt(state.sqrtPriceX96);
  if (sqrt <= 0n || sqrt >= 1n << 160n) return null;
  const ratio = Number(sqrt * sqrt) / Number(1n << 192n);
  const price = (quoteIs0 ? 1 / ratio : ratio) * 10 ** (Number(decimals) - pool.quoteAsset.decimals);
  return Number.isFinite(price) && price > 0 ? price : null;
}
