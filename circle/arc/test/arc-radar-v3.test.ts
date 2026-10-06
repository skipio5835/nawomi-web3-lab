import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, parseAbi, type Hex } from "viem";
import { ARC_RADAR_MAINNET as network } from "../src/arc-radar-networks.js";
import { createDexAdapter, type AddressLog, type DexLogPage } from "../src/arc-radar-dex.js";
import { V3_EVENTS } from "../src/arc-radar-v3.js";
import { RpcMarketReader } from "../src/arc-radar-rpc.js";
import { readTokenRoute, readPoolRoute, marketUrl } from "../src/arc-radar-navigation.js";
import { groupTokenPools } from "../src/arc-radar-market-tools.js";
import { decodePoolSqrt, poolStatePrice, v4Slot0Call, V3_SLOT0, type PoolState } from "../src/arc-radar-pool-state.js";

const source = network.sources.find(s => s.protocol === "uniswap-v3")!;
const adapter = createDexAdapter(source, network);
const token = "0x2100000000000000000000000000000000000000", quote = network.quoteAsset.address as Hex;
const pool = "0x7400000000000000000000000000000000000000", actor = "0x9900000000000000000000000000000000000000";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const numberHex = (n: number) => `0x${n.toString(16)}`;
const stamp = new Date(Date.now() - 3000).toISOString();
test("pool-state quotes cover quiet pools with both token orders and explicit decimals", () => {
  const seed = adapter.pairSeeds({ items: [created()] })[0]!;
  const state: PoolState = { address: pool, poolId: null, sqrtPriceX96: String(2n << 96n), blockNumber: 10, blockHash: hash(10), timestamp: stamp };
  assert.equal(poolStatePrice(state, seed, "6"), 4);
  assert.equal(poolStatePrice(state, seed, "18"), 4e12);
  assert.equal(poolStatePrice(state, { ...seed, token0: quote, token1: actor, tokenAddress: actor }, "6"), 0.25);
  const nativePool = { ...seed, token0: `0x${"0".repeat(40)}`, token1: token, quoteAsset: network.nativeQuoteAsset! };
  assert.equal(poolStatePrice(state, nativePool, "18"), 0.25);
  for (const change of [{ address: actor }, { poolId: hash(1) }, { sqrtPriceX96: "0" }, { sqrtPriceX96: "-1" },
    { sqrtPriceX96: String(1n << 160n) }, { blockHash: "bad" }, { blockNumber: -1 }, { timestamp: new Date(Date.now() + 60000).toISOString() }]) {
    assert.equal(poolStatePrice({ ...state, ...change }, seed, "18"), null);
  }
  for (const decimals of [null, "", "256", "-1", "1.5"]) assert.equal(poolStatePrice(state, seed, decimals), null);
});

test("v3 and v4 decode exact slot0 shapes, not reserves or arbitrary storage", () => {
  assert.equal(decodePoolSqrt(encodeAbiParameters(V3_SLOT0[0].outputs, [2n << 96n, 0, 0, 1, 1, 0, true]), false), 2n << 96n);
  const packed = (123n << 208n) | (42n << 160n) | (2n << 96n);
  assert.equal(decodePoolSqrt(`0x${packed.toString(16).padStart(64, "0")}`, true), 2n << 96n);
  assert.equal(decodePoolSqrt(hash(0), true), 0n, "uninitialized pool stays unpriced");
  for (const value of ["0x", hash(1), "0xzz"]) assert.throws(() => decodePoolSqrt(value, false));
  const call = decodeFunctionData({ abi: parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]), data: v4Slot0Call(hash(7)) });
  assert.equal(call.functionName, "extsload"); assert.equal(call.args.length, 1);
  assert.throws(() => v4Slot0Call("bad"));
});

test("RPC slot0 query checks v3 registration, pins the block, and rejects ambiguous scopes", async () => {
  const f = fixture();
  const state = await f.reader.read(`/pools/${pool}/state`) as PoolState;
  assert.equal(state.sqrtPriceX96, String(2n << 96n)); assert.equal(state.blockNumber, 50000);
  assert.equal(f.calls.filter(c => c.method === "eth_call").at(-1).params[1], numberHex(50000));
  assert.equal(f.calls.some(c => c.method === "eth_getLogs"), false);
  for (const path of [`/pools/${pool}/state?pool=bad`, `/pools/${pool}/state?pool=${hash(1)}`, `/pools/${pool}/state?url=evil`,
    `/pools/${pool}/state?pool=${hash(1)}&pool=${hash(2)}`]) await assert.rejects(f.reader.read(path));
  await assert.rejects(fixture(true).reader.read(`/pools/${pool}/state`));
});

