import assert from "node:assert/strict";
import test from "node:test";
import { createDexAdapter, discoverDexPools, selectDexAdapters, type DexLogPage } from "../src/arc-radar-dex.js";
import { ARC_RADAR_TESTNET, radarPoolKey, radarStoragePrefix, resolveRadarNetwork } from "../src/arc-radar-networks.js";
import { marketBriefs } from "../src/arc-radar-evidence.js";
import { poolRef } from "../src/arc-radar-pool-id.js";
import { comparePricePoints } from "../src/arc-radar-v4.js";
import { groupTokenPools } from "../src/arc-radar-market-tools.js";
import { marketUrl, readPoolRoute, resolveLinkedPool } from "../src/arc-radar-navigation.js";
import * as v4 from "./fixtures/arc-radar-v4.js";

test("v4 singleton discovery keeps separate pool IDs and rejects forged events", async () => {
  const adapter = createDexAdapter(v4.source, ARC_RADAR_TESTNET);
  const first = v4.initialize();
  const second = v4.initialize({ fee: 500, index: 2 });
  const seeds = adapter.pairSeeds({ items: [first, second, first, { ...first, address: { hash: v4.token } },
    { ...first, data: "0x" }, { ...first, topics: [...first.topics, first.topics[0]!] },
    { ...first, topics: [first.topics[0]!, second.topics[1]!, ...first.topics.slice(2)] },
    { ...first, index: undefined }, { ...first, block_number: undefined }] });
  assert.equal(seeds.length, 2);
  assert.equal(adapter.historyIncomplete?.([first, second]), false);
  assert.equal(adapter.historyIncomplete?.([{ ...first, data: undefined }]), true);
  assert.equal(adapter.historyIncomplete?.([{ ...first, data: "0x" }]), true);
  assert.equal(adapter.historyIncomplete?.([{ ...first, address: { hash: v4.token } }]), true);
  assert.notEqual(poolRef(seeds[0]!), poolRef(seeds[1]!));
  assert.equal(new Set(seeds.map(pool => pool.pairAddress)).size, 1);
  const found = await discoverDexPools([adapter], 15, async () => ({ data: { items: [first, second] }, stale: false }));
  assert.equal(found.seeds.length, 2);
  assert.equal(groupTokenPools(seeds.map(pool => ({ ...pool, totalLiquidity: null, stale: false })))[0]?.pools.length, 2);
});

test("v4 quote decimals and direction follow signed caller deltas on both sides", () => {
  const adapter = createDexAdapter(v4.source, ARC_RADAR_TESTNET);
  for (const native of [false, true]) {
    const init = native ? v4.initialize({ currency0: ARC_RADAR_TESTNET.nativeQuoteAsset!.address as `0x${string}`, currency1: v4.token }) : v4.initialize();
    const pool = adapter.pairSeeds({ items: [init] })[0]!;
    const amount = native ? 10n ** 18n : 10n ** 6n;
    const buy = v4.swap(pool.v4!.poolId as `0x${string}`, native ? -amount : amount, native ? amount : -amount);
    const sell = v4.swap(pool.v4!.poolId as `0x${string}`, native ? amount : -amount, native ? -amount : amount);
    assert.equal(pool.quoteAsset.decimals, native ? 18 : 6);
    assert.equal(adapter.pricePoint(init, pool, String(pool.quoteAsset.decimals))?.price, 1);
    assert.equal(adapter.pricePoint(init, pool, native ? "6" : "18")?.price, native ? 1e-12 : 1e12);
    assert.equal(adapter.trade(buy, pool)?.direction, "buy");
    assert.equal(adapter.trade(sell, pool)?.direction, "sell");
    assert.equal(adapter.trade(buy, pool)?.usdcValue, 1);
    assert.equal(adapter.trade(buy, pool)?.fallbackAddress, null);
    assert.equal(adapter.trade(v4.swap(pool.v4!.poolId as `0x${string}`, 1n, 1n), pool), null);
    assert.equal(adapter.pricePoint(init, pool, null), null);
    assert.equal(adapter.pricePoint(init, pool, "256"), null);
    assert.equal(adapter.latestReserves([buy], pool, "18"), null);
    assert.deepEqual(adapter.liquidityEvents([buy], pool, "18"), []);
    assert.throws(() => adapter.trade(buy, { ...pool, chainId: 1 }));
    assert.throws(() => adapter.trade(buy, { ...pool, quoteAsset: { ...pool.quoteAsset, decimals: 7 } }));
  }
  const nativeToErc20 = v4.initialize({ currency0: ARC_RADAR_TESTNET.nativeQuoteAsset!.address as `0x${string}` });
  assert.equal(adapter.pairSeeds({ items: [nativeToErc20] }).length, 0);
});

