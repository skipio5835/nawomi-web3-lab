import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";
import type { RadarPool } from "./arc-radar-dex.js";
import type { RadarNetwork } from "./arc-radar-networks.js";
import { createV3Adapter } from "./arc-radar-v3.js";

// Platform-published deployment, not a Circle endorsement. Never infer origins
// from token names, trading venues, or user-supplied metadata URLs.
export const LAUNCH_PLATFORMS = [{
  id: "arcpad", name: "ArcPad", chainId: 5042,
  emitter: "0x24196cd6e534cfce8f480b53e70809b68ea86f29",
  deploymentBlock: 19_014_715, docs: "https://arcpad.meme/docs", checkedAt: "2026-09-16",
}] as const;
export const LAUNCH_ABI = parseAbi([
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, address pool, string imageURI, string website, string twitter, string telegram)",
]);
export const LAUNCH_TOPIC = toEventSelector(LAUNCH_ABI[0]);
export const LAUNCH_LOOKBACK_BLOCKS = 1000;
type Platform = typeof LAUNCH_PLATFORMS[number];
export type LaunchBlock = { number: number; hash: string; timestamp: number };
export type LaunchEvidence = {
  platform: Platform; token: string; creator: string; pool: string;
  transactionHash: string; blockNumber: number; blockHash: string; logIndex: number;
};
export type LaunchOrigin =
  | { status: "verified"; evidence: LaunchEvidence; checkedAt: number }
  | { status: "unknown"; fromBlock: number; toBlock: number; checkedAt: number }
  | { status: "unavailable" | "unsupported"; checkedAt: number };
