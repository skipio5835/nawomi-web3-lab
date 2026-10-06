import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMarketFeed, MarketFeedStore, collectionFailureReason, validateMarketFeedRequest } from "../scripts/radar-market-feed.js";
import { ARC_RADAR_MAINNET as network } from "../src/arc-radar-networks.js";
import { SNAPSHOT_LIMITS, snapshotIsStale, linkedMarketBundles, type MarketBundle } from "../src/arc-radar-market-snapshot.js";
import type { RadarPool } from "../src/arc-radar-dex.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const pool = (n = 1): RadarPool => ({ chainId: network.chainId, sourceId: network.sources.find(s => s.protocol === "uniswap-v3")!.id,
  quoteAsset: network.quoteAsset, createdAt: "", creationTx: "", pairAddress: address(n), token0: network.quoteAsset.address,
  token1: address(n + 1000), tokenAddress: address(n + 1000), v3: { fee: 3000, tickSpacing: 60 } });
const bundle = (seed = pool(), fetchedAt = Date.now()): MarketBundle => ({ seed, fetchedAt, logs: [],
  token: { address_hash: seed.tokenAddress, decimals: "18", name: "Token", symbol: "TOK", total_supply: "1000000000000000000000", holders_count: null, type: "ERC-20" },
  state: { address: seed.pairAddress, poolId: null, sqrtPriceX96: String(2n ** 96n), blockNumber: 100, blockHash: "0x" + "a".repeat(64), timestamp: new Date(fetchedAt).toISOString() } });

test("market snapshots survive restarts and reject changed chain configuration", () => {
  const file = join(mkdtempSync(join(tmpdir(), "arcrow-feed-")), "markets.sqlite");
  let store = new MarketFeedStore(network, file);
  const saved = bundle(pool(), Date.now() - 60_000);
  store.add(saved.seed); store.save(saved); store.close();
  store = new MarketFeedStore(network, file);
  assert.deepEqual(store.snapshot().bundles, [saved]);
  assert.equal(store.snapshot().lastSuccess, saved.fetchedAt);
  store.close();
  assert.throws(() => new MarketFeedStore({ ...network, chainId: 1 }, file), /configuration changed/);
});

test("direct pool and token links reuse only matching saved snapshots without changing timestamps", () => {
  const store = new MarketFeedStore(network, ":memory:");
  try {
    const one = bundle(pool(1), Date.now() - 500_000), two = bundle(pool(2));
    store.add(one.seed); store.save(one); store.add(two.seed); store.save(two);
    const feed = store.snapshot();
    assert.deepEqual(linkedMarketBundles(feed, { pool: one.seed.pairAddress.toUpperCase(), token: null }), [one]);
    assert.deepEqual(linkedMarketBundles(feed, { pool: null, token: two.seed.tokenAddress }), [two]);
    assert.deepEqual(linkedMarketBundles(feed, { pool: null, token: null }), []);
    assert.deepEqual(linkedMarketBundles(feed, { pool: address(999), token: null }), []);
    assert.equal(snapshotIsStale(linkedMarketBundles(feed, { pool: one.seed.pairAddress, token: null })[0]!.fetchedAt), true);
    const v4 = { ...one, seed: { ...one.seed, v3: undefined, v4: { poolId: "0x" + "a".repeat(64), fee: 3000, tickSpacing: 60, hooks: address(0) } } };
    feed.bundles = [v4 as MarketBundle];
    assert.equal(linkedMarketBundles(feed, { pool: one.seed.pairAddress, token: null }).length, 0);
    assert.equal(linkedMarketBundles(feed, { pool: `v4:${one.seed.pairAddress}:0x${"a".repeat(64)}`, token: null }).length, 1);
  } finally { store.close(); }
});

test("reading a snapshot is independent of RPC and collection cannot overlap", async () => {
  const store = new MarketFeedStore(network, ":memory:");
  store.add(pool()); store.save(bundle());
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const feed = new LocalMarketFeed(store, { read: async path => { calls++; await gate; if (path.startsWith("/tokens/")) return bundle().token;
    if (path.startsWith("/pools/")) return bundle().state; return { items: [] }; }, resolveV3Pool: async () => pool(), findV3Pools: async () => [pool()] });
  try {
    const cycle = feed.cycle(); const atStart = calls;
    for (let i = 0; i < 30; i++) assert.equal(feed.snapshot().bundles.length, 1);
    await feed.cycle(); assert.equal(calls, atStart);
    release(); await cycle;
    assert.equal(feed.snapshot().collecting, false);
  } finally { release(); store.close(); }
});