test("v4 filters other pools, preserves intra-block price order and verifies shared links", async () => {
  const adapter = createDexAdapter(v4.source, ARC_RADAR_TESTNET);
  const init = v4.initialize();
  const other = v4.initialize({ fee: 500 });
  const [pool, peer] = adapter.pairSeeds({ items: [init, other] });
  const id = pool!.v4!.poolId as `0x${string}`;
  const early = v4.swap(id, 1n, -1n, 1n << 96n, 2);
  const late = v4.swap(id, 1n, -1n, 2n << 96n, 3);
  const points = [late, early].map(log => adapter.pricePoint(log, pool!, "6")!).sort(comparePricePoints);
  assert.deepEqual(points.map(point => point.price), [1, 4]);
  assert.equal(adapter.trade(late, peer!), null);
  assert.equal(adapter.pricePoint(late, peer!, "6"), null);
  const url = marketUrl("http://localhost/arc-radar.html?ads=preview", "arc-testnet", poolRef(pool!));
  assert.equal(readPoolRoute(new URL(url)), poolRef(pool!));
  const resolved = await resolveLinkedPool(poolRef(pool!), [adapter], async () => { throw new Error("No manager creation lookup"); }, async () => ({ items: [init, other] }));
  assert.equal(poolRef(resolved), poolRef(pool!));
  let reads = 0;
  await assert.rejects(resolveLinkedPool(poolRef(pool!), [adapter], async () => ({}), async () => {
    reads++; return { items: [], next_page_params: { page: reads } };
  }), /index window/);
  assert.equal(reads, 10);
  await assert.rejects(resolveLinkedPool(poolRef(pool!), [], async () => ({}), async () => ({})), /not configured/);
  assert.ok(ARC_RADAR_TESTNET.sources.every(source => source.protocol === "uniswap-v2"));
});

const token = "0x1000000000000000000000000000000000000000";
const quote = ARC_RADAR_TESTNET.quoteAsset.address;
const poolA = "0x2000000000000000000000000000000000000000";
const poolB = "0x3000000000000000000000000000000000000000";
const source = ARC_RADAR_TESTNET.sources[0]!;
const adapter = createDexAdapter(source, ARC_RADAR_TESTNET);

function event(method: string, values: Record<string, string>, timestamp = "2026-09-08T00:00:00Z", index = 1) {
  return { block_timestamp: timestamp, index, transaction_hash: "0xabc", decoded: { method_call: `${method}(...)`, parameters: Object.entries(values).map(([name, value]) => ({ name, value })) } };
}
function poolLog(pair = poolA, token0 = token, token1 = quote, timestamp = "2026-09-08T00:00:00Z") {
  return event("PairCreated", { pair, token0, token1 }, timestamp);
}

test("network selection is explicit and an unconfigured network cannot fall back to testnet", () => {
  assert.equal(resolveRadarNetwork().chainId, 5042002);
  assert.equal(resolveRadarNetwork("arc-mainnet").chainId, 5042);
  for (const id of ["unknown", "__proto__"]) assert.throws(() => resolveRadarNetwork(id));
  assert.notEqual(radarStoragePrefix(ARC_RADAR_TESTNET), radarStoragePrefix({ ...ARC_RADAR_TESTNET, id: "fixture", chainId: 123 }));
  assert.notEqual(radarPoolKey(ARC_RADAR_TESTNET, poolA), radarPoolKey(ARC_RADAR_TESTNET, poolB));
  assert.equal(radarPoolKey(ARC_RADAR_TESTNET, poolA), radarPoolKey(ARC_RADAR_TESTNET, poolA.toUpperCase()));
});