test("v4 pool state reads the configured manager's exact slot without using shared reserves", async () => {
  const manager = network.sources.find(s => s.protocol === "uniswap-v4")!.poolManagerAddress!;
  const id = hash(7), reads: any[] = [], timestamp = Math.floor(Date.now() / 1000) - 1;
  let malformed = false;
  const fetcher = (async (_url, options) => {
    const req = JSON.parse(String(options?.body));
    let result: unknown;
    if (req.method === "eth_chainId") result = "0x13b2";
    else if (req.method === "eth_getBlockByNumber") result = { number: "0x64", hash: hash(100), timestamp: numberHex(timestamp) };
    else if (req.method === "eth_getCode") result = "0x6001";
    else if (req.method === "eth_call") {
      if (req.params[0].data === "0x313ce567") result = hash(6);
      else {
        reads.push(req.params); assert.equal(req.params[0].to, manager.toLowerCase());
        assert.equal(req.params[0].data, v4Slot0Call(id)); assert.equal(req.params[1], "0x64");
        result = malformed ? "0x" : `0x${(2n << 96n).toString(16).padStart(64, "0")}`;
      }
    } else assert.fail(`Unexpected ${req.method}`);
    return Response.json({ jsonrpc: "2.0", id: req.id, result });
  }) as typeof fetch;
  const reader = new RpcMarketReader(network, fetcher), path = `/pools/${manager}/state?pool=${id}`;
  const state = await reader.read(path) as PoolState;
  assert.equal(state.sqrtPriceX96, String(2n << 96n)); assert.equal(state.poolId, id); assert.equal(reads.length, 1);
  malformed = true; await assert.rejects(reader.read(path));
});
const base = { transaction_hash: hash(1), block_number: 49999, block_timestamp: stamp, index: 1 };
function created(): AddressLog {
  return { ...base, address: { hash: source.factoryAddress }, topics: encodeEventTopics({ abi: V3_EVENTS, eventName: "PoolCreated", args: { token0: token, token1: quote, fee: 10000 } }) as Hex[],
    data: encodeAbiParameters([{ type: "int24" }, { type: "address" }], [200, pool]) };
}
function swap(amount0 = -1n, amount1 = 2_000_000n): AddressLog {
  return { ...base, address: { hash: pool }, topics: encodeEventTopics({ abi: V3_EVENTS, eventName: "Swap", args: { sender: actor, recipient: actor } }) as Hex[],
    data: encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }], [amount0, amount1, 2n << 96n, 123n, 0]) };
}
test("v3 raw creation, prices and pool-delta buy/sell signs are distinct from v4", () => {
  const seed = adapter.pairSeeds({ items: [created()] })[0]!;
  assert.equal(seed.tokenAddress.toLowerCase(), token); assert.deepEqual(seed.v3, { fee: 10000, tickSpacing: 200 });
  assert.equal(adapter.trade(swap(), seed)?.direction, "buy");
  assert.equal(adapter.trade(swap(), seed)?.usdcValue, 2);
  assert.equal(adapter.trade(swap(1n, -3_000_000n), seed)?.direction, "sell");
  assert.equal(adapter.trade(swap(1n, 3n), seed), null);
  assert.equal(adapter.pricePoint(swap(), seed, "6")?.price, 4);
  assert.equal(adapter.pricePoint(swap(), seed, "18")?.price, 4e12);
  const reversed = { ...seed, token0: quote, token1: actor, tokenAddress: actor };
  assert.equal(adapter.trade(swap(2_000_000n, -1n), reversed)?.direction, "buy");
  assert.equal(adapter.pricePoint(swap(), reversed, "6")?.price, 0.25);
  assert.equal(adapter.latestReserves([swap()], seed, "18"), null);
  assert.deepEqual(adapter.liquidityEvents([swap()], seed, "18"), []);
  assert.equal(adapter.trade(swap(), seed)?.fallbackAddress, null, "router sender is not trader identity");
});
test("v3 rejects wrong factory, malformed ABI and cross-pool/chain events", () => {
  assert.equal(adapter.pairSeeds({ items: [{ ...created(), address: { hash: actor } }] }).length, 0);
  const seed = adapter.pairSeeds({ items: [created()] })[0]!;
  for (const log of [{ ...swap(), data: "0x" }, { ...swap(), topics: [...swap().topics!, hash(9)] }, { ...swap(), index: -1 }, { ...swap(), transaction_hash: "bad" }]) {
    assert.equal(adapter.trade(log, seed), null); assert.equal(adapter.historyIncomplete!([log]), true);
  }
  assert.equal(adapter.trade({ ...swap(), address: { hash: actor } }, seed), null);
  assert.throws(() => adapter.trade(swap(), { ...seed, chainId: 5042002 }));
  assert.throws(() => adapter.trade(swap(), { ...seed, sourceId: "another" }));
});
function fixture(forged = false) {
  const calls: any[] = [], now = Math.floor(Date.now() / 1000) - 1;
  const fetcher = (async (_url, options) => {
    const req = JSON.parse(String(options?.body)); calls.push(req);
    let result: unknown;
    if (req.method === "eth_chainId") result = "0x13b2";
    else if (req.method === "eth_getBlockByNumber") {
      const n = req.params[0] === "latest" ? 50000 : Number(BigInt(req.params[0]));
      result = { number: numberHex(n), hash: hash(n), timestamp: numberHex(now - (50000 - n)) };
    } else if (req.method === "eth_getCode") result = "0x6001";
    else if (req.method === "eth_call") {
      const data = req.params[0].data;
      const addresses: Record<string, string> = { "0xc45a0155": source.factoryAddress, "0x0dfe1681": token, "0xd21220a7": quote };
      if (addresses[data]) result = encodeAbiParameters([{ type: "address" }], [addresses[data] as Hex]);
      else if (data === "0x313ce567") result = hash(6);
      else if (data === "0xddca3f43") result = hash(10000);
      else if (data === "0xd0c93a7c") result = hash(200);
      else if (data === "0x3850c7bd") result = encodeAbiParameters(V3_SLOT0[0].outputs, [2n << 96n, 0, 0, 1, 1, 0, true]);
      else {
        assert.equal(req.params[0].to.toLowerCase(), source.factoryAddress.toLowerCase());
        const decoded = decodeFunctionData({ abi: parseAbi(["function getPool(address,address,uint24) view returns (address)"]), data });
        result = encodeAbiParameters([{ type: "address" }], [decoded.args[2] === 10000 && !forged ? pool : `0x${"0".repeat(40)}`]);
      }
    } else if (req.method === "eth_getLogs") {
      const event = req.params[0].address.toLowerCase() === source.factoryAddress.toLowerCase() ? created() : swap();
      result = [{ address: event.address!.hash, topics: event.topics, data: event.data, blockNumber: numberHex(49999),
        blockHash: hash(49999), transactionHash: hash(1), logIndex: "0x1", removed: false }];
    } else throw new Error(`Unexpected method ${req.method}`);
    return Response.json({ jsonrpc: "2.0", id: req.id, result });
  }) as typeof fetch;
  return { reader: new RpcMarketReader(network, fetcher), calls };
}
test("RPC discovers v3 pools and verifies older pools through official getPool, preserving unknown creation", async () => {
  const { reader, calls } = fixture();
  const pools = await reader.findV3Pools(token);
  assert.equal(pools.length, 1); assert.equal(pools[0]!.pairAddress, pool);
  assert.equal(pools[0]!.createdAt, ""); assert.equal(pools[0]!.creationTx, "");
  const discovery = await reader.read(adapter.discoveryPath) as DexLogPage;
  assert.equal(adapter.pairSeeds(discovery).length, 1);
  const events = await reader.read(`/addresses/${pool}/logs`) as DexLogPage & { partial: boolean };
  assert.equal(events.partial, true); assert.equal(adapter.trade(events.items![0]!, pools[0]!)?.direction, "buy");
  const filter = calls.filter(c => c.method === "eth_getLogs").at(-1).params[0];
  assert.equal(filter.address, pool); assert.equal(filter.topics[0].length, 2);
  assert.ok(calls.every(c => !/sign|send|wallet/.test(c.method)));
  await assert.rejects(reader.read(`/addresses/${pool}/logs?pool=${hash(1)}`), /scope/);
});

