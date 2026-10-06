import { decodeAbiParameters, encodeFunctionData, parseAbi, toEventSelector, type Address, type Hex } from "viem";
import { validateRadarNetwork, type RadarNetwork } from "./arc-radar-networks.js";
import { createDexAdapter, type AddressLog, type DexLogPage, type RadarPool } from "./arc-radar-dex.js";
import { createV3Adapter } from "./arc-radar-v3.js";
import { LaunchOriginReader } from "./arc-radar-launch.js";
import { decodePoolSqrt, v4Slot0Call, V3_SLOT0, type PoolState } from "./arc-radar-pool-state.js";

const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const INIT = toEventSelector("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const SWAP = toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const V3_CREATED = toEventSelector("PoolCreated(address,address,uint24,int24,address)");
const V3_INIT = toEventSelector("Initialize(uint160,int24)");
const V3_SWAP = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
const GET_POOL = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
export const V3_LOOKUP_FEES = [100, 500, 3000, 10000] as const;
export const RPC_MARKET_LIMITS = { discoveryBlocks: 50, tradeBlocks: 1000, lookbackBlocks: 20_000, logs: 160, timestampBlocks: 12 } as const;
type Block = { number: number; hash: string; timestamp: number };
type Method = "eth_chainId" | "eth_getBlockByNumber" | "eth_getCode" | "eth_getLogs" | "eth_call" | "eth_getTransactionByHash" | "eth_getTransactionReceipt";
class RangeError extends Error {}
function natural(value: unknown): number {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("Invalid RPC quantity.");
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid RPC quantity.");
  return n;
}
function block(value: any): Block {
  if (!value || !HASH.test(value.hash)) throw new Error("Invalid RPC block.");
  const parsed = { number: natural(value.number), hash: value.hash.toLowerCase(), timestamp: natural(value.timestamp) * 1000 };
  if (!Number.isSafeInteger(parsed.timestamp) || parsed.timestamp > Date.now() + 30_000) throw new Error("Invalid RPC block time.");
  return parsed;
}
const hex = (n: number) => `0x${n.toString(16)}`;

// A bounded, read-only adapter for the existing market reader. Unsupported index
// queries fail rather than fabricate empty holder lists or verified contracts.
export class RpcMarketReader {
  private id = 0;
  private head?: Promise<Block>;
  private checkedAt = 0;
  private blocks = new Map<string, Promise<Block>>();
  private v3Pools = new Map<string, RadarPool>();
  private active = 0;
  private nextRequestAt = 0;
  private waiting: Array<() => void> = [];
  readonly launches: LaunchOriginReader;
  constructor(readonly network: RadarNetwork, private fetcher: typeof fetch = fetch) {
    validateRadarNetwork(network);
    if (network.dataMode !== "rpc-dex") throw new Error("RPC market mode is not configured.");
    this.launches = new LaunchOriginReader(network, {
      head: () => this.checkNetwork(), block: (number, signal) => this.readBlock(number, signal),
      receipt: (hash, signal) => this.rpc("eth_getTransactionReceipt", [hash], signal),
      logs: (filter, signal) => this.rpc("eth_getLogs", [filter], signal),
    });
  }
  private async rpc(method: Method, params: unknown[], signal?: AbortSignal): Promise<any> {
    if (this.active >= 6) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      signal?.throwIfAborted();
      // Pace the public endpoint as well as bounding concurrency. Multiple pool
      // metadata and block reads otherwise arrive as one large burst.
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      this.nextRequestAt = Date.now() + wait + 350;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      signal?.throwIfAborted();
      const id = ++this.id;
      const response = await this.fetcher.call(globalThis, this.network.rpcUrl, {
        method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        if (response.status === 429) this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + 15_000);
        throw new Error(`RPC HTTP ${response.status}.`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing RPC response.");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > 2_000_000) throw new Error("RPC response too large.");
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data?.jsonrpc !== "2.0" || data.id !== id) throw new Error("Invalid RPC response identity.");
      if (data.error) {
        if (method === "eth_getLogs" && [-32602, -32005].includes(data.error.code)
          && /range|max results|too many/i.test(String(data.error.message))) throw new RangeError("RPC log range limit.");
        throw new Error("RPC read failed.");
      }
      if (data.result === undefined) throw new Error("Missing RPC result.");
      return data.result;
    } catch (error) {
      if (error instanceof RangeError) throw error;
      // Do not expose transport internals or third-party error text to the UI.
      throw new Error(error instanceof Error && /^(RPC |Invalid RPC|Missing RPC)/.test(error.message) ? error.message : "RPC request failed or timed out.");
    } finally {
      const next = this.waiting.shift(); if (next) next(); else this.active--;
    }
  }
  checkNetwork(force = false): Promise<Block> {
    if (!force && this.head && Date.now() - this.checkedAt < 30_000) return this.head;
    this.checkedAt = Date.now();
    const request = (async () => {
      if (natural(await this.rpc("eth_chainId", [])) !== this.network.chainId) throw new Error("RPC chain ID mismatch.");
      const head = block(await this.rpc("eth_getBlockByNumber", ["latest", false]));
      if (Date.now() - head.timestamp > 120_000) throw new Error("RPC latest block is stale.");
      const tag = hex(head.number);
      const decimals = await this.rpc("eth_call", [{ to: this.network.quoteAsset.address, data: "0x313ce567" }, tag]);
      if (!HASH.test(decimals) || BigInt(decimals) !== 6n) throw new Error("RPC USDC decimals mismatch.");
      for (const source of this.network.sources) {
        const code = await this.rpc("eth_getCode", [source.factoryAddress, tag]);
        if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || /^0x0+$/i.test(code)) throw new Error("RPC DEX code missing.");
      }
      return head;
    })();
    this.head = request;
    void request.catch(() => { if (this.head === request) this.head = undefined; });
    return request;
  }
  private readBlock(number: number, signal?: AbortSignal): Promise<Block> {
    const key = hex(number);
    const cached = this.blocks.get(key); if (cached) return cached;
    const pending = this.rpc("eth_getBlockByNumber", [key, false], signal).then(value => {
      const parsed = block(value); if (parsed.number !== number) throw new Error("Invalid RPC block number.");
      return parsed;
    });
    if (this.blocks.size >= 512) this.blocks.delete(this.blocks.keys().next().value!);
    this.blocks.set(key, pending);
    void pending.catch(() => { if (this.blocks.get(key) === pending) this.blocks.delete(key); });
    return pending;
  }
  private async poolAt(token0: string, token1: string, fee: number, tag: string, signal?: AbortSignal): Promise<string> {
    const source = this.network.sources.find(s => s.protocol === "uniswap-v3");
    if (!source) throw new Error("v3 is not configured.");
    const data = encodeFunctionData({ abi: GET_POOL, functionName: "getPool", args: [token0 as Address, token1 as Address, fee] });
    const value = await this.rpc("eth_call", [{ to: source.factoryAddress, data }, tag], signal);
    if (typeof value !== "string" || !/^0x0{24}[\da-f]{40}$/i.test(value)) throw new Error("Invalid RPC pool address.");
    return `0x${value.slice(-40)}`.toLowerCase();
  }
  async resolveV3Pool(address: string, signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<RadarPool> {
    if (!ADDRESS.test(address) || BigInt(address) === 0n) throw new Error("Invalid v3 pool address.");
    const key = address.toLowerCase(), cached = this.v3Pools.get(key);
    if (cached) return cached;
    const source = this.network.sources.find(s => s.protocol === "uniswap-v3");
    if (!source) throw new Error("v3 is not configured.");
    const tag = hex((await this.checkNetwork()).number);
    const word = async (data: string) => {
      const value = await this.rpc("eth_call", [{ to: key, data }, tag], signal);
      if (typeof value !== "string" || !HASH.test(value)) throw new Error("Unconfigured RPC emitter.");
      return value as Hex;
    };
    const asAddress = (value: string) => {
      if (!/^0x0{24}[\da-f]{40}$/i.test(value)) throw new Error("Invalid RPC address word.");
      return `0x${value.slice(-40)}`.toLowerCase();
    };
    // Verify factory registration, not just the pool's self-reported factory.
    if (asAddress(await word("0xc45a0155")) !== source.factoryAddress.toLowerCase()) throw new Error("Unconfigured RPC emitter.");
    const token0 = asAddress(await word("0x0dfe1681")), token1 = asAddress(await word("0xd21220a7"));
    const fee = Number(BigInt(await word("0xddca3f43")));
    const tickSpacing = Number(decodeAbiParameters([{ type: "int24" }], await word("0xd0c93a7c"))[0]);
    const quote = this.network.quoteAsset.address.toLowerCase();
    if (BigInt(token0) === 0n || BigInt(token0) >= BigInt(token1) || ![token0, token1].includes(quote)
      || !Number.isSafeInteger(fee) || fee < 0 || fee >= 1_000_000 || tickSpacing < 1 || tickSpacing > 32767
      || await this.poolAt(token0, token1, fee, tag, signal) !== key) throw new Error("Not a verified USDC v3 pool.");
    const pool: RadarPool = { sourceId: source.id, chainId: this.network.chainId, quoteAsset: this.network.quoteAsset,
      pairAddress: key, token0, token1, tokenAddress: token0 === quote ? token1 : token0,
      createdAt: "", creationTx: "", v3: { fee, tickSpacing } };
    if (this.v3Pools.size >= 256) this.v3Pools.delete(this.v3Pools.keys().next().value!);
    this.v3Pools.set(key, pool);
    return pool;
  }
  async findV3Pools(token: string, signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<RadarPool[]> {
    if (!ADDRESS.test(token) || BigInt(token) === 0n || token.toLowerCase() === this.network.quoteAsset.address.toLowerCase()) throw new Error("Invalid token address.");
    const tag = hex((await this.checkNetwork()).number), found: RadarPool[] = [];
    for (const fee of V3_LOOKUP_FEES) {
      const address = await this.poolAt(token, this.network.quoteAsset.address, fee, tag, signal);
      if (BigInt(address) !== 0n) found.push(await this.resolveV3Pool(address, signal));
    }
    return found;
  }
  private async logs(manager: string, query: URLSearchParams, signal?: AbortSignal): Promise<DexLogPage & { partial: true }> {
    for (const key of query.keys()) if (!["before", "anchor", "pool"].includes(key) || query.getAll(key).length !== 1) throw new Error("Invalid RPC log cursor.");
    const pool = query.get("pool");
    if (pool !== null && !HASH.test(pool)) throw new Error("Invalid RPC pool ID.");
    const source = this.network.sources.find(s => s.factoryAddress.toLowerCase() === manager.toLowerCase());
    const isV3Pool = !source && this.v3Pools.has(manager.toLowerCase());
    if ((!source && !isV3Pool) || pool && source?.protocol !== "uniswap-v4") throw new Error("Invalid RPC log scope.");
    const head = await this.checkNetwork();
    const cursorNumber = (key: string, fallback: number) => {
      const value = query.get(key); if (value === null) return fallback;
      if (!/^(0|[1-9][0-9]{0,12})$/.test(value)) throw new Error("Invalid RPC log cursor.");
      return Number(value);
    };
    const anchor = cursorNumber("anchor", head.number);
    const to = cursorNumber("before", anchor);
    if (anchor > head.number || anchor < head.number - RPC_MARKET_LIMITS.lookbackBlocks || to > anchor || to < Math.max(0, anchor - RPC_MARKET_LIMITS.lookbackBlocks)) throw new Error("RPC log cursor expired or out of range.");
    let span: number = pool || isV3Pool ? RPC_MARKET_LIMITS.tradeBlocks : source?.protocol === "uniswap-v3" ? 1000 : RPC_MARKET_LIMITS.discoveryBlocks;
    let from = Math.max(0, to - span + 1, anchor - RPC_MARKET_LIMITS.lookbackBlocks);
    const allowed = isV3Pool ? [V3_INIT, V3_SWAP] : source?.protocol === "uniswap-v3" ? [V3_CREATED] : pool ? [INIT, SWAP] : [INIT];
    const topics = pool ? [allowed, pool] : [allowed];
    let raw: any[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await this.rpc("eth_getLogs", [{ address: manager, topics, fromBlock: hex(from), toBlock: hex(to) }], signal);
        if (!Array.isArray(value)) throw new Error("Invalid RPC log response.");
        if (value.length > RPC_MARKET_LIMITS.logs) throw new RangeError();
        // Each distinct block requires a paced timestamp/hash read. Shrink the
        // range before queuing them so busy pools fit the browser deadline.
        if (new Set(value.map(log => log?.blockNumber)).size > RPC_MARKET_LIMITS.timestampBlocks) throw new RangeError();
        raw = value; break;
      } catch (error) {
        if (!(error instanceof RangeError) || from === to || attempt >= 10) throw error;
        span = Math.max(1, Math.floor((to - from + 1) / 2));
        from = to - span + 1;
      }
    }
    const seen = new Set<string>();
    const validated = raw.map(log => {
      if (!log || typeof log.address !== "string" || log.address.toLowerCase() !== manager.toLowerCase()
        || log.removed !== false || !HASH.test(log.blockHash) || !HASH.test(log.transactionHash)
        || !Array.isArray(log.topics) || !log.topics.every((v: unknown) => typeof v === "string" && HASH.test(v))
        || !allowed.includes(log.topics[0]?.toLowerCase())
        || pool && log.topics[1]?.toLowerCase() !== pool.toLowerCase()
        || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)) throw new Error("Invalid RPC log scope.");
      const number = natural(log.blockNumber), index = natural(log.logIndex);
      const key = `${log.transactionHash.toLowerCase()}:${index}`;
      if (number < from || number > to || seen.has(key)) throw new Error("Invalid RPC log range or duplicate.");
      seen.add(key);
      return { log, number, index };
    });
    // Match timestamps and hashes to the actual block, never an estimated block time.
    const items: AddressLog[] = await Promise.all(validated.map(async ({ log, number, index }) => {
      const b = await this.readBlock(number, signal);
      if (b.hash !== log.blockHash.toLowerCase() || b.timestamp > head.timestamp) throw new Error("RPC log / block mismatch.");
      return { address: { hash: manager }, block_number: number, block_timestamp: new Date(b.timestamp).toISOString(),
        index, transaction_hash: log.transactionHash, data: log.data, topics: log.topics };
    }));
    items.sort((a, b) => b.block_number! - a.block_number! || b.index! - a.index!);
    if (source?.protocol === "uniswap-v3") {
      // Only freshly validated factory logs may bypass redundant pool getters.
      // Stored browser pages and arbitrary address lookups still take the verifier.
      for (const discovered of createV3Adapter(source, this.network).pairSeeds({ items })) {
        if (this.v3Pools.size >= 256) this.v3Pools.delete(this.v3Pools.keys().next().value!);
        this.v3Pools.set(discovered.pairAddress.toLowerCase(), discovered);
      }
    }
    return { items, partial: true, next_page_params: from > Math.max(0, anchor - RPC_MARKET_LIMITS.lookbackBlocks)
      ? { before: from - 1, anchor, ...(pool ? { pool } : {}) } : null };
  }
  async read(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(path, "https://arcrow.invalid");
    if (!path.startsWith("/") || url.origin !== "https://arcrow.invalid" || url.hash) throw new Error("Unsupported RPC market query.");
    const creation = /^\/creations\/(0x[0-9a-f]{64})$/i.exec(url.pathname);
    if (creation) {
      if (url.search) throw new Error("Invalid creation scope.");
      const head = await this.checkNetwork();
      const receipt = await this.rpc("eth_getTransactionReceipt", [creation[1]], signal);
      if (!receipt || receipt.transactionHash?.toLowerCase() !== creation[1]!.toLowerCase() || receipt.status !== "0x1"
        || !HASH.test(receipt.blockHash) || !Array.isArray(receipt.logs) || receipt.logs.length > 512) throw new Error("Invalid creation receipt.");
      const number = natural(receipt.blockNumber), b = await this.readBlock(number, signal);
      if (number > head.number || b.timestamp > head.timestamp || b.hash !== receipt.blockHash.toLowerCase()) throw new Error("Creation block mismatch.");
      const pools: RadarPool[] = [];
      for (const source of this.network.sources) {
        const items: AddressLog[] = [];
        const seen = new Set<number>();
        for (const log of receipt.logs.filter((entry: any) => entry.address?.toLowerCase() === source.factoryAddress.toLowerCase())) {
          if (log.topics?.[0]?.toLowerCase() !== (source.protocol === "uniswap-v4" ? INIT : V3_CREATED)) continue;
          const index = natural(log.logIndex);
          if (seen.has(index) || log.removed === true || log.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase()
            || natural(log.blockNumber) !== number || log.blockHash?.toLowerCase() !== b.hash
            || !Array.isArray(log.topics) || !log.topics.every((t: unknown) => typeof t === "string" && HASH.test(t))
            || typeof log.data !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data)) throw new Error("Invalid creation log.");
          seen.add(index);
          items.push({ address: { hash: source.factoryAddress }, topics: log.topics, data: log.data, index,
            block_number: number, block_timestamp: new Date(b.timestamp).toISOString(), transaction_hash: receipt.transactionHash });
        }
        pools.push(...createDexAdapter(source, this.network).pairSeeds({ items }));
      }
      return pools;
    }
    const state = /^\/pools\/(0x[0-9a-f]{40})\/state$/i.exec(url.pathname);
    if (state) {
      const address = state[1]!.toLowerCase(), poolId = url.searchParams.get("pool");
      if ([...url.searchParams.keys()].some(key => key !== "pool") || url.searchParams.getAll("pool").length > 1
        || poolId !== null && !HASH.test(poolId)) throw new Error("Invalid RPC pool state scope.");
      if (poolId !== null) {
        if (!this.network.sources.some(source => source.protocol === "uniswap-v4" && source.poolManagerAddress?.toLowerCase() === address)) throw new Error("Unconfigured RPC pool manager.");
      } else await this.resolveV3Pool(address, signal);
      const head = await this.checkNetwork();
      const data = poolId === null ? encodeFunctionData({ abi: V3_SLOT0, functionName: "slot0" }) : v4Slot0Call(poolId);
      const result = await this.rpc("eth_call", [{ to: address, data }, hex(head.number)], signal);
      return { address, poolId: poolId?.toLowerCase() ?? null, sqrtPriceX96: String(decodePoolSqrt(result, poolId !== null)),
        blockNumber: head.number, blockHash: head.hash, timestamp: new Date(head.timestamp).toISOString() } satisfies PoolState;
    }
    const logs = /^\/addresses\/(0x[0-9a-f]{40})\/logs$/i.exec(url.pathname);
    if (logs) {
      if (!this.network.sources.some(source => source.factoryAddress.toLowerCase() === logs[1]!.toLowerCase())) await this.resolveV3Pool(logs[1]!, signal);
      return this.logs(logs[1]!, url.searchParams, signal);
    }
    const token = /^\/tokens\/(0x[0-9a-f]{40})$/i.exec(url.pathname);
    const tx = /^\/transactions\/(0x[0-9a-f]{64})$/i.exec(url.pathname);
    if ((!token && !tx) || url.search) throw new Error("This data needs a public explorer index.");
    const head = await this.checkNetwork();
    if (tx) {
      const result = await this.rpc("eth_getTransactionByHash", [tx[1]], signal);
      if (!result || result.hash?.toLowerCase() !== tx[1]!.toLowerCase() || !ADDRESS.test(result.from)
        || result.blockNumber === null || natural(result.blockNumber) > head.number) throw new Error("Invalid RPC transaction.");
      return { from: { hash: result.from } };
    }
    const read = async (data: string, type: "uint256" | "string") => {
      try {
        const result = await this.rpc("eth_call", [{ to: token![1], data }, hex(head.number)], signal);
        if (typeof result !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(result) || result.length > 8194) return null;
        return decodeAbiParameters([{ type }], result as Hex)[0];
      } catch { return null; }
    };
    const [decimals, supply, name, symbol] = await Promise.all([
      read("0x313ce567", "uint256"), read("0x18160ddd", "uint256"), read("0x06fdde03", "string"), read("0x95d89b41", "string"),
    ]);
    const text = (value: unknown) => typeof value === "string" && value.length <= 120 ? value.replace(/[\u0000-\u001f\u007f]/g, "") : null;
    return { address_hash: token![1], decimals: typeof decimals === "bigint" && decimals <= 255n ? String(decimals) : null,
      total_supply: typeof supply === "bigint" ? String(supply) : null, name: text(name), symbol: text(symbol), holders_count: null, type: "ERC-20" };
  }
}