test("v2 discovery rejects unsupported events, malformed addresses and pools without the quote asset", () => {
  const result = adapter.pairSeeds({ items: [
    poolLog(), poolLog(), poolLog("bad"), poolLog(poolB, token, poolA), poolLog(poolB, quote, quote),
    event("Initialize", { pair: poolB, token0: token, token1: quote }),
  ] });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.sourceId, source.id);
  assert.equal(result[0]!.chainId, ARC_RADAR_TESTNET.chainId);
  assert.equal(result[0]!.tokenAddress, token);
  assert.throws(() => createDexAdapter({ ...source, protocol: "uniswap-v4" }, ARC_RADAR_TESTNET), /PoolManager/);
});

test("v2 adapter handles both quote sides, prices, and liquidity events", () => {
  for (const quoteIs0 of [false, true]) {
    const pool = adapter.pairSeeds({ items: [poolLog(poolA, quoteIs0 ? quote : token, quoteIs0 ? token : quote)] })[0]!;
    const sync = event("Sync", { reserve0: quoteIs0 ? "2000000" : "1000000000000000000", reserve1: quoteIs0 ? "1000000000000000000" : "2000000" }, undefined, 2);
    const swap = event("Swap", { amount0In: quoteIs0 ? "1000000" : "0", amount1In: quoteIs0 ? "0" : "1000000", amount0Out: quoteIs0 ? "0" : "100", amount1Out: quoteIs0 ? "100" : "0" });
    assert.equal(adapter.pricePoint(sync, pool, "18")?.price, 2);
    assert.equal(adapter.latestReserves([sync], pool, "18")?.usdcReserve, 2);
    assert.equal(adapter.trade(swap, pool)?.direction, "buy");
    assert.equal(adapter.trade(swap, pool)?.usdcValue, 1);
    const mint = event("Mint", { amount0: quoteIs0 ? "1000000" : "500000000000000000", amount1: quoteIs0 ? "500000000000000000" : "1000000" });
    const liquidity = adapter.liquidityEvents([mint, sync], pool, "18")[0]!;
    assert.equal(liquidity.usdcAmount, 1);
    assert.equal(liquidity.changePercent, 100);
    assert.throws(() => adapter.trade(swap, { ...pool, chainId: 999 }), /does not belong/);
  }
});

test("quote addresses and decimals come from network configuration", () => {
  const fixture = { ...ARC_RADAR_TESTNET, chainId: 123, quoteAsset: { ...ARC_RADAR_TESTNET.quoteAsset, address: poolB, decimals: 18 } };
  const alt = createDexAdapter(source, fixture);
  const pool = alt.pairSeeds({ items: [poolLog(poolA, token, poolB)] })[0]!;
  const sync = event("Sync", { reserve0: "1000000", reserve1: "2000000000000000000" });
  assert.equal(alt.pricePoint(sync, pool, "6")?.price, 2);
  const swap = event("Swap", { amount0In: "0", amount1In: "1000000000000000000", amount0Out: "10", amount1Out: "0" });
  assert.equal(alt.trade(swap, pool)?.usdcValue, 1);
  assert.throws(() => adapter.latestReserves([sync], pool, "6"), /does not belong/);
});

test("multiple sources merge newest pools, deduplicate addresses and apply a global limit", async () => {
  const second = createDexAdapter({ ...source, id: "second", factoryAddress: poolB }, ARC_RADAR_TESTNET);
  const readPage = async (path: string): Promise<{ data: DexLogPage; stale: boolean }> => ({
    data: { items: path === adapter.discoveryPath ? [poolLog(poolA, token, quote, "2026-09-07T00:00:00Z")] : [poolLog(poolB), poolLog(poolA, token, quote, "2026-09-07T00:00:00Z")] },
    stale: path === second.discoveryPath,
  });
  const result = await discoverDexPools([adapter, second], 1, readPage);
  assert.equal(result.seeds[0]!.pairAddress, poolB);
  assert.equal(result.hasMore, true);
  assert.equal(result.stale, true);
  const all = await discoverDexPools([adapter, second], 15, readPage);
  assert.equal(all.seeds.length, 2);
  assert.equal(all.hasMore, false);
  await assert.rejects(discoverDexPools([adapter, adapter], 15, readPage), /Duplicate/);
});