type Transport = {
  head(): Promise<LaunchBlock>;
  block(number: number, signal: AbortSignal): Promise<LaunchBlock>;
  receipt(hash: string, signal: AbortSignal): Promise<unknown>;
  logs(filter: { address: string; topics: string[]; fromBlock: string; toBlock: string }, signal: AbortSignal): Promise<unknown>;
};
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const hex = (n: number) => `0x${n.toString(16)}`;
function quantity(value: unknown): number {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error("Invalid launch quantity.");
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) throw new Error("Invalid launch quantity.");
  return number;
}
function logInReceipt(log: any, receipt: any): boolean {
  return log?.removed === false && HASH.test(log.transactionHash) && HASH.test(log.blockHash)
    && log.transactionHash.toLowerCase() === receipt.transactionHash.toLowerCase()
    && log.blockHash.toLowerCase() === receipt.blockHash.toLowerCase()
    && quantity(log.blockNumber) === quantity(receipt.blockNumber);
}
function launchEvent(log: any, platform: Platform, token: string) {
  if (typeof log?.address !== "string" || log.address.toLowerCase() !== platform.emitter
    || log.topics?.[0]?.toLowerCase() !== LAUNCH_TOPIC) return null;
  if (!Array.isArray(log.topics) || log.topics.length !== 3 || !log.topics.every((t: unknown) => typeof t === "string" && HASH.test(t))
    || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data) || log.data.length > 131_074) throw new Error("Invalid launch event.");
  const { args } = decodeEventLog({ abi: LAUNCH_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
  if (args.token.toLowerCase() !== token.toLowerCase()) return null;
  if (BigInt(args.creator) === 0n || BigInt(args.pool) === 0n) throw new Error("Invalid launch addresses.");
  return { creator: args.creator.toLowerCase(), pool: args.pool.toLowerCase() };
}

export function verifyLaunchReceipt(network: RadarNetwork, token: string, transactionHash: string, raw: unknown, canonical: LaunchBlock): LaunchEvidence | null {
  const receipt = raw as any;
  if (!ADDRESS.test(token) || BigInt(token) === 0n || !HASH.test(transactionHash)
    || !receipt || receipt.status !== "0x1" || !HASH.test(receipt.transactionHash)
    || receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
    || !HASH.test(receipt.blockHash) || receipt.blockHash.toLowerCase() !== canonical.hash.toLowerCase()
    || quantity(receipt.blockNumber) !== canonical.number || !Array.isArray(receipt.logs) || receipt.logs.length > 2000) throw new Error("Invalid launch receipt.");
  const proofs: LaunchEvidence[] = [];
  for (const platform of LAUNCH_PLATFORMS.filter(p => p.chainId === network.chainId)) {
    for (const log of receipt.logs) {
      const event = launchEvent(log, platform, token);
      if (!event) continue;
      if (canonical.number < platform.deploymentBlock || !logInReceipt(log, receipt)) throw new Error("Launch record mismatch.");
      // ArcPad creates a canonical V3 pool in the same transaction. Require the
      // factory's independent event too, including when viewing a later V4 pool.
      const source = network.sources.find(s => s.protocol === "uniswap-v3");
      if (!source) throw new Error("Launch DEX is not configured.");
      const items = receipt.logs.filter((entry: any) => entry?.address?.toLowerCase() === source.factoryAddress.toLowerCase())
        .map((entry: any) => {
          if (!logInReceipt(entry, receipt)) throw new Error("Launch pool record mismatch.");
          return { address: { hash: entry.address }, topics: entry.topics, data: entry.data,
            transaction_hash: transactionHash, block_number: canonical.number, index: quantity(entry.logIndex),
            block_timestamp: new Date(canonical.timestamp).toISOString() };
        });
      const pools = createV3Adapter(source, network).pairSeeds({ items });
      if (!pools.some(pool => pool.tokenAddress.toLowerCase() === token.toLowerCase() && pool.pairAddress.toLowerCase() === event.pool)) throw new Error("Launch pool not confirmed.");
      proofs.push({ platform, token: token.toLowerCase(), ...event, transactionHash: transactionHash.toLowerCase(),
        blockNumber: canonical.number, blockHash: canonical.hash.toLowerCase(), logIndex: quantity(log.logIndex) });
    }
  }
  if (proofs.length > 1) throw new Error("Conflicting launch records.");
  return proofs[0] ?? null;
}

export class LaunchOriginReader {
  private cache = new Map<string, { result: LaunchOrigin; creationTx: string; expires: number }>();
  private flights = new Map<string, Promise<LaunchOrigin>>();
  constructor(private network: RadarNetwork, private transport: Transport, private now = Date.now) {}
  peek(token: string): LaunchOrigin | undefined {
    const entry = this.cache.get(token.toLowerCase());
    return entry && entry.expires > this.now() ? entry.result : undefined;
  }
  async read(pool: RadarPool): Promise<LaunchOrigin> {
    const key = pool.tokenAddress.toLowerCase();
    if (pool.chainId !== this.network.chainId || !ADDRESS.test(key) || BigInt(key) === 0n) throw new Error("Invalid launch lookup.");
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()
      && (cached.result.status === "verified" || cached.creationTx === pool.creationTx)) return cached.result;
    const flight = this.flights.get(key); if (flight) return flight;
    const pending = this.lookup(pool).catch((): LaunchOrigin => ({ status: "unavailable", checkedAt: this.now() })).then(result => {
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { result, creationTx: pool.creationTx,
        expires: this.now() + (result.status === "verified" ? 3_600_000 : result.status === "unavailable" ? 30_000 : 300_000) });
      return result;
    });
    this.flights.set(key, pending);
    try { return await pending; } finally { this.flights.delete(key); }
  }
  private async lookup(pool: RadarPool): Promise<LaunchOrigin> {
    const platforms = LAUNCH_PLATFORMS.filter(p => p.chainId === this.network.chainId);
    if (!platforms.length) return { status: "unsupported", checkedAt: this.now() };
    const signal = AbortSignal.timeout(30_000), head = await this.transport.head();
    const prove = async (hash: string): Promise<LaunchEvidence | null> => {
      const receipt = await this.transport.receipt(hash, signal) as any;
      if (!receipt || quantity(receipt.blockNumber) > head.number) throw new Error("Unmined launch receipt.");
      const canonical = await this.transport.block(quantity(receipt.blockNumber), signal);
      if (canonical.timestamp > head.timestamp) throw new Error("Launch block mismatch.");
      return verifyLaunchReceipt(this.network, pool.tokenAddress, hash, receipt, canonical);
    };
    if (HASH.test(pool.creationTx)) {
      const evidence = await prove(pool.creationTx);
      if (evidence) return { status: "verified", evidence, checkedAt: this.now() };
    }
    const from = Math.max(0, head.number - LAUNCH_LOOKBACK_BLOCKS + 1);
    for (const platform of platforms) {
      if (head.number < platform.deploymentBlock) continue;
      const raw = await this.transport.logs({ address: platform.emitter,
        topics: [LAUNCH_TOPIC, `0x${pool.tokenAddress.slice(2).toLowerCase().padStart(64, "0")}`],
        fromBlock: hex(Math.max(from, platform.deploymentBlock)), toBlock: hex(head.number) }, signal);
      if (!Array.isArray(raw) || raw.length > 1) throw new Error("Invalid launch search results.");
      for (const log of raw) {
        if (!launchEvent(log, platform, pool.tokenAddress) || log.removed !== false
          || !HASH.test(log.transactionHash) || !HASH.test(log.blockHash)
          || quantity(log.blockNumber) < Math.max(from, platform.deploymentBlock) || quantity(log.blockNumber) > head.number) throw new Error("Invalid launch search scope.");
        const evidence = await prove(log.transactionHash);
        if (!evidence || evidence.blockHash !== log.blockHash.toLowerCase() || evidence.blockNumber !== quantity(log.blockNumber)
          || evidence.logIndex !== quantity(log.logIndex)) throw new Error("Launch search / receipt mismatch.");
        return { status: "verified", evidence, checkedAt: this.now() };
      }
    }
    return { status: "unknown", fromBlock: from, toBlock: head.number, checkedAt: this.now() };
  }
}