test("upstream failures retain the complete last-good quote, trades and original timestamp", async () => {
  const store = new MarketFeedStore(network, ":memory:");
  const saved = bundle(pool(), Date.now() - 500_000); store.add(saved.seed); store.save(saved);
  const fail = async () => { throw new Error("RPC HTTP 429."); };
  const feed = new LocalMarketFeed(store, { read: fail, resolveV3Pool: fail, findV3Pools: fail });
  try { await feed.cycle(); assert.equal(feed.snapshot().error, true); assert.deepEqual(feed.snapshot().bundles, [saved]);
    assert.equal(feed.snapshot().lastSuccess, saved.fetchedAt); assert.equal(snapshotIsStale(saved.fetchedAt), true);
    assert.ok(feed.snapshot().collection!.failureCount > 0);
    assert.equal(feed.snapshot().collection!.budgetReached, false);
    assert.ok(feed.snapshot().collection!.failures.every(failure => failure.reason === "rate-limit"));
  } finally { store.close(); }
});

test("collection budget is not an RPC failure and interrupted pools retain their retry priority", async () => {
  const store = new MarketFeedStore(network, ":memory:");
  const saved = bundle(pool(), Date.now() - 500_000); store.add(saved.seed); store.save(saved);
  const deadline = new AbortController();
  let interrupt = true;
  const feed = new LocalMarketFeed(store, { read: async path => {
    if (path.startsWith("/tokens/")) return saved.token;
    if (path.startsWith("/pools/")) {
      if (interrupt) { deadline.abort(); throw new Error("RPC request failed or timed out."); }
      return bundle().state;
    }
    return { items: [] };
  }, resolveV3Pool: async () => pool(), findV3Pools: async () => [] });
  try {
    await feed.cycle(deadline.signal);
    assert.equal(feed.snapshot().error, false);
    assert.equal(feed.snapshot().collection!.budgetReached, true);
    assert.equal(feed.snapshot().collection!.failureCount, 0);
    assert.equal(store.rows()[0]!.attempted, 0);
    assert.deepEqual(feed.snapshot().bundles, [saved]);
    interrupt = false; await feed.cycle();
    assert.equal(feed.snapshot().collection!.budgetReached, false);
    assert.equal(feed.snapshot().collection!.updatedPools, 1);
    assert.equal(feed.snapshot().error, false);
  } finally { store.close(); }
});

test("time budget retains queued lookups and transient discovery errors retain cursors", async () => {
  const store = new MarketFeedStore(network, ":memory:");
  const deadline = new AbortController();
  for (const source of network.sources) store.set(`cursor:${source.id}`, "/retained-cursor");
  let failDiscovery = true;
  const feed = new LocalMarketFeed(store, { read: async () => {
    if (failDiscovery) throw new Error("RPC request failed or timed out.");
    return { items: [] };
  }, resolveV3Pool: async () => { deadline.abort(); throw deadline.signal.reason; }, findV3Pools: async () => [] });
  try {
    await feed.cycle();
    for (const source of network.sources) assert.equal(store.get(`cursor:${source.id}`), "/retained-cursor");
    assert.equal(feed.snapshot().error, true);
    failDiscovery = false; feed.enqueue("pool", [address(1)]);
    await feed.cycle(deadline.signal);
    assert.equal(feed.snapshot().queued, 1);
    assert.equal(feed.snapshot().collection!.budgetReached, true);
    assert.equal(feed.snapshot().error, false, "recovery clears old failures even when this cycle exhausts its budget");
    assert.ok(JSON.parse(store.get("failure-history")!).length > 0, "recovery preserves diagnostic history");
  } finally { store.close(); }
});

test("a later budget limit cannot erase a genuine earlier failure", async () => {
  const store = new MarketFeedStore(network, ":memory:");
  const deadline = new AbortController(); let reads = 0;
  const feed = new LocalMarketFeed(store, { read: async () => {
    if (++reads === 1) throw new Error("RPC HTTP 503.");
    deadline.abort(); throw new Error("RPC request failed or timed out.");
  }, resolveV3Pool: async () => pool(), findV3Pools: async () => [] });
  try {
    await feed.cycle(deadline.signal);
    assert.equal(feed.snapshot().collection!.budgetReached, true);
    assert.equal(feed.snapshot().error, true);
    assert.equal(feed.snapshot().collection!.failureCount, 1);
    assert.equal(feed.snapshot().collection!.failures[0]!.reason, "upstream-error");
  } finally { store.close(); }
});