test("a source failure is surfaced instead of returning an apparently complete market list", async () => {
  await assert.rejects(discoverDexPools([adapter], 15, async () => { throw new Error("offline"); }), /offline/);
});

test("combined discovery budgets include older v3 pools without increasing the global limit", async () => {
  const seed = adapter.pairSeeds({ items: [poolLog()] })[0]!;
  const make = (protocol: "uniswap-v3" | "uniswap-v4", count: number, hour: number) => ({
    ...adapter, source: { ...source, id: protocol, protocol }, discoveryPath: `/fixtures/${protocol}`,
    pairSeeds: () => Array.from({ length: count }, (_, i) => ({ ...seed, sourceId: protocol,
      pairAddress: `0x${(hour * 100 + i).toString(16).padStart(40, "0")}`,
      createdAt: new Date(Date.UTC(2026, 8, 16, hour, i)).toISOString() })),
  });
  const v3 = make("uniswap-v3", 5, 1), v4 = make("uniswap-v4", 8, 2);
  const adapters = [v4, v3];
  const read = async () => ({ data: { items: [] }, stale: false });
  const all = await discoverDexPools(adapters, 8, read, true);
  assert.equal(all.seeds.length, 8); assert.equal(all.hasMore, true);
  assert.equal(all.seeds.filter(p => p.sourceId === "uniswap-v3").length, 4);
  assert.equal(all.seeds.filter(p => p.sourceId === "uniswap-v4").length, 4);
  assert.ok(all.seeds.every((p, i) => i === 0 || Date.parse(p.createdAt) <= Date.parse(all.seeds[i - 1]!.createdAt)));
  assert.equal(new Set(all.seeds.map(poolRef)).size, 8);
  const only = await discoverDexPools(selectDexAdapters(adapters, "uniswap-v3"), 8, read);
  assert.equal(only.seeds.length, 5); assert.ok(only.seeds.every(p => p.sourceId === "uniswap-v3"));
  const unbalanced = await discoverDexPools(adapters, 8, read);
  assert.ok(unbalanced.seeds.every(p => p.sourceId === "uniswap-v4"));
  const sparse = await discoverDexPools([v4, make("uniswap-v3", 0, 1)], 8, read, true);
  assert.equal(sparse.seeds.length, 8);
  assert.deepEqual(selectDexAdapters([adapter], "uniswap-v3"), []);
  assert.deepEqual(selectDexAdapters([adapter], "all"), [adapter]);
});

test("liquidity aggregation and briefs retain a removal older than the first twelve events", () => {
  const now = Date.parse("2026-09-11T00:00:00Z");
  const pool = adapter.pairSeeds({ items: [poolLog()] })[0]!;
  const logs = Array.from({ length: 13 }, (_, offset) => {
    const timestamp = new Date(now - (offset + 1) * 60_000).toISOString();
    const hash = `0x${(offset + 1).toString(16).padStart(64, "0")}`;
    return [
      { ...event(offset === 12 ? "Burn" : "Mint", { amount0: "1000000000000000000", amount1: "1000000" }, timestamp, 2), transaction_hash: hash },
      { ...event("Sync", { reserve0: "10000000000000000000", reserve1: "9000000" }, timestamp, 1), transaction_hash: hash },
    ];
  }).flat();
  const events = adapter.liquidityEvents(logs, pool, "18");
  assert.equal(events.length, 13);
  assert.equal(events.filter(event => event.direction === "add").reduce((sum, event) => sum + event.usdcAmount, 0), 12);
  assert.equal(events.filter(event => event.direction === "remove").reduce((sum, event) => sum + event.usdcAmount, 0), 1);
  const briefs = marketBriefs([{ ...pool, stale: false, historyTruncated: false, reserveSource: "sync", periods: { h1: { priceChange: null } }, trades: [], liquidityEvents: events }], now);
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0]!.kind, "liquidity");
  assert.equal(briefs[0]!.value, 1);
});