test("validated live factory creation reuses pool identity without six redundant eth_call reads", async () => {
  const { reader, calls } = fixture();
  await reader.read(adapter.discoveryPath);
  const callCount = calls.filter(call => call.method === "eth_call").length;
  const discovered = await reader.resolveV3Pool(pool);
  assert.ok(discovered.createdAt); assert.equal(discovered.creationTx, hash(1));
  await reader.read(`/addresses/${pool}/logs`);
  assert.equal(calls.filter(call => call.method === "eth_call").length, callCount);
});
test("self-reported factory cannot bypass canonical registration", async () => {
  const { reader, calls } = fixture(true);
  await assert.rejects(reader.resolveV3Pool(pool), /verified USDC/);
  assert.equal(calls.some(c => c.method === "eth_getLogs"), false);
});
test("address routes reject ambiguity and pool links stay shareable", () => {
  assert.equal(readTokenRoute(new URL(`https://local.test/?network=arc-mainnet&token=${token}`)), token);
  for (const query of [`token=${token}&token=${token}`, "token=LONG", `token=${token}&pool=${pool}`, `token=0x${"0".repeat(40)}`]) assert.throws(() => readTokenRoute(new URL(`https://local.test/?${query}`)));
  assert.equal(readPoolRoute(new URL(marketUrl("https://local.test/?token=" + token, "arc-mainnet", pool))), pool);
});
test("unknown-liquidity representative prefers recent trading over an idle lower address", () => {
  const base = { chainId: 5042, tokenAddress: token, totalLiquidity: null, stale: false };
  const quiet = { ...base, pairAddress: token, lastTradeAt: null };
  const active = { ...base, pairAddress: pool, lastTradeAt: stamp };
  assert.equal(groupTokenPools([quiet, active])[0]!.primary, active);
});