test("failure history survives restart, stays bounded and never includes raw provider errors", () => {
  const file = join(mkdtempSync(join(tmpdir(), "arcrow-feed-errors-")), "markets.sqlite");
  let store = new MarketFeedStore(network, file);
  for (let i = 0; i < 45; i++) store.recordCollection({ completedAt: Date.now(), budgetReached: false, failureCount: 1, updatedPools: 0,
    failures: [{ at: Date.now(), stage: "pool", target: address(i + 1), reason: collectionFailureReason(new Error("https://rpc.invalid/?secret=not-for-storage")) }] });
  store.close(); store = new MarketFeedStore(network, file);
  try {
    const raw = store.get("failure-history")!;
    assert.equal(JSON.parse(raw).length, 40);
    assert.doesNotMatch(raw, /https|secret|not-for-storage/);
    assert.equal(store.snapshot().collection!.failures[0]!.reason, "unknown");
    assert.equal(collectionFailureReason(new Error("Invalid RPC log scope.")), "invalid-data");
    assert.equal(collectionFailureReason(new Error("RPC request failed or timed out.")), "request-timeout");
  } finally { store.close(); }
});

test("collector caps stored log history and publishes only complete pool bundles", async () => {
  const store = new MarketFeedStore(network, ":memory:"); store.add(pool());
  let bad = false;
  const feed = new LocalMarketFeed(store, { read: async path => {
    if (path.startsWith("/tokens/")) return { ...bundle().token, decimals: bad ? null : "18" };
    if (path.startsWith("/pools/")) return bundle().state;
    return { items: Array.from({ length: 100 }, () => ({})) };
  }, resolveV3Pool: async () => pool(), findV3Pools: async () => [pool()] });
  try {
    await feed.cycle(); const saved = feed.snapshot().bundles[0]!;
    assert.equal(saved.logs.length, SNAPSHOT_LIMITS.logs);
    bad = true; await feed.cycle(); assert.deepEqual(feed.snapshot().bundles[0], saved);
  } finally { store.close(); }
});

test("lookups are bounded, deduplicated and independently resolved", async () => {
  const store = new MarketFeedStore(network, ":memory:"); const calls: string[] = [];
  const feed = new LocalMarketFeed(store, { read: async () => { throw new Error("offline"); },
    resolveV3Pool: async address => { calls.push(address); return pool(Number(BigInt(address))); }, findV3Pools: async () => [] });
  try {
    assert.throws(() => feed.enqueue("pool", ["https://evil.invalid"]));
    assert.throws(() => feed.enqueue("pool", Array.from({ length: 21 }, () => address(1))));
    feed.enqueue("pool", [address(1), address(1), address(2)]); assert.equal(feed.snapshot().queued, 2);
    await feed.cycle(); assert.deepEqual(calls, [address(1), address(2)]);
    feed.enqueue("pool", [address(1)]); assert.equal(feed.snapshot().queued, 0);
    for (let i = 3; i <= 200; i++) store.add(pool(i));
    assert.equal(store.rows().length, SNAPSHOT_LIMITS.pools);
  } finally { store.close(); }
});

test("local API rejects rebinding, cross-origin writes and ambiguous network/path input", () => {
  const request = { method: "GET", url: "/api/arcrow/markets?network=arc-mainnet", headers: { host: "localhost:4173" } };
  validateMarketFeedRequest(request, 4173);
  validateMarketFeedRequest({ ...request, method: "POST", headers: { ...request.headers, origin: "http://localhost:4173", "content-type": "application/json" } }, 4173);
  for (const bad of [ { ...request, method: "DELETE" }, { ...request, method: "POST" },
    { ...request, headers: { host: "evil.invalid:4173" } }, { ...request, headers: { ...request.headers, origin: "https://evil.invalid" } },
    { ...request, headers: { ...request.headers, "sec-fetch-site": "cross-site" } },
    { ...request, url: request.url + "&network=arc-mainnet" }, { ...request, url: request.url + "&url=https://evil.invalid" },
    { ...request, url: "/api/arcrow/markets?network=arc-testnet" }, { ...request, url: "https://evil.invalid" + request.url }]) {
    assert.throws(() => validateMarketFeedRequest(bad, 4173));
  }
});

test("stale, missing and future timestamps never become fresh by reopening the UI", () => {
  const now = Date.now();
  assert.equal(snapshotIsStale(now - 1, now), false);
  for (const at of [0, NaN, now + 1, now - SNAPSHOT_LIMITS.staleMs - 1]) assert.equal(snapshotIsStale(at, now), true);
});

test("first-screen collection is local-only and token research stays user-initiated", () => {
  const source = readFileSync(new URL("../src/arc-radar.ts", import.meta.url), "utf8");
  assert.match(source, /localRecorderAvailable\(new URL\(location.href\)\)/);
  assert.match(source, /if \(localMarketMode\) return loadLocalMarkets\(\)/);
  const local = source.slice(source.indexOf("async function loadLocalMarkets"), source.indexOf("async function loadMarkets"));
  assert.doesNotMatch(local, /rpcReader\.|loadDetail\(/);
  const html = readFileSync(new URL("../public/arc-radar.html", import.meta.url), "utf8");
  assert.match(html, /<details class="market-context">/);
  assert.match(html, /id="closeMarketDetail"/);
});
